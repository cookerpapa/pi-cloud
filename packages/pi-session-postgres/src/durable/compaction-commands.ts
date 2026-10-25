import type { Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { ConversationCompactResource } from "@pi-cloud/protocol";
import type {
  DocumentRecord,
  TaskRecord,
  CompactionResult,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { DurablePostgresProjection, materializeNativeDocument } from "./postgres-projection.ts";
import { documentAddress, type DurableScope } from "./types.ts";

export type NativeCompactReceipt = {
  requestId: string;
  fingerprint: string;
  runId: string;
  taskId: number;
  requestedAt: string;
};
export type CompactState = ConversationCompactResource["state"];
export function nativeCompactionState(
  task: TaskRecord<JsonValue, JsonValue, CompactionResult>,
  submission?: SubmissionRecord,
): CompactState {
  if (task.kind !== "pi.compaction")
    throw new Error("Compaction receipt refers to another native task kind");
  if (task.state.status !== "terminal") return "summarizing";
  const outcome = task.state.outcome;
  if (outcome.status === "aborted") return "cancelled";
  if (outcome.status !== "completed") return "failed";
  if (outcome.result.entryId) return "applied";
  if (!outcome.result.submissionId) return "no_op";
  if (!submission) throw new Error("Compaction summary write is missing");
  if (submission.status === "queued") return "awaiting_placement";
  if ("entry" in submission) return "applied";
  return submission.status === "unanswered" && submission.reason === "aborted"
    ? "cancelled"
    : "stale";
}
async function document(
  projection: DurablePostgresProjection,
  conversationId: number,
  kind: string,
  through: number,
  key?: string,
) {
  const found = await projection.scan(
    {
      kind: "document",
      at: "current",
      fields: {
        address: documentAddress({
          kind,
          scope: { kind: "conversation", conversationId: conversationId as never },
          ...(key ? { key } : {}),
        }),
      },
    },
    1,
  );
  const record = found[0]?.value as DocumentRecord | undefined;
  return record
    ? materializeNativeDocument(record, await projection.revisions(record.id, through)).value
    : undefined;
}
/** Query metadata and native outcomes; never admits or resumes a task. */
export async function readNativeCompaction(
  database: Kysely<Database>,
  scope: DurableScope & { conversationId: number },
  commandId?: string,
) {
  const projection = new DurablePostgresProjection(database, scope, undefined, "references");
  const head = await projection.head();
  if (!commandId) {
    const latest = await document(
      projection,
      scope.conversationId,
      "pi-cloud.compact-head",
      head.seq,
    );
    if (typeof latest?.requestId !== "string") return undefined;
    commandId = latest.requestId;
  }
  const receipt = (await document(
    projection,
    scope.conversationId,
    "pi-cloud.compact-request",
    head.seq,
    commandId,
  )) as NativeCompactReceipt | undefined;
  if (!receipt) return undefined;
  const record = await projection.get(receipt.taskId);
  if (record?.kind !== "task") throw new Error("Compaction task is missing");
  const task = record.value as TaskRecord<JsonValue, JsonValue, CompactionResult>;
  const result =
    task.state.status === "terminal" && task.state.outcome.status === "completed"
      ? task.state.outcome.result
      : undefined;
  const submission = result?.submissionId ? await projection.get(result.submissionId) : undefined;
  return {
    ...receipt,
    state: nativeCompactionState(
      task,
      submission?.kind === "submission" ? (submission.value as SubmissionRecord) : undefined,
    ),
    nativeSequence: head.seq,
  };
}
