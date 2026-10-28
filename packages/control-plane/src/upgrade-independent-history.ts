import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { assertIdleNativeSession } from "@pi-cloud/pi-session-postgres";
import { freezeForkHistory, retainFrozenImages } from "@pi-cloud/runtime-core/frozen-history";

/** One-time drained data conversion, called by the matched bootstrap job, never by a history reader. */
export async function upgradeIndependentHistories(database: Kysely<Database>): Promise<number> {
  let converted = 0;
  for (;;) {
    const candidates = (
      await sql<{
        tenant_id: string;
        id: string;
        parent: string;
        turn_id: string;
        entry_id: string;
      }>`
      select s.tenant_id,s.id,s.conversation_parent_session_id as parent,s.conversation_fork_turn_id as turn_id,s.conversation_fork_entry_id as entry_id
      from sessions s where s.session_kind='conversation' and s.pruned_at is null and s.conversation_parent_session_id is not null
        and not s.history_imported
        and not exists(select 1 from sessions p where p.tenant_id=s.tenant_id and p.id=s.conversation_parent_session_id
          and p.session_kind='conversation' and not p.history_imported)
      order by s.tenant_id,s.id limit 32`.execute(database)
    ).rows;
    if (!candidates.length) break;
    for (const child of candidates)
      await database.transaction().execute(async (tx) => {
        const family = await tx
          .selectFrom("sessions")
          .select(["id", "pi_session_id"])
          .where("tenant_id", "=", child.tenant_id)
          .where("id", "in", [child.parent, child.id])
          .orderBy("id")
          .forUpdate()
          .execute();
        if (family.length !== 2)
          throw new Error("Existing Fork source is missing during conversion");
        for (const row of family)
          await assertIdleNativeSession(tx, child.tenant_id, row.pi_session_id);
        const active = await tx
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", child.tenant_id)
          .where("session_id", "in", [child.parent, child.id])
          .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
          .executeTakeFirst();
        if (active) throw new Error("Drain existing Fork work before history conversion");
        const prefix = await freezeForkHistory(tx, {
          tenantId: child.tenant_id,
          sourceSessionId: child.parent,
          targetSessionId: child.id,
          throughTurnId: child.turn_id,
          throughEntryId: child.entry_id,
        });
        // Legacy Forks numbered their own Runs from one. Normalize once while closed; execution identity and order are unchanged.
        let before = Number.MAX_SAFE_INTEGER;
        for (;;) {
          const rows = await tx
            .selectFrom("runs")
            .select(["id", "mailbox_position"])
            .where("tenant_id", "=", child.tenant_id)
            .where("session_id", "=", child.id)
            .where("mailbox_position", "<", String(before))
            .orderBy("mailbox_position", "desc")
            .limit(64)
            .execute();
          if (!rows.length) break;
          for (const r of rows)
            await tx
              .updateTable("runs")
              .set({ mailbox_position: String(Number(r.mailbox_position) + prefix) })
              .where("id", "=", r.id)
              .execute();
          before = Number(rows.at(-1)!.mailbox_position);
        }
        await tx
          .updateTable("sessions")
          .set({ next_mailbox_position: sql`next_mailbox_position+${prefix}` })
          .where("id", "=", child.id)
          .execute();
        await retainFrozenImages(
          tx,
          {
            tenantId: child.tenant_id,
            sessionId: family.find((r) => r.id === child.id)!.pi_session_id,
          },
          [child.id],
        );
        await sql`update sessions set history_imported=true where tenant_id=${child.tenant_id}::uuid and id=${child.id}::uuid`.execute(
          tx,
        );
        converted++;
      });
  }
  const missing =
    await sql`select 1 from sessions s where s.session_kind='conversation' and s.pruned_at is null and s.conversation_parent_session_id is not null
    and not s.history_imported limit 1`.execute(database);
  if (missing.rows.length)
    throw new Error("Existing Fork ancestry cannot be converted independently");
  return converted;
}
