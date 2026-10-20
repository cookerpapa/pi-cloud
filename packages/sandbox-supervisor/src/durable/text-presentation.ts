import { providerTextPhase } from "./provider-response.ts";
import { isHostedToolBlock } from "../provider-hosted-transcript.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { NativeDocumentChange } from "@pi-cloud/pi-session-postgres/durable";
import type {
  AssistantMessagePhase,
  DurableSessionCommit,
  DurableTextDescription,
  PiCloudEventFactory,
} from "@pi-cloud/protocol";

/** Interpret Pi only at the trusted Runner. Metadata refers to the native
 * commit's entry or resulting document; no assistant body is copied to it. */
export class DurableTextPresentation {
  #canonicalSeq = 0;
  #partial = false;
  canCover(sequence: number): boolean {
    return !this.#partial && sequence >= this.#canonicalSeq;
  }
  #phases = new Map<string, AssistantMessagePhase | undefined>();
  constructor(
    readonly options: {
      conversationId: number;
    },
  ) {}
  prepare(
    commit: DurableSessionCommit,
    documents: readonly NativeDocumentChange[],
    factory: PiCloudEventFactory,
  ) {
    const events: DurableTextDescription[] = [],
      phases = new Map(this.#phases);
    const live = documents.find(
      ({ record }) =>
        record.kind === "pi.live" &&
        record.scope.kind === "conversation" &&
        record.scope.conversationId === this.options.conversationId,
    );
    const before = live?.before?.value as LiveState | undefined,
      after = live?.after?.value as LiveState | undefined;
    const key = (task: number | undefined, attempt: number, index: number) =>
      `live:${this.options.conversationId}:${task}:${attempt}:${index}`;
    const emit = (
      payload: DurableTextDescription["event"]["payload"],
      source: DurableTextDescription["source"],
    ) => {
      const event = factory.next({
        type: "assistant.text.delta",
        payload: { ...payload, text: "" },
      });
      if (event.type !== "assistant.text.delta") throw new Error("Text factory changed event kind");
      const { text: _text, ...metadata } = event.payload;
      events.push({ event: { ...event, payload: metadata }, source });
    };
    let canonical = false;
    // Settle old text before describing a new partial in the same transaction.
    for (const [ordinal, write] of commit.writes.entries()) {
      if (write.type !== "entry") continue;
      const entry = write.value as EntryRecord;
      if (entry.conversationId !== this.options.conversationId) continue;
      if (["pi.assistant", "pi.user", "pi.tool-result"].includes(entry.kind) && entry.model?.length)
        canonical = true;
      if (entry.kind !== "pi.assistant") continue;
      for (const [mi, message] of (entry.model ?? []).entries()) {
        if (message.role !== "assistant") continue;
        const task = entry.byTaskId ?? before?.run?.taskId;
        const prior =
          task === before?.run?.taskId ? (before?.generation?.message?.content ?? []) : [];
        for (let index = 0; index < Math.max(message.content.length, prior.length); index++) {
          const block = message.content[index],
            old = prior[index];
          const messageId =
            task === undefined
              ? `entry:${entry.id}:${index}`
              : key(task, before?.generation?.attempt ?? 1, index);
          if (block?.type !== "text" || isHostedToolBlock(block)) {
            // Final responses may remove or replace a previously visible block.
            // Clear it before coverage retires the live prefix.
            if (old?.type === "text" && old.text.length)
              emit(
                { messageId, settledMessageId: `entry:${entry.id}:${index}`, replace: true },
                { kind: "empty" },
              );
            continue;
          }
          const phase = providerTextPhase(block);
          emit(
            {
              messageId,
              settledMessageId: `entry:${entry.id}:${index}`,
              replace: true,
              ...(phase ? { phase } : {}),
            },
            {
              kind: "write",
              ordinal,
              path: ["value", "model", mi, "content", index, "text"],
              start: 0,
              end: block.text.length,
            },
          );
        }
      }
    }
    const coveredThrough = canonical ? factory.currentSequence() : undefined;
    if (canonical) phases.clear();
    const message = after?.generation?.message as AssistantMessage | undefined;
    if (message && live) {
      const same =
        !canonical &&
        before?.run?.taskId === after?.run?.taskId &&
        before?.generation?.attempt === after?.generation?.attempt;
      const oldMessage = same
        ? (before?.generation?.message as AssistantMessage | undefined)
        : undefined;
      for (
        let index = 0;
        index < Math.max(message.content.length, oldMessage?.content.length ?? 0);
        index++
      ) {
        const block = message.content[index],
          old = oldMessage?.content[index];
        if (isHostedToolBlock(block) || (block?.type !== "text" && old?.type !== "text")) continue;
        const text = block?.type === "text" ? block.text : "",
          previous = old?.type === "text" ? old.text : "";
        const messageId = key(after?.run?.taskId, after?.generation?.attempt ?? 1, index);
        const phase = block?.type === "text" ? providerTextPhase(block) : undefined;
        const oldPhase = phases.has(messageId)
          ? phases.get(messageId)
          : old?.type === "text" && oldMessage
            ? providerTextPhase(old)
            : undefined;
        phases.set(messageId, phase);
        if (text === previous && phase === oldPhase) continue;
        const replace = !text.startsWith(previous);
        const start = replace ? 0 : previous.length;
        emit(
          { messageId, ...(replace ? { replace: true } : {}), ...(phase ? { phase } : {}) },
          text.length === start
            ? { kind: "empty" }
            : {
                kind: "document",
                id: live.record.id,
                path: ["generation", "message", "content", index, "text"],
                start,
                end: text.length,
              },
        );
      }
    } else if (live) phases.clear();
    return {
      events,
      ...(coveredThrough === undefined ? {} : { coveredThrough }),
      confirmed: () => {
        this.#phases = phases;
        if (canonical) this.#canonicalSeq = commit.seq;
        if (live)
          this.#partial = !!message?.content.some(
            (block) => block.type === "text" && block.text.length > 0,
          );
      },
    };
  }
}
