import type { EntryRecord, LiveState, TaskRecord, ToolSlot } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { NativeDocumentChange } from "@pi-cloud/pi-session-postgres/durable";
import type {
  DurableSessionCommit,
  DurableToolStartDescription,
  DurableToolEndDescription,
  PiCloudEventFactory,
  ModelSamplingIdentity,
} from "@pi-cloud/protocol";
type NativeTask = TaskRecord<JsonValue, JsonValue, unknown>;

/** Pi lifecycle interpretation stays in Worker. Every payload selector points
 * into this prepared native batch; no watcher/storage re-entry or body copy. */
export function prepareToolPresentation(
  commit: DurableSessionCommit,
  documents: readonly NativeDocumentChange[],
  factory: PiCloudEventFactory,
  options: { conversationId: number; maximumOutputBytes: number; sampling?: ModelSamplingIdentity },
): (DurableToolStartDescription | DurableToolEndDescription)[] {
  const events: (DurableToolStartDescription | DurableToolEndDescription)[] = [];
  const live = documents.find(
    (d) =>
      d.record.kind === "pi.live" &&
      d.record.scope.kind === "conversation" &&
      d.record.scope.conversationId === options.conversationId,
  );
  const before = live?.before?.value as LiveState | undefined,
    after = live?.after?.value as LiveState | undefined;
  const previous = new Map((before?.tools ?? []).map((slot) => [slot.callId, slot]));
  const current = new Map((after?.tools ?? []).map((slot) => [slot.callId, slot]));
  const tasks = new Map<number, { value: NativeTask; ordinal: number }>();
  const entries = new Map<number, { value: EntryRecord; ordinal: number }>();
  for (const [ordinal, write] of commit.writes.entries()) {
    if (write.type === "task") {
      const task = write.value as NativeTask;
      if (task.conversationId === options.conversationId)
        tasks.set(task.id, { value: task, ordinal });
    } else if (write.type === "entry") {
      const entry = write.value as EntryRecord;
      if (entry.conversationId === options.conversationId && entry.kind === "pi.tool-result")
        entries.set(entry.id, { value: entry, ordinal });
    }
  }
  for (const slot of current.values()) {
    if (slot.status !== "running" || previous.get(slot.callId)?.status === "running") continue;
    const source = slot.taskId === undefined ? undefined : tasks.get(slot.taskId);
    const task = source?.value;
    const checkpoint =
      task && "checkpoint" in task.state
        ? (task.state.checkpoint as { phase?: string; arguments?: unknown })
        : undefined;
    if (
      !source ||
      task?.kind !== "pi.tool" ||
      task.abortRequested ||
      checkpoint?.phase !== "execute" ||
      !checkpoint.arguments ||
      typeof checkpoint.arguments !== "object" ||
      Array.isArray(checkpoint.arguments)
    )
      throw new Error("Tool display start requires its same-commit native execution intent");
    const event = factory.next({
      type: "tool.started",
      payload: {
        toolCallId: `task:${task.id}`,
        toolName: slot.name,
        input: {},
        ...options.sampling,
      },
    });
    if (event.type !== "tool.started") throw new Error("Tool display factory changed event type");
    const { input: _input, ...payload } = event.payload;
    events.push({
      event: { ...event, payload },
      source: {
        kind: "write",
        ordinal: source.ordinal,
        path: ["value", "state", "checkpoint", "arguments"],
      },
    });
  }

  const ended = new Map<string, { slot: ToolSlot; entry?: number }>();
  for (const slot of previous.values()) {
    if (slot.status === "done") continue;
    const next = current.get(slot.callId);
    if (next?.status === "done")
      ended.set(slot.callId, {
        slot: next,
        ...(next.entry === undefined ? {} : { entry: next.entry }),
      });
    else if (!next) {
      const result = [...entries.values()].find((e) =>
        e.value.model?.some((m) => m.role === "toolResult" && m.toolCallId === slot.callId),
      );
      ended.set(slot.callId, { slot, ...(result ? { entry: result.value.id } : {}) });
    }
  }
  for (const slot of current.values())
    if (slot.status === "done" && !previous.has(slot.callId))
      ended.set(slot.callId, { slot, ...(slot.entry === undefined ? {} : { entry: slot.entry }) });

  const resultEntries = new Set<number>();
  const finish = (slot: ToolSlot | undefined, source?: { value: EntryRecord; ordinal: number }) => {
    const modelIndex = source?.value.model?.findIndex((m) => m.role === "toolResult") ?? -1;
    const result = modelIndex < 0 ? undefined : source?.value.model?.[modelIndex];
    if (result && result.role !== "toolResult") throw new Error("Tool result selector changed");
    const owner =
      source?.value.byTaskId === undefined ? undefined : tasks.get(source.value.byTaskId)?.value;
    const taskId = slot?.taskId ?? (owner?.kind === "pi.tool" ? owner.id : undefined);
    if (taskId === undefined && !source)
      throw new Error("Unsettled Tool view has no native identity");
    const event = factory.next({
      type: "tool.completed",
      payload: {
        toolCallId: taskId === undefined ? `entry:${source!.value.id}` : `task:${taskId}`,
        outcome: !result || result.isError ? "failed" : "completed",
        output: "",
        ...options.sampling,
      },
    });
    if (event.type !== "tool.completed") throw new Error("Tool display factory changed event type");
    const { output: _output, ...payload } = event.payload;
    const output: DurableToolEndDescription["output"] =
      result && source
        ? {
            kind: "parts",
            maximumBytes: options.maximumOutputBytes,
            ...(result.details === undefined
              ? {}
              : {
                  details: {
                    kind: "write" as const,
                    ordinal: source.ordinal,
                    path: ["value", "model", modelIndex, "details"],
                  },
                }),
            parts: result.content.map((part, index) =>
              part.type === "text"
                ? {
                    kind: "write" as const,
                    ordinal: source.ordinal,
                    path: ["value", "model", modelIndex, "content", index, "text"],
                    start: 0,
                    end: part.text.length,
                  }
                : {
                    kind: "image" as const,
                    mimeType: part.mimeType,
                    source: {
                      kind: "write" as const,
                      ordinal: source.ordinal,
                      path: ["value", "model", modelIndex, "content", index],
                    },
                  },
            ),
          }
        : { kind: "missing" };
    events.push({ event: { ...event, payload }, output });
    if (source) resultEntries.add(source.value.id);
  };
  for (const end of ended.values())
    finish(end.slot, end.entry === undefined ? undefined : entries.get(end.entry));
  for (const source of entries.values()) {
    if (
      resultEntries.has(source.value.id) ||
      !source.value.model?.some((m) => m.role === "toolResult")
    )
      continue;
    const result = source.value.model.find((m) => m.role === "toolResult")!;
    finish(current.get(result.toolCallId) ?? previous.get(result.toolCallId), source);
  }
  return events;
}
