import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type { ContextView, Conversation, EntryRecord, TaskId } from "@earendil-works/pi-durable";
import { isHostedToolBlock } from "../provider-hosted-transcript.ts";
import { providerTextPhase } from "./provider-response.ts";

export const INTERRUPTED_TEXT_ENTRY = "pi-cloud.interrupted-text-context";
export const INTERRUPTION_MARKER = "[Reply interrupted]";

/** A context-only representation, never a provider receipt or a new completion.
 * Retain ordinary text and its phase, with fresh deterministic message identities.
 * Provider reasoning, Tool carriers, annotations and replay signatures stay out. */
export function interruptedTextMessage(entry: EntryRecord): AssistantMessage | undefined {
  if (entry.kind !== "pi.assistant" || entry.model?.length !== 1) return;
  const source = entry.model[0];
  if (source?.role !== "assistant" || source.stopReason !== "aborted") return;
  const content: TextContent[] = [];
  for (const block of source.content) {
    if (block.type !== "text" || isHostedToolBlock(block) || !block.text) continue;
    const phase = providerTextPhase(block);
    content.push({
      type: "text",
      text: block.text,
      ...(phase
        ? {
            textSignature: JSON.stringify({
              v: 1,
              id: `msg_pc_interrupted_${entry.id}_${content.length}`,
              phase,
            }),
          }
        : {}),
    });
  }
  if (!content.some((block) => block.text.trim())) return;
  content[content.length - 1]!.text += `\n\n${INTERRUPTION_MARKER}`;
  return {
    role: "assistant",
    api: source.api,
    provider: source.provider,
    model: source.model,
    timestamp: source.timestamp,
    usage: structuredClone(source.usage),
    content,
    stopReason: "stop",
  };
}

/** Apply once on the native transaction line after cancellation, or before a
 * cold Conversation can generate/compact. Inspect only its native active suffix.
 * A pre-existing edit wins, including omissions and edits inherited by a fork. */
export async function preserveInterruptedText(options: {
  conversation: Conversation;
  assertCurrent(): Promise<void>;
  context: Context;
  view?: ContextView;
}): Promise<ContextView> {
  const { conversation, context } = options;
  let view = options.view ?? (await conversation.context(context));
  for (;;) {
    const edited = new Set(
      view.entries.flatMap((entry) => entry.edits?.map((edit) => edit.target) ?? []),
    );
    const lastByTask = new Map<number, EntryRecord>();
    for (const entry of view.entries)
      if (entry.kind === "pi.assistant" && entry.byTaskId !== undefined)
        lastByTask.set(entry.byTaskId, entry);
    const candidates = [...lastByTask.values()].flatMap((entry) => {
      if (edited.has(entry.id)) return [];
      const message = interruptedTextMessage(entry);
      return message ? [{ entry, message }] : [];
    });
    if (!candidates.length) return view;
    await options.assertCurrent();
    const tail = view.entries.reduce((id, entry) => Math.max(id, entry.id), 0);
    let changed = false;
    let stale = false;
    await conversation.commit(async (tx) => {
      const current = await tx.scanEntries({ conversationId: conversation.id }, 1);
      if ((current.items[0]?.id ?? 0) !== tail) {
        stale = true;
        return;
      }
      const eligible: typeof candidates = [];
      for (const candidate of candidates) {
        const { entry } = candidate;
        const task = await tx.task(entry.byTaskId as TaskId);
        if (
          task?.kind !== "pi.generation" ||
          task.conversationId !== entry.conversationId ||
          task.state.status !== "terminal" ||
          task.state.outcome.status !== "aborted"
        )
          continue;
        eligible.push(candidate);
      }
      for (const { entry, message } of eligible) {
        await tx.appendEntry(conversation.id, {
          kind: INTERRUPTED_TEXT_ENTRY,
          edits: [{ target: entry.id, action: "replace", messages: [message] }],
        });
        changed = true;
      }
    }, context);
    if (!stale && !changed) return view;
    view = await conversation.context(context);
    if (!stale) return view;
  }
}
