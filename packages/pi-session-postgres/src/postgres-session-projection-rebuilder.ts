import type { Database } from "@pi-cloud/database";
import type { Entry, LaneRecord } from "@earendil-works/pi-agent-core";
import type { Kysely } from "kysely";

type EntryProjection = Readonly<{
  entry: Entry;
  turnId: string | null;
}>;

type RecordProjection = Readonly<{
  record: LaneRecord;
  turnId: string | null;
}>;

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
 * Rebuild the query projections of one inactive Pi Session from its canonical
 * self-contained log. Callers own maintenance admission; this function takes
 * the Session row lock and performs no model or Tool work.
 */
export async function rebuildPostgresPiSessionProjections(
  database: Kysely<Database>,
  input: { tenantId: string; sessionId: string },
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const session = await transaction
      .selectFrom("pi_sessions")
      .select("id")
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", input.sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (session === undefined) throw new Error("Pi Session was not found");

    const events = await transaction
      .selectFrom("pi_session_log")
      .select(["seq", "kind", "payload"])
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .orderBy("seq", "asc")
      .execute();
    const entries = new Map<string, EntryProjection>();
    const records = new Map<string, RecordProjection>();
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
        const entry = {
          ...structuredClone(entryPayload),
          seq: sequence,
          parentId: nullableText(entryPayload.parentId, "Entry parent"),
          timestamp: safeInteger(entryPayload.timestamp, "Entry timestamp"),
        } as Entry;
        const id = text(entry.id, "Entry id");
        if (entries.has(id) || records.has(id)) {
          throw new Error(`Pi Session log reuses id ${id}`);
        }
        const rawTurnId = eventPayload.turnId;
        const turnId =
          rawTurnId === null || rawTurnId === undefined ? null : text(rawTurnId, "Turn id");
        entries.set(id, { entry, turnId });
        lanes.set(lane, id);
        continue;
      }
      if (event.kind === "record") {
        const recordPayload = object(eventPayload.record, "Record payload");
        const record = {
          ...structuredClone(recordPayload),
          seq: sequence,
          timestamp: safeInteger(recordPayload.timestamp, "Record timestamp"),
        } as LaneRecord;
        const id = text(record.id, "Record id");
        if (entries.has(id) || records.has(id)) {
          throw new Error(`Pi Session log reuses id ${id}`);
        }
        const rawTurnId = eventPayload.turnId;
        const turnId =
          rawTurnId === null || rawTurnId === undefined ? null : text(rawTurnId, "Turn id");
        records.set(id, { record, turnId });
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
      .deleteFrom("pi_session_entry_refs")
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .execute();
    await transaction
      .deleteFrom("pi_session_labels")
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .execute();
    await transaction
      .deleteFrom("pi_session_records")
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .execute();
    await transaction
      .deleteFrom("pi_session_lanes")
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId)
      .execute();

    const entryIds = [...entries.keys()];
    let staleEntries = transaction
      .deleteFrom("pi_session_entries")
      .where("tenant_id", "=", input.tenantId)
      .where("session_id", "=", input.sessionId);
    if (entryIds.length > 0) staleEntries = staleEntries.where("id", "not in", entryIds);
    await staleEntries.execute();

    if (entries.size > 0) {
      await transaction
        .insertInto("pi_session_entries")
        .values(
          [...entries.values()].map(({ entry, turnId }) => ({
            tenant_id: input.tenantId,
            session_id: input.sessionId,
            id: entry.id,
            seq: entry.seq,
            parent_id: entry.parentId,
            type: entry.type,
            custom_type: entry.type === "custom" ? entry.customType : null,
            timestamp_ms: entry.timestamp,
            payload: entry as unknown as Record<string, unknown>,
            turn_id: turnId,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(["tenant_id", "session_id", "id"]).doUpdateSet((excluded) => ({
            seq: excluded.ref("excluded.seq"),
            parent_id: excluded.ref("excluded.parent_id"),
            type: excluded.ref("excluded.type"),
            custom_type: excluded.ref("excluded.custom_type"),
            timestamp_ms: excluded.ref("excluded.timestamp_ms"),
            payload: excluded.ref("excluded.payload"),
            turn_id: excluded.ref("excluded.turn_id"),
          })),
        )
        .execute();
    }
    if (records.size > 0) {
      await transaction
        .insertInto("pi_session_records")
        .values(
          [...records.values()].map(({ record, turnId }) => ({
            tenant_id: input.tenantId,
            session_id: input.sessionId,
            id: record.id,
            seq: record.seq,
            lane: record.lane,
            type: record.type,
            run_id:
              record.type === "operation_started"
                ? record.id
                : "runId" in record && typeof record.runId === "string"
                  ? record.runId
                  : null,
            operation_kind: record.type === "operation_started" ? record.intent.kind : null,
            timestamp_ms: record.timestamp,
            payload: record as unknown as Record<string, unknown>,
            turn_id: turnId,
          })),
        )
        .execute();
    }
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
