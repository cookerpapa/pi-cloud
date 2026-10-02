import { isDeepStrictEqual } from "node:util";
import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import {
  SESSION_CONTROL_OUTBOX_TOPIC,
  parseSessionControlChange,
  type SessionControlChange,
  type SessionControlPublisher,
} from "@pi-cloud/protocol";

export async function assertCommittedControlChange(
  database: Kysely<Database>,
  change: SessionControlChange,
): Promise<void> {
  const row = await database
    .selectFrom("outbox")
    .select("payload")
    .where("id", "=", change.factId)
    .where("tenant_id", "=", change.scope.tenantId)
    .where("topic", "=", SESSION_CONTROL_OUTBOX_TOPIC)
    .where("aggregate_type", "=", "session_control_change")
    .executeTakeFirst();
  if (!row || !isDeepStrictEqual(row.payload, change))
    throw new Error("Session control change was not committed");
}

/** Synchronous lifecycle admission/closure, backed by the same retrying Outbox.
 * Neither a PG transaction nor an entity lock is held across publication. */
export class SessionControlOutbox {
  constructor(
    readonly database: Kysely<Database>,
    readonly publisher: SessionControlPublisher,
  ) {}

  async flushEntities(
    entity: SessionControlChange["entity"],
    ids: readonly string[],
  ): Promise<void> {
    if (!ids.length) return;
    for (;;) {
      const rows = await this.database
        .selectFrom("outbox")
        .select(["id", "payload"])
        .where("topic", "=", SESSION_CONTROL_OUTBOX_TOPIC)
        .where("aggregate_type", "=", "session_control_change")
        .where("aggregate_id", "in", [...ids])
        .where(sql<string>`payload->>'entity'`, "=", entity)
        .where("published_at", "is", null)
        .orderBy(sql`(payload->>'version')::bigint`)
        .limit(128)
        .execute();
      if (!rows.length) return;
      const groups = new Map<string, typeof rows>();
      for (const row of rows) {
        const change = parseSessionControlChange(row.payload);
        const key = `${change.scope.tenantId}:${change.scope.piSessionId}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      const pending = [...groups.values()];
      const failures: unknown[] = [];
      let next = 0;
      const work = async () => {
        while (next < pending.length) {
          const group = pending[next++]!;
          try {
            for (const row of group) await this.#publish(row);
          } catch (error) {
            failures.push(error);
          }
        }
      };
      // A disconnected Session owner cannot prevent closing other owners of
      // the same physical VM. All groups are attempted before returning failure.
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, work));
      if (failures.length)
        throw new AggregateError(failures, "Session control publication is incomplete");
    }
  }
  async #publish(row: { id: string; payload: Record<string, unknown> }): Promise<void> {
    const change = parseSessionControlChange(row.payload);
    const receipt = await this.publisher.publishControl(change);
    if (!receipt.durable || receipt.factId !== row.id)
      throw new Error("Session control publication was not confirmed");
    await this.database
      .updateTable("outbox")
      .set({ published_at: new Date(), last_error: null })
      .where("id", "=", row.id)
      .where("published_at", "is", null)
      .execute();
  }
}
