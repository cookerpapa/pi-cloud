import type { Database } from "@pi-cloud/database";
import { SESSION_TERMINAL_EVENT_OUTBOX_TOPIC, type PiCloudEventBody } from "@pi-cloud/protocol";
import { sql, type Transaction } from "kysely";
import type { AcceptedExecutionSealFact } from "./accepted-fact.ts";

export const TERMINAL_OUTBOX_NOTIFICATION_CHANNEL = "pi_cloud_terminal_outbox";

export type RequestExecutionStreamSealInput = {
  tenantId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  agentId: string;
  body: Extract<PiCloudEventBody, { type: "turn.completed" | "turn.failed" | "turn.cancelled" }>;
  now: Date;
  eventId: string;
};

/** Request closure in the business terminal transaction. Only the ordered Kafka
 * projector may allocate the public terminal sequence or release the next Run. */
export async function requestExecutionStreamSeal(
  transaction: Transaction<Database>,
  input: RequestExecutionStreamSealInput,
): Promise<void> {
  const execution = await transaction
    .selectFrom("runs as run")
    .innerJoin("session_leases as writer", "writer.lease_id", "run.lease_id")
    .innerJoin("sessions as session", "session.id", "run.session_id")
    .select([
      "run.id",
      "run.fencing_token",
      "run.output_seal_id",
      "run.lease_id",
      "run.native_output_drained",
      "writer.writer_failed_at",
      "session.pi_session_id",
      "session.next_event_seq",
    ])
    .where("run.tenant_id", "=", input.tenantId)
    .where("run.id", "=", input.runId)
    .where("run.turn_id", "=", input.turnId)
    .where("run.session_id", "=", input.sessionId)
    .forNoKeyUpdate("run")
    .executeTakeFirstOrThrow();
  if (execution.output_seal_id !== null) return;
  const closesWriter = !execution.native_output_drained || execution.writer_failed_at !== null;
  if (closesWriter)
    await transaction
      .updateTable("session_leases")
      .set({ writer_failed_at: input.now })
      .where("lease_id", "=", execution.lease_id!)
      .where("writer_failed_at", "is", null)
      .execute();
  const fact: AcceptedExecutionSealFact = {
    kind: "execution_seal",
    factId: input.eventId,
    scope: {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      fencingToken: Number(execution.fencing_token ?? 0),
      piSessionId: execution.pi_session_id,
      writerId: execution.lease_id!,
    },
    agentId: input.agentId,
    closesWriter,
    baseSequence: Number(execution.next_event_seq) - 1,
    terminal: input.body,
    occurredAt: input.now.toISOString(),
  };
  await transaction
    .updateTable("runs")
    .set({ output_seal_id: fact.factId })
    .where("id", "=", execution.id)
    .executeTakeFirstOrThrow();
  const queuedSeal = transaction
    .insertInto("outbox")
    .values({
      id: fact.factId,
      tenant_id: input.tenantId,
      aggregate_type: "session_terminal_event",
      aggregate_id: fact.factId,
      topic: SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
      payload: fact,
      attempts: 0,
      available_at: input.now,
      created_at: input.now,
      published_at: null,
      last_error: null,
    })
    .returning("id");
  // Same statement and commit as the durable row; the hint contains no data.
  await transaction
    .with("queued_seal", () => queuedSeal)
    .selectFrom("queued_seal")
    .select(sql`pg_notify(${TERMINAL_OUTBOX_NOTIFICATION_CHANNEL}, '')`.as("notification"))
    .executeTakeFirstOrThrow();
}
