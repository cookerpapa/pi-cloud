import { insertHistoricalPrompt, insertHistoricalSession } from "./fixtures/historical-turn.ts";
import { randomUUID } from "node:crypto";
import { Migrator } from "kysely/migration";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "../src/index.ts";
import { migrationProvider } from "../src/migrations/index.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import {
  PostgresPiSessionStorage,
  rebuildPostgresPiSessionProjections,
} from "@pi-cloud/pi-session-postgres";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

it.skipIf(!endpoint)(
  "cuts over complete logs, COW Forks, live Turn bindings and image references without body rewrites",
  async () => {
    const admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    const name = `pi_indexed_log_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    try {
      const migrated = await new Migrator({
        db,
        provider: migrationProvider,
        allowUnorderedMigrations: true,
      }).migrateTo("152_editable_pending_inputs");
      if (migrated.error) throw migrated.error;
      const tenant = await createPrivateTenant(db, {
        // This fixture targets the historical schema before nullable quotas.
        quotas: { maximumProjects: 100, maximumSessions: 1000 },
        slug: "indexed-log",
        ownerDisplayName: "Storage contract",
      });
      const control = new ControlPlaneStore({ database: db, ...tenant });
      const project = await control.createProject({
        name: "indexed-log",
        source: { kind: "empty" },
      });
      const session = await insertHistoricalSession(db, { ...tenant, ...project });
      const turn = await insertHistoricalPrompt(db, {
        tenantId: tenant.tenantId,
        modelProfileId: tenant.defaultModelProfileId,
        sessionId: session.sessionId,
        projectId: project.projectId,
        workspaceId: project.workspaceId,
        environmentVersionId: project.environment.environmentVersionId,
        prompt: "retained input",
      });
      const tenantId = tenant.tenantId,
        sessionId = session.sessionId,
        forkId = randomUUID(),
        imageId = randomUUID();
      const image = {
        type: "pi_cloud_image_v1",
        attachment: { id: imageId, sha256: "a".repeat(64), byteLength: 3, mimeType: "image/png" },
      };
      await sql`insert into session_image_objects(tenant_id,id,state,sha256,byte_length,mime_type)
      values(${tenantId}::uuid,${imageId}::uuid,'ready',${"a".repeat(64)},3,'image/png')`.execute(
        db,
      );
      const root = {
        id: "root",
        seq: 1,
        type: "message",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "retained root", timestamp: 1 },
      };
      const picture = {
        id: "picture",
        seq: 3,
        type: "message",
        parentId: "root",
        timestamp: 3,
        message: {
          role: "toolResult",
          toolCallId: "read",
          toolName: "read",
          isError: false,
          content: [image],
          timestamp: 3,
        },
      };
      const start = (id: string, seq: number, lane: string) => ({
        id,
        seq,
        timestamp: seq,
        lane,
        type: "operation_started",
        sourceLeafId: null,
        intent: { kind: "run", originalPrompt: [], initialMessages: [] },
      });
      const rows = [
        { seq: 1, kind: "entry", payload: { lane: "main", turnId: turn.turnId, entry: root } },
        {
          seq: 2,
          kind: "record",
          payload: { turnId: turn.turnId, record: start("main-operation", 2, "main") },
        },
        { seq: 3, kind: "entry", payload: { lane: "main", turnId: turn.turnId, entry: picture } },
        {
          seq: 4,
          kind: "record",
          payload: { turnId: turn.turnId, record: start("child-operation", 4, "child") },
        },
        {
          seq: 5,
          kind: "record",
          payload: {
            turnId: turn.turnId,
            record: {
              id: "child-finished",
              seq: 5,
              timestamp: 5,
              lane: "child",
              type: "operation_finished",
              runId: "child-operation",
              outcome: "completed",
            },
          },
        },
        {
          seq: 6,
          kind: "entry",
          payload: {
            lane: "main",
            turnId: turn.turnId,
            entry: {
              id: "disconnected",
              seq: 6,
              timestamp: 6,
              type: "custom",
              customType: "state",
              parentId: "picture",
            },
          },
        },
      ];
      // Explicit old-schema fixture. Do not run the new storage adapter against
      // a historic migration or retain a legacy runtime writer for this test.
      await sql`insert into pi_session_log(tenant_id,session_id,seq,kind,payload)
      select ${tenantId}::uuid,${sessionId},seq,kind,payload from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        as r(seq bigint,kind text,payload jsonb)`.execute(db);
      await sql`insert into pi_session_entries(tenant_id,session_id,id,seq,parent_id,type,custom_type,timestamp_ms,payload,turn_id)
      select tenant_id,session_id,payload#>>'{entry,id}',seq,payload#>>'{entry,parentId}',payload#>>'{entry,type}',
        payload#>>'{entry,customType}',(payload#>>'{entry,timestamp}')::bigint,payload->'entry',
        case when seq=6 then null else ${turn.turnId}::uuid end
        from pi_session_log where session_id=${sessionId} and kind='entry'`.execute(db);
      await sql`insert into pi_session_records(tenant_id,session_id,id,seq,lane,type,run_id,operation_kind,timestamp_ms,payload,turn_id)
      select tenant_id,session_id,payload#>>'{record,id}',seq,payload#>>'{record,lane}',payload#>>'{record,type}',
        case when payload#>>'{record,type}'='operation_started' then payload#>>'{record,id}' else payload#>>'{record,runId}' end,
        payload#>>'{record,intent,kind}',(payload#>>'{record,timestamp}')::bigint,payload->'record',${turn.turnId}::uuid
        from pi_session_log where session_id=${sessionId} and kind='record'`.execute(db);
      await sql`insert into pi_sessions(tenant_id,id,created_at_ms,next_seq) values(${tenantId}::uuid,${forkId},1,3)`.execute(
        db,
      );
      for (const [index, entry] of [root, picture].entries()) {
        const seq = index + 1;
        await sql`insert into pi_session_entry_refs(tenant_id,session_id,id,seq,source_session_id,source_entry_id,parent_id,type,timestamp_ms)
        values(${tenantId}::uuid,${forkId},${entry.id},${seq},${sessionId},${entry.id},${entry.parentId},'message',${entry.timestamp})`.execute(
          db,
        );
        await sql`insert into pi_session_log(tenant_id,session_id,seq,kind,payload)
        values(${tenantId}::uuid,${forkId},${seq},'entry',${JSON.stringify({ lane: "main", turnId: turn.turnId, entry: { ...entry, seq } })}::jsonb)`.execute(
          db,
        );
      }
      const sdkForkId = randomUUID();
      await sql`insert into pi_sessions(tenant_id,id,created_at_ms,next_seq)
        values(${tenantId}::uuid,${sdkForkId},1,2)`.execute(db);
      await sql`insert into pi_session_entry_refs(tenant_id,session_id,id,seq,source_session_id,source_entry_id,parent_id,type,timestamp_ms)
        values(${tenantId}::uuid,${sdkForkId},'root',1,${sessionId},'root',null,'message',1)`.execute(
        db,
      );
      await sql`insert into pi_session_log(tenant_id,session_id,seq,kind,payload)
        values(${tenantId}::uuid,${sdkForkId},1,'entry',${JSON.stringify({ lane: "main", turnId: null, entry: root })}::jsonb)`.execute(
        db,
      );
      const snapshot = () =>
        db
          .selectFrom("pi_session_log")
          .select(["tenant_id", "session_id", "seq", "kind", "payload", "append_id"])
          .orderBy("session_id")
          .orderBy("seq")
          .execute();
      const before = await snapshot();
      // This fixture deliberately retains queued historical input. Test the
      // indexed-log migration itself, independently of later drained wire cuts.
      const migrateIndexedLog = async () => {
        const result = await new Migrator({
          db,
          provider: migrationProvider,
          allowUnorderedMigrations: true,
        }).migrateTo("153_indexed_native_session_log");
        if (result.error) throw result.error;
      };
      await db
        .updateTable("pi_sessions")
        .set({ unsealed_runs: 1 })
        .where("id", "=", sessionId)
        .execute();
      await expect(migrateIndexedLog()).rejects.toThrow("must settle before indexed-log cutover");
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await sql<{
            relation: string | null;
          }>`select to_regclass('pi_session_entries')::text as relation`.execute(db)
        ).rows[0]!.relation,
      ).toBe("pi_session_entries");
      await db
        .updateTable("pi_sessions")
        .set({ unsealed_runs: 0 })
        .where("id", "=", sessionId)
        .execute();
      await migrateIndexedLog();
      expect(await snapshot()).toEqual(before);
      for (const table of [
        "pi_session_entries",
        "pi_session_records",
        "pi_session_entry_refs",
        "pi_session_visible_entries",
      ]) {
        expect(
          (
            await sql<{
              relation: string | null;
            }>`select to_regclass(${table})::text as relation`.execute(db)
          ).rows[0]!.relation,
        ).toBeNull();
      }
      const storage = new PostgresPiSessionStorage({ database: db, tenantId, sessionId });
      expect(await storage.getEntry("root")).toEqual(root);
      expect((await storage.findOpenOperations("main", { limit: 2 })).map((r) => r.id)).toEqual([
        "main-operation",
      ]);
      expect(await storage.findOpenOperations("child", { limit: 2 })).toEqual([]);
      const bindings = await db
        .selectFrom("pi_session_log")
        .select(["id", "turn_id"])
        .where("kind", "=", "entry")
        .execute();
      expect(bindings.find((r) => r.id === "disconnected")!.turn_id).toBeNull();
      expect(
        await db
          .selectFrom("pi_session_log")
          .select("turn_id")
          .where("session_id", "=", sdkForkId)
          .execute(),
      ).toEqual([{ turn_id: null }]);
      expect(bindings.filter((r) => r.id === "picture").map((r) => r.turn_id)).toEqual([
        turn.turnId,
        turn.turnId,
      ]);
      expect(
        (
          await sql`select session_id from session_image_references where image_id=${imageId}::uuid`.execute(
            db,
          )
        ).rows,
      ).toHaveLength(2);
      await expect(
        sql`update pi_session_log set id='changed' where id='root'`.execute(db),
      ).rejects.toMatchObject({ code: "428C9" });

      await db.deleteFrom("runs").where("id", "=", turn.runId).execute();
      await db.deleteFrom("turns").where("id", "=", turn.turnId).execute();
      expect(
        await db
          .selectFrom("pi_session_log")
          .select("seq")
          .where("turn_id", "is not", null)
          .execute(),
      ).toEqual([]);
      await rebuildPostgresPiSessionProjections(db, { tenantId, sessionId });
      expect(await snapshot()).toEqual(before);
      expect(
        await db
          .selectFrom("pi_session_log")
          .select("seq")
          .where("turn_id", "is not", null)
          .execute(),
      ).toEqual([]);
      expect((await storage.findOpenOperations("main")).map((r) => r.id)).toEqual([
        "main-operation",
      ]);
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60000,
);
