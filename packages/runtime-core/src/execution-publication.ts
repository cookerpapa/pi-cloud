import { isDeepStrictEqual } from "node:util";
import type { Database } from "@pi-cloud/database";
import { parseExecutionReference } from "@pi-cloud/protocol";
import { type Kysely } from "kysely";
import type { ExecutionPublication } from "./accepted-fact.ts";
import type { ExecutionLogOpenRequest } from "./execution-log.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";

/** Admission stores this scope together with the single Run's owner/state. */
export function createExecutionPublication(
  request: Omit<ExecutionLogOpenRequest, "publication"> & { tenantId: string; runId: string },
): ExecutionPublication {
  const lease = parseExecutionReference(request.executionReference);
  const permit: ExecutionPublication = {
    scope: {
      tenantId: request.tenantId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      runId: request.runId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      piSessionId: request.piSession.id,
      piSessionLane: request.piSession.lane,
      writerId: lease.leaseId,
    },
  };
  if (lease.runId !== request.runId || lease.leaseId !== request.piSession.writerId)
    throw new Error("Execution publication does not match its Run and Session owner");
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
    const id = fact.scope.runId;
    let authority = this.#cache.get(id);
    if (!authority) {
      const row = await this.database
        .selectFrom("runs")
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
        lease.runId === scope.runId &&
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
