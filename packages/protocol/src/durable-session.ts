import type { DurableDisplayPreparation } from "./durable-display.ts";
import type { CandidateToolEffect } from "./tool-command.ts";
import type { ControlToolDispatch } from "./control-tool-command.ts";
import type { CandidateToolCancellation } from "./tool-cancellation.ts";

/** PiCloud's private transport envelope. Native SDK objects are opaque JSON at
 * this boundary; public resource/Run schemas do not import the SDK. */
export type DurableSessionCommit = Readonly<{
  seq: number;
  nextId: number;
  writes: readonly Readonly<Record<string, unknown>>[];
}>;
export type DurableRecordOrigin = Readonly<{
  recordId: number;
  sessionId: string;
  runId: string;
  turnId: string;
}>;
export type DurableCommitPublication = Readonly<{
  commit: DurableSessionCommit;
  origins: readonly DurableRecordOrigin[];
  /** Native queue documents changed; a disposable view wake after projection. */
  inputQueueSessions?: readonly string[];
  tools: readonly Readonly<{ taskId: number; command: CandidateToolEffect }>[];
  cancellations: readonly CandidateToolCancellation[];
  display: readonly DurableDisplayPreparation[];
}>;
export interface DurableCommitPublisher {
  publish(publication: DurableCommitPublication): Promise<void>;
}

/** One record-local index. Keep first-match intent semantics and the original
 * write array intact; native batches may update an identity more than once. */
export class DurableCommitIndex {
  readonly #tasks = new Map<number, Readonly<Record<string, unknown>>>();
  readonly #documents = new Map<number, Readonly<Record<string, unknown>>>();
  constructor(readonly commit: DurableSessionCommit) {
    for (const write of commit.writes) {
      if (write.type === "task") {
        const task = write.value as Readonly<Record<string, unknown>>;
        const id = task.id as number;
        if (!this.#tasks.has(id)) this.#tasks.set(id, task);
      } else if (write.type === "document.create") {
        const id = (write.record as { id: number }).id;
        if (!this.#documents.has(id)) this.#documents.set(id, write);
      }
    }
  }
  task(id: number): Readonly<Record<string, unknown>> | undefined {
    return this.#tasks.get(id);
  }
  document(id: number): Readonly<Record<string, unknown>> | undefined {
    return this.#documents.get(id);
  }
}

export function parseDurableSessionCommit(value: unknown): DurableSessionCommit {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native commit");
  const commit = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(commit.seq) ||
    (commit.seq as number) < 1 ||
    typeof commit.nextId !== "number" ||
    !Number.isInteger(commit.nextId) ||
    commit.nextId < 2 ||
    commit.nextId > Number.MAX_SAFE_INTEGER + 1 ||
    !Array.isArray(commit.writes)
  )
    throw new Error("Invalid native commit position");
  for (const item of commit.writes) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      ![
        "conversation",
        "entry",
        "task",
        "submission",
        "document.create",
        "document.change",
        "document.retire",
      ].includes(item.type)
    )
      throw new Error("Invalid native write kind");
    const id = item.value?.id ?? item.record?.id ?? item.id;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid native record identity");
  }
  return value as DurableSessionCommit;
}

/** A physical handoff must use the arguments in the very same durable intent. */
export function durableToolIntent(
  commit: DurableSessionCommit,
  taskId: number,
  index = new DurableCommitIndex(commit),
): {
  callId: string;
  arguments: Record<string, unknown>;
} {
  if (index.commit !== commit) throw new Error("Native intent index belongs to another commit");
  const task = index.task(taskId);
  const state = task?.state as Record<string, unknown> | undefined;
  const checkpoint = state?.checkpoint as Record<string, unknown> | undefined;
  const input = task?.input as Record<string, unknown> | undefined;
  if (
    task?.kind !== "pi.tool" ||
    task.abortRequested ||
    checkpoint?.phase !== "execute" ||
    typeof input?.callId !== "string" ||
    !checkpoint.arguments ||
    typeof checkpoint.arguments !== "object" ||
    Array.isArray(checkpoint.arguments)
  )
    throw new Error("Tool handoff requires its admitted native execution intent");
  return { callId: input.callId, arguments: checkpoint.arguments as Record<string, unknown> };
}

/** Dynamic workflow host calls are task-owned native documents. Their input
 * exists once in the creating commit, rather than another PG command body. */
export function durableControlIntent(
  commit: DurableSessionCommit,
  reference: Pick<
    ControlToolDispatch,
    "taskId" | "sourceDocumentId" | "operationId" | "conversationId" | "toolName"
  >,
  index = new DurableCommitIndex(commit),
): { callId: string; arguments: Record<string, unknown> } {
  if (index.commit !== commit) throw new Error("Native intent index belongs to another commit");
  if (reference.sourceDocumentId === undefined)
    return durableToolIntent(commit, reference.taskId, index);
  const write = index.document(reference.sourceDocumentId);
  const record = write?.record as
    { kind?: string; key?: string; scope?: { kind: string; taskId: number } } | undefined;
  const content = write?.content as { kind?: string; value?: Record<string, unknown> } | undefined;
  const value = content?.value;
  if (
    record?.kind !== "pi-cloud.tool-hostcall" ||
    record.key !== reference.operationId ||
    record.scope?.kind !== "task" ||
    record.scope.taskId !== reference.taskId ||
    content?.kind !== "base" ||
    value?.conversationId !== reference.conversationId ||
    value.toolName !== reference.toolName ||
    typeof value.callId !== "string" ||
    !value.arguments ||
    typeof value.arguments !== "object" ||
    Array.isArray(value.arguments)
  )
    throw new Error("Control Tool requires its committed native hostcall");
  return { callId: value.callId, arguments: value.arguments as Record<string, unknown> };
}
