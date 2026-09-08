import type { Database } from "@pi-cloud/database";
import { SESSION_TERMINAL_EVENT_OUTBOX_TOPIC, type PiCloudEventBody } from "@pi-cloud/protocol";
import type { Transaction } from "kysely";
import type { AcceptedExecutionSealFact } from "./accepted-fact.ts";

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
    .innerJoin("run_attempts as attempt", "attempt.id", "run.current_attempt_id")
    .innerJoin("run_attempts as writer", "writer.id", "attempt.native_writer_id")
    .innerJoin("sessions as session", "session.id", "run.session_id")
    .select([
      "attempt.id",
      "attempt.fencing_token",
      "attempt.output_seal_id",
      "attempt.native_writer_id",
      "attempt.native_output_drained",
      "writer.native_writer_failed_at",
      "session.pi_session_id",
      "session.next_event_seq",
    ])
    .where("run.tenant_id", "=", input.tenantId)
    .where("run.id", "=", input.runId)
    .where("run.turn_id", "=", input.turnId)
    .where("run.session_id", "=", input.sessionId)
    .forUpdate("attempt")
    .executeTakeFirstOrThrow();
  if (execution.output_seal_id !== null) return;
  const closesWriter =
    !execution.native_output_drained || execution.native_writer_failed_at !== null;
  if (closesWriter)
    await transaction
      .updateTable("run_attempts")
      .set({ native_writer_failed_at: input.now })
      .where("id", "=", execution.native_writer_id)
      .where("native_writer_failed_at", "is", null)
      .execute();
  const fact: AcceptedExecutionSealFact = {
    kind: "execution_seal",
    factId: input.eventId,
    scope: {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      attemptId: execution.id,
      fencingToken: Number(execution.fencing_token ?? 0),
      piSessionId: execution.pi_session_id,
      writerId: execution.native_writer_id,
    },
    agentId: input.agentId,
    closesWriter,
    baseSequence: Number(execution.next_event_seq) - 1,
    terminal: input.body,
    occurredAt: input.now.toISOString(),
  };
  await transaction
    .updateTable("run_attempts")
    .set({ output_seal_id: fact.factId })
    .where("id", "=", execution.id)
    .executeTakeFirstOrThrow();
  await transaction
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
    .executeTakeFirstOrThrow();
}
