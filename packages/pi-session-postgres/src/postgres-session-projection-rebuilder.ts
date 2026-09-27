import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";

import { assertIdleNativeSession } from "./idle-session-mutation.ts";

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Pi Session log ${description} is invalid`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Pi Session log ${description} is invalid`);
  }
  return value;
}

function nullableText(value: unknown, description: string): string | null {
  if (value === null) return null;
  return text(value, description);
}

function safeInteger(value: unknown, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Pi Session log ${description} is invalid`);
  }
  return parsed;
}

/**
 * Rebuild current state from one quiescent Session's self-contained log.
 * Bodies and live Turn associations stay untouched. No model or Tool work.
 */
export async function rebuildPostgresPiSessionProjections(
  database: Kysely<Database>,
  input: { tenantId: string; sessionId: string },
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await assertIdleNativeSession(transaction, input.tenantId, input.sessionId);

    const events = await transaction
      .selectFrom("pi_session_log")
      .select(["seq", "kind", "payload"])
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .orderBy("seq", "asc")
      .execute();
    const ids = new Set<string>();
    const open = new Map<string, { lane: string; seq: number }>();
    const lanes = new Map<string, string | null>([["main", null]]);
    const labels = new Map<string, { label: string; sequence: number }>();
    let name: string | null = null;
    let expectedSequence = 1;

    for (const event of events) {
      const sequence = safeInteger(event.seq, "sequence");
      if (sequence !== expectedSequence) {
        throw new Error(
          `Pi Session log sequence is not contiguous: expected ${String(expectedSequence)}, received ${String(sequence)}`,
        );
      }
      expectedSequence += 1;
      const eventPayload = object(event.payload, "payload");
      if (event.kind === "entry") {
        const lane = text(eventPayload.lane, "Entry lane");
        const entryPayload = object(eventPayload.entry, "Entry payload");
        nullableText(entryPayload.parentId, "Entry parent");
        safeInteger(entryPayload.timestamp, "Entry timestamp");
        const id = text(entryPayload.id, "Entry id");
        if (ids.has(id)) throw new Error(`Pi Session log reuses id ${id}`);
        ids.add(id);
        lanes.set(lane, id);
        continue;
      }
      if (event.kind === "record") {
        const recordPayload = object(eventPayload.record, "Record payload");
        safeInteger(recordPayload.timestamp, "Record timestamp");
        const id = text(recordPayload.id, "Record id");
        const lane = text(recordPayload.lane, "Record Lane");
        if (ids.has(id)) throw new Error(`Pi Session log reuses id ${id}`);
        ids.add(id);
        if (recordPayload.type === "operation_started") open.set(id, { lane, seq: sequence });
        else if (recordPayload.type === "operation_finished") {
          const startedId = text(recordPayload.runId, "Finished operation id");
          if (open.get(startedId)?.lane === lane) open.delete(startedId);
        }
        continue;
      }
      if (event.kind === "lane") {
        lanes.set(
          text(eventPayload.lane, "Lane name"),
          nullableText(eventPayload.leafId, "Lane leaf"),
        );
        continue;
      }
      if (event.kind !== "fact") throw new Error(`Unknown Pi Session log kind ${event.kind}`);
      const fact = text(eventPayload.fact, "fact kind");
      if (fact === "name") {
        name = text(eventPayload.name, "Session name");
      } else if (fact === "label") {
        const targetId = text(eventPayload.targetId, "Label target");
        if (eventPayload.label === undefined) labels.delete(targetId);
        else {
          labels.set(targetId, {
            label: text(eventPayload.label, "Label value"),
            sequence,
          });
        }
      } else {
        throw new Error(`Unknown Pi Session fact ${fact}`);
      }
    }

    await transaction
      .deleteFrom("pi_session_open_operations")
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .execute();
    await transaction
      .deleteFrom("pi_session_labels")
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .execute();
    await transaction
      .deleteFrom("pi_session_lanes")
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .execute();

    if (open.size)
      await transaction
        .insertInto("pi_session_open_operations")
        .values(
          [...open.values()].map(({ lane, seq }) => ({
            tenant_id: input.tenantId,
            session_id: input.sessionId,
            lane,
            seq,
          })),
        )
        .execute();
    await transaction
      .insertInto("pi_session_lanes")
      .values(
        [...lanes].map(([lane, leafId]) => ({
          tenant_id: input.tenantId,
          session_id: input.sessionId,
          lane,
          leaf_id: leafId,
        })),
      )
      .execute();
    if (labels.size > 0) {
      await transaction
        .insertInto("pi_session_labels")
        .values(
          [...labels].map(([targetId, value]) => ({
            tenant_id: input.tenantId,
            session_id: input.sessionId,
            target_id: targetId,
            label: value.label,
            updated_seq: value.sequence,
          })),
        )
        .execute();
    }
    await transaction
      .updateTable("pi_sessions")
      .set({ name, next_seq: expectedSequence })
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", input.sessionId)
      .executeTakeFirstOrThrow();
  });
}
