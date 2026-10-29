import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FORK_PROVENANCE_DOCUMENT } from "@pi-cloud/protocol";
import { assertIdleNativeSession } from "@pi-cloud/pi-session-postgres";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "@pi-cloud/pi-session-postgres/durable";

const Provenance = defineDoc(FORK_PROVENANCE_DOCUMENT);

/** Matched, cold conversion. Reads and Worker opens never synthesize missing provenance. */
export async function upgradeForkProvenance(database: Kysely<Database>): Promise<number> {
  let converted = 0;
  for (;;) {
    const { rows } = await sql<{
      tenant_id: string;
      id: string;
      pi_session_id: string;
      source_id: string;
      entry_id: string;
    }>`
      select s.tenant_id,s.id,s.pi_session_id,s.conversation_parent_session_id as source_id,s.conversation_fork_entry_id as entry_id
      from sessions s where s.session_kind='conversation' and s.pruned_at is null and s.conversation_fork_entry_id is not null
        and not exists(select 1 from pi_durable_records r where r.tenant_id=s.tenant_id and r.session_id=s.pi_session_id
          and r.kind='document' and r.fields->>'nativeKind'=${JSON.stringify(FORK_PROVENANCE_DOCUMENT.kind)})
      order by s.tenant_id,s.id limit 32`.execute(database);
    if (!rows.length) return converted;
    for (const row of rows)
      await database.transaction().execute(async (tx) => {
        const owner = await tx
          .selectFrom("sessions")
          .select("pi_session_id")
          .where("tenant_id", "=", row.tenant_id)
          .where("id", "=", row.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (owner.pi_session_id !== row.pi_session_id)
          throw new Error("Fork family changed during cold conversion");
        await assertIdleNativeSession(tx, row.tenant_id, row.pi_session_id);
        const projection = new DurablePostgresProjection(
          tx,
          { tenantId: row.tenant_id, sessionId: row.pi_session_id },
          undefined,
          "references",
        );
        const storage = await PublishedDurableStorage.open({
          projection,
          publish: async (batch) => void (await projection.applyIn(tx, batch)),
          waitProjected: async () => {},
        });
        const session = createSession(storage);
        try {
          await session.commit(async (change) => {
            const state = await change.doc(Provenance);
            if (state.origin) throw new Error("Fork provenance changed during cold conversion");
            state.origin = {
              sessionId: row.id,
              sourceSessionId: row.source_id,
              sourceEntryId: row.entry_id,
            };
          }, BACKGROUND_CONTEXT);
        } finally {
          await session.close(BACKGROUND_CONTEXT);
        }
        converted++;
      });
  }
}
