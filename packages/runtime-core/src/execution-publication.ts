import { createPublicKey, sign, verify, randomUUID, type KeyObject } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { retryTransaction, type Database } from "@pi-cloud/database";
import { parseExecutionLease } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import type { AcceptedFact, ExecutionPublication } from "./accepted-fact.ts";
import type { ExecutionLogOpenRequest } from "./durable-event-store.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";
import { recordFactProjection } from "./accepted-fact-recovery.ts";

function unsigned(fact: AcceptedFact): AcceptedFact {
  const { signature: _signature, ...record } = fact;
  return record;
}
export function signExecutionFact(fact: AcceptedFact, privateKey: KeyObject): AcceptedFact {
  const record = unsigned(fact);
  return {
    ...record,
    signature: sign(null, Buffer.from(JSON.stringify(record)), privateKey).toString("base64url"),
  };
}

/** Authority is a one-time PG operation. There is no channel lease or token-time SELECT. */
export async function openExecutionPublication(
  database: Kysely<Database>,
  request: ExecutionLogOpenRequest,
  publicKey: string,
): Promise<ExecutionPublication> {
  const lease = parseExecutionLease(request.executionLease);
  return retryTransaction(database, async (tx) => {
    const row = await tx
      .selectFrom("run_attempts as a")
      .innerJoin("session_leases as l", "l.attempt_id", "a.id")
      .innerJoin("sessions as s", "s.id", "l.session_id")
      .innerJoin("run_attempts as w", "w.id", "a.native_writer_id")
      .select([
        "a.output_publication",
        "a.native_writer_id",
        "w.native_writer_failed_at",
        "w.native_writer_sealed_at",
        "l.tenant_id",
        "l.run_id",
        "l.turn_id",
        "l.session_id",
        "l.lease_id",
        "l.fencing_token",
        "s.pi_session_id",
        "s.pi_session_lane",
      ])
      .where("a.id", "=", lease.attemptId)
      .where("l.lease_id", "=", lease.leaseId)
      .where("l.fencing_token", "=", String(lease.fencingToken))
      .where("l.valid_until", ">", sql<Date>`clock_timestamp()`)
      .forNoKeyUpdate("a")
      .executeTakeFirst();
    if (
      !row ||
      row.session_id !== request.sessionId ||
      row.turn_id !== request.turnId ||
      row.pi_session_id !== request.piSession.id ||
      row.pi_session_lane !== request.piSession.lane ||
      row.native_writer_id !== request.piSession.writerId ||
      row.native_writer_failed_at !== null ||
      row.native_writer_sealed_at !== null
    )
      throw new Error("Execution publication requires the current Session lease");
    if (row.output_publication !== null)
      throw new Error("An Attempt cannot reopen its publication identity");
    const permit: ExecutionPublication = {
      id: randomUUID(),
      publicKey,
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
  });
}

/** The production consumer validates provenance before any PG/UI/Tool fold. */
export class ExecutionPublicationVerifier {
  readonly #cache = new Map<
    string,
    { permit: ExecutionPublication; key: KeyObject; openedAt: bigint | null; partition: number }
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
      return !!requested && isDeepStrictEqual(requested.payload, unsigned(fact));
    }
    const id = fact.scope.attemptId;
    let authority = this.#cache.get(id);
    if (!authority) {
      const row = await this.database
        .selectFrom("run_attempts")
        .select(["output_publication", "output_open_offset", "output_first_partition"])
        .where("id", "=", id)
        .where("tenant_id", "=", fact.scope.tenantId)
        .executeTakeFirst();
      if (!row?.output_publication) return false;
      const permit = row.output_publication as unknown as ExecutionPublication;
      authority = {
        permit,
        key: createPublicKey({
          key: Buffer.from(permit.publicKey, "base64url"),
          format: "der",
          type: "spki",
        }),
        openedAt: row.output_open_offset === null ? null : BigInt(row.output_open_offset),
        partition: row.output_first_partition ?? record.partition,
      };
      this.#cache.set(id, authority);
      if (this.#cache.size > 65_536) this.#cache.delete(this.#cache.keys().next().value!);
    }
    const { leaseId, piSessionLane, ...scope } = authority.permit.scope;
    const actualScope = fact.kind === "tool_command" ? { ...scope, leaseId } : scope;
    if (
      !isDeepStrictEqual(actualScope, fact.scope) ||
      !fact.signature ||
      authority.partition !== record.partition
    )
      return false;
    if (
      !verify(
        null,
        Buffer.from(JSON.stringify(unsigned(fact))),
        authority.key,
        Buffer.from(fact.signature, "base64url"),
      )
    )
      return false;
    if (fact.kind === "execution_opened") {
      if (
        fact.factId !== authority.permit.id ||
        !isDeepStrictEqual(fact.publication, authority.permit)
      )
        return false;
      if (authority.openedAt === null) {
        const opened = await this.database.transaction().execute(async (tx) => {
          const updated = await tx
            .updateTable("run_attempts")
            .set({
              output_open_offset: record.offset.toString(),
              output_first_topic: record.topic,
              output_first_partition: record.partition,
              output_first_offset: record.offset.toString(),
            })
            .where("id", "=", id)
            .where("output_open_offset", "is", null)
            .where("output_sealed_at", "is", null)
            .where(
              sql<boolean>`not exists(select 1 from run_attempts writer where writer.id=run_attempts.native_writer_id and writer.native_writer_sealed_at is not null)`,
            )
            .executeTakeFirst();
          if (updated.numUpdatedRows === 0n) return false;
          await recordFactProjection(tx, record);
          return true;
        });
        if (!opened) return false;
        authority.openedAt = record.offset;
      }
      return true;
    }
    if (authority.openedAt === null || record.offset <= authority.openedAt) return false;
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
