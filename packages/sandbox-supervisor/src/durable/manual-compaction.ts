import {
  CompactionTask,
  LiveDoc,
  defineDocFamily,
  defineDoc,
  type Conversation,
  type ConversationId,
  type Harness,
  type TaskId,
  type CompactionResult,
  type Storage,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  nativeCompactionState,
  type NativeCompactReceipt,
} from "@pi-cloud/pi-session-postgres/durable";
import { PiTurnError } from "../pi-turn-runtime.ts";

export type CompactReceipt = NativeCompactReceipt;
export const CompactRequestDocument = defineDocFamily<CompactReceipt, CompactReceipt>({
  kind: "pi-cloud.compact-request",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: (receipt) => receipt,
});
/** Lookup only; execution/application state remains in native Task/Submission. */
export const CompactHeadDocument = defineDoc<{ taskId?: number; requestId?: string }>({
  kind: "pi-cloud.compact-head",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

/** Public native admission, equivalent to Conversation.compact plus one atomic
 * request receipt. Pi's exported Task still owns selection, summary and placement. */
export async function admitManualCompaction(
  harness: Harness,
  storage: Storage,
  conversation: Conversation,
  request: Omit<CompactReceipt, "taskId"> & { instructions?: string },
): Promise<CompactReceipt & { replayed: boolean }> {
  const receipt = await conversation.commit(async (tx) => {
    const record = await storage.findDocument(
      {
        kind: CompactRequestDocument.definition.kind,
        scope: { kind: "conversation", conversationId: conversation.id },
        key: request.requestId,
      },
      "current",
      BACKGROUND_CONTEXT,
    );
    const previous = record
      ? ((await storage.document(record.id, "current", BACKGROUND_CONTEXT))?.value as
          CompactReceipt | undefined)
      : undefined;
    if (previous) {
      if (previous.fingerprint !== request.fingerprint)
        throw new PiTurnError(
          "idempotency_conflict",
          "Compaction request identity was used for different instructions",
          false,
        );
      return { ...previous, replayed: true };
    }
    const headRecord = await storage.findDocument(
      {
        kind: CompactHeadDocument.definition.kind,
        scope: { kind: "conversation", conversationId: conversation.id },
      },
      "current",
      BACKGROUND_CONTEXT,
    );
    const head = headRecord
      ? (await storage.document(headRecord.id, "current", BACKGROUND_CONTEXT))?.value
      : undefined;
    if (typeof head?.taskId === "number") {
      const task = await tx.task(head.taskId as TaskId);
      if (!task) throw new Error("Compaction lookup refers to a missing task");
      if (task.state.status !== "terminal")
        throw new PiTurnError(
          "compaction_busy",
          "A manual compaction is already in progress",
          false,
        );
      if (task.state.outcome.status === "completed") {
        const result = task.state.outcome.result as CompactionResult;
        if (
          result.submissionId &&
          (await storage.submission(result.submissionId, BACKGROUND_CONTEXT))?.status === "queued"
        )
          throw new PiTurnError(
            "compaction_busy",
            "A manual compaction is awaiting its native placement",
            false,
          );
      }
    }
    const taskId = await tx.createTask(
      CompactionTask,
      {
        reason: "manual" as const,
        ...(request.instructions ? { instructions: request.instructions } : {}),
      },
      { conversationId: conversation.id, ownership: { kind: "conversation" }, background: false },
    );
    const status = { taskId, reason: "manual" as const, blocking: false, attempt: 1 };
    const live = await tx.doc(LiveDoc, conversation.id);
    live.compactions = [...(live.compactions ?? []), status].sort((a, b) => a.taskId - b.taskId);
    const value: CompactReceipt = {
      requestId: request.requestId,
      fingerprint: request.fingerprint,
      runId: request.runId,
      requestedAt: request.requestedAt,
      taskId,
    };
    await tx.doc(CompactRequestDocument, conversation.id, request.requestId, value);
    Object.assign(await tx.doc(CompactHeadDocument, conversation.id), {
      taskId,
      requestId: request.requestId,
    });
    return { ...value, replayed: false };
  }, BACKGROUND_CONTEXT);
  harness.resume();
  return receipt;
}

export async function manualCompactionState(
  harness: Harness,
  conversationId: number,
  requestId: string,
) {
  const receipt = await harness.snapshot(
    CompactRequestDocument,
    conversationId as ConversationId,
    requestId,
    BACKGROUND_CONTEXT,
  );
  if (!receipt) return undefined;
  const task = await harness.getTask(
    receipt.taskId as TaskId<CompactionResult>,
    BACKGROUND_CONTEXT,
  );
  if (!task) throw new Error("Admitted compaction task is missing");
  const result =
    task.state.status === "terminal" && task.state.outcome.status === "completed"
      ? task.state.outcome.result
      : undefined;
  const submission = result?.submissionId
    ? await harness.submission(result.submissionId, BACKGROUND_CONTEXT)
    : undefined;
  const status = submission ? await submission.status(BACKGROUND_CONTEXT) : undefined;
  return { ...receipt, state: nativeCompactionState(task, status) };
}
