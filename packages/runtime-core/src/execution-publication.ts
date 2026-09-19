import { isDeepStrictEqual } from "node:util";
import type { Database } from "@pi-cloud/database";
import { parseExecutionReference } from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ExecutionPublication } from "./accepted-fact.ts";
import type { ExecutionLogOpenRequest } from "./execution-log.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";

/** Authority is a one-time PG operation. There is no channel lease or token-time SELECT. */
export async function registerExecutionPublication(
  tx: Transaction<Database>,
  request: Omit<ExecutionLogOpenRequest, "publication">,
): Promise<ExecutionPublication> {
  const lease = parseExecutionReference(request.executionReference);
  await tx
    .selectFrom("run_attempts")
    .select("id")
    .where("id", "=", lease.attemptId)
    .forNoKeyUpdate()
    .execute();
  await tx
    .selectFrom("session_leases")
    .select("lease_id")
    .where("lease_id", "=", lease.leaseId)
    .forKeyShare()
    .execute();
  const row = await tx
    .selectFrom("active_execution_scopes as l")
    .select([
      "l.writer_id as native_writer_id",
      "l.tenant_id",
      "l.run_id",
      "l.turn_id",
      "l.session_id",
      "l.lease_id",
      "l.fencing_token",
      "l.pi_session_id",
    ])
    // The authority view already joins the Attempt, Session and native writer.
    // Two scalar PK reads fetch fields absent from that view without expanding
    // its five-table join graph to eight tables on every registration.
    .select((eb) => [
      eb
        .selectFrom("run_attempts as a")
        .select("a.output_publication")
        .whereRef("a.id", "=", "l.attempt_id")
        .as("output_publication"),
      eb
        .selectFrom("sessions as s")
        .select("s.pi_session_lane")
        .whereRef("s.id", "=", "l.session_id")
        .as("pi_session_lane"),
    ])
    .where("l.attempt_id", "=", lease.attemptId)
    .where("l.lease_id", "=", lease.leaseId)
    .where("l.fencing_token", "=", String(lease.fencingToken))
    .where("l.valid_until", ">", sql<Date>`clock_timestamp()`)
    .where("l.accepting_effects", "=", true)
    .executeTakeFirst();
  if (
    !row ||
    row.session_id !== request.sessionId ||
    row.turn_id !== request.turnId ||
    row.pi_session_id !== request.piSession.id ||
    row.pi_session_lane !== request.piSession.lane ||
    row.native_writer_id !== request.piSession.writerId
  )
    throw new Error("Execution publication requires the current Session lease");
  if (row.output_publication !== null)
    throw new Error("An Attempt cannot reopen its publication identity");
  const permit: ExecutionPublication = {
    scope: {
      tenantId: row.tenant_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      runId: row.run_id,
      attemptId: lease.attemptId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      piSessionId: row.pi_session_id,
      piSessionLane: row.pi_session_lane,
      writerId: row.native_writer_id,
    },
  };
  await tx
    .updateTable("run_attempts")
    .set({ output_publication: permit, native_output_drained: false })
    .where("id", "=", lease.attemptId)
    .executeTakeFirstOrThrow();
  return permit;
}

/** Check PG-issued attribution for trusted producers, not cryptographic origin. */
export class ExecutionPublicationBoundary {
  readonly #cache = new Map<
    string,
    { permit: ExecutionPublication; topic: string; partition: number }
  >();
  constructor(readonly database: Kysely<Database>) {}
  reset(): void {
    this.#cache.clear();
  }
  async accept(record: KafkaAcceptedFactRecord): Promise<boolean> {
    const { fact } = record;
    if (fact.kind === "execution_seal") {
      const requested = await this.database
        .selectFrom("outbox")
        .select("payload")
        .where("id", "=", fact.factId)
        .where("tenant_id", "=", fact.scope.tenantId)
        .executeTakeFirst();
      return !!requested && isDeepStrictEqual(requested.payload, fact);
    }
    const id = fact.scope.attemptId;
    let authority = this.#cache.get(id);
    if (!authority) {
      const row = await this.database
        .selectFrom("run_attempts")
        .select(["output_publication", "output_first_topic", "output_first_partition"])
        .where("id", "=", id)
        .where("tenant_id", "=", fact.scope.tenantId)
        .executeTakeFirst();
      if (!row?.output_publication) return false;
      const permit = row.output_publication as unknown as ExecutionPublication;
      authority = {
        permit,
        topic: row.output_first_topic ?? record.topic,
        partition: row.output_first_partition ?? record.partition,
      };
    }
    const { leaseId, piSessionLane, ...scope } = authority.permit.scope;
    const actualScope = fact.kind === "tool_command" ? { ...scope, leaseId } : scope;
    if (
      !isDeepStrictEqual(actualScope, fact.scope) ||
      authority.partition !== record.partition ||
      authority.topic !== record.topic
    )
      return false;
    this.#cache.set(id, authority);
    if (this.#cache.size > 65_536) this.#cache.delete(this.#cache.keys().next().value!);
    if (fact.kind === "subagent_command") {
      const lease = parseExecutionReference(fact.executionReference);
      return (
        lease.leaseId === leaseId &&
        lease.attemptId === scope.attemptId &&
        lease.fencingToken === scope.fencingToken
      );
    }
    if (fact.kind === "agent_event")
      return fact.event.sessionId === scope.sessionId && fact.event.turnId === scope.turnId;
    if (fact.kind === "pi_session_append") {
      if (
        fact.piSession.id !== scope.piSessionId ||
        fact.piSession.lane !== piSessionLane ||
        fact.piSession.writerId !== scope.writerId
      )
        return false;
      return (
        fact.events.every((e) => e.sessionId === scope.sessionId && e.turnId === scope.turnId) &&
        fact.items.every((item) =>
          item.kind === "entry"
            ? item.lane === piSessionLane
            : item.kind === "record"
              ? item.record.lane === piSessionLane
              : item.kind === "lane"
                ? item.create || item.lane === piSessionLane
                : piSessionLane === "main",
        )
      );
    }
    return true;
  }
}
