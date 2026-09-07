import { createHash } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import { SESSION_TERMINAL_EVENT_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import { sql, type Transaction } from "kysely";
import type { AcceptedExecutionCommitFact, AcceptedExecutionSealFact } from "./accepted-fact.ts";
import type { FactPosition } from "./accepted-fact-recovery.ts";

/** Domain-separated UUIDv8: the ACK and seal have distinct, stable identities. */
export function executionCommitId(sealId: string): string {
  const bytes = createHash("sha256").update(`pi-cloud.execution-commit:${sealId}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function enqueueExecutionCommit(
  transaction: Transaction<Database>,
  seal: AcceptedExecutionSealFact,
  position: FactPosition,
  event: AcceptedExecutionCommitFact["event"],
): Promise<void> {
  const fact: AcceptedExecutionCommitFact = {
    kind: "execution_committed",
    factId: executionCommitId(seal.factId),
    scope: seal.scope,
    seal: {
      factId: seal.factId,
      topic: position.topic,
      partition: position.partition,
      offset: position.offset.toString(),
    },
    event,
    occurredAt: event.occurredAt,
  };
  const now = new Date();
  await transaction
    .insertInto("outbox")
    .values({
      id: fact.factId,
      tenant_id: fact.scope.tenantId,
      aggregate_type: "session_terminal_event",
      aggregate_id: fact.factId,
      topic: SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
      payload: fact,
      attempts: 0,
      available_at: now,
      created_at: now,
      published_at: null,
      last_error: null,
    })
    .onConflict((conflict) =>
      conflict
        .column("id")
        .doUpdateSet({
          // Repeated seals can arrive after the original ACK has left a Gateway's
          // replay range. Re-arm its immutable ACK; never replace a pending claim.
          published_at: null,
          available_at: now,
          attempts: sql<number>`outbox.attempts + 1`,
          last_error: null,
        })
        .where("outbox.published_at", "is not", null),
    )
    .execute();
}
