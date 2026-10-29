import { PostgresImageAttachmentStore } from "@pi-cloud/session-attachments";
import { SessionImageReader } from "../src/session-image-reader.ts";
import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { migrationProvider } from "../../database/src/migrations/index.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { ConversationTreeService } from "../src/conversation-tree-service.ts";
import { upgradeSharedHistory } from "../src/upgrade-shared-history.ts";
import { indexNative } from "../../pi-session-postgres/src/durable/types.ts";
import { historyFingerprint } from "../../pi-session-postgres/src/durable/current-state.ts";
import { retainedHistoryBody } from "../../pi-session-postgres/src/durable/shared-entry-bodies.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { appendNativeFixture } from "./fixtures/durable-native.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
it("converts schema-203 native bodies and frozen presentation once without changing the transcript", async () => {
  const url = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
  const admin = createDatabase({ connectionString: url, maxConnections: 1 });
  const name = `shared_upgrade_${randomUUID().replaceAll("-", "")}`;
  await sql`create database ${sql.id(name)}`.execute(admin);
  const endpoint = new URL(url);
  endpoint.pathname = "/" + name;
  const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 3 });
  try {
    const old = await new Migrator({
      db,
      provider: migrationProvider,
      allowUnorderedMigrations: true,
    }).migrateTo("203_shared_native_entry_bodies");
    if (old.error) throw old.error;
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Upgrade fixture",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "Upgrade", source: { kind: "empty" } });
    const owner = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Before upgrade",
      "elastic",
    );
    const run = await store.acceptTurn(owner.sessionId, randomUUID(), { prompt: "USER BEFORE" });
    const blobs = new Map<string, Buffer>();
    const images = new PostgresImageAttachmentStore(db, {
      async put(key, bytes) {
        blobs.set(key, Buffer.from(bytes));
      },
      async *readStream(key) {
        const b = blobs.get(key);
        if (!b) throw new Error("missing image");
        yield b;
      },
      async delete(key) {
        blobs.delete(key);
      },
    });
    const image = await images.put(
      { tenantId: tenant.tenantId },
      Buffer.from("MIGRATED-IMAGE"),
      "image/png",
    );
    await sql`insert into session_image_references(tenant_id,session_id,image_id) values(${tenant.tenantId}::uuid,${owner.sessionId},${image.id}::uuid)`.execute(
      db,
    );
    const answer = "ANSWER BEFORE nul:\0 surrogate:\ud800";
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: 1 as never } },
      {
        type: "entry",
        value: {
          id: 2 as never,
          conversationId: 1 as never,
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: [
                { type: "text", text: "USER BEFORE" },
                { type: "pi_cloud_image_v1", attachment: image },
              ] as never,
              timestamp: 1,
            },
          ],
        },
      },
      {
        type: "entry",
        value: {
          id: 3 as never,
          conversationId: 1 as never,
          kind: "pi.assistant",
          model: [fauxAssistantMessage(answer)],
        },
      },
    ];
    const origin = { cloudSession: owner.sessionId, run: run.runId, turn: run.turnId };
    const history = writes.map((w, ordinal) => ({
      ordinal,
      record_kind: w.type,
      record_id: String("value" in w ? w.value.id : 0),
      body: retainedHistoryBody(w),
      phase: null,
      cloud_origin: ordinal ? origin : null,
    }));
    await db.transaction().execute(async (tx) => {
      await sql`insert into pi_durable_commits(tenant_id,session_id,seq,next_id,fingerprint,write_count,history_write_count,history_fingerprint,current_hashes)
        values(${tenant.tenantId}::uuid,${owner.sessionId},1,4,${sha("original-wire")},3,3,${historyFingerprint(history)},'{}')`.execute(
        tx,
      );
      for (const [ordinal, write] of writes.entries()) {
        if (!("value" in write)) throw new Error("fixture");
        let bodyId: string | null = null;
        if (write.type === "entry") {
          bodyId = randomUUID();
          const { id: _id, conversationId: _conversation, ...value } = write.value,
            text = JSON.stringify(value);
          await sql`insert into pi_history_bodies(tenant_id,id,sha256,payload_text,payload_bytes) values(${tenant.tenantId}::uuid,${bodyId}::uuid,${sha(text)},${text},${Buffer.byteLength(text)})`.execute(
            tx,
          );
        }
        await sql`insert into pi_durable_writes(tenant_id,session_id,seq,ordinal,record_kind,record_id,body,cloud_origin,entry_body_id,entry_conversation_id)
          values(${tenant.tenantId}::uuid,${owner.sessionId},1,${ordinal},${write.type},${write.value.id},${bodyId ? null : JSON.stringify(write)},${ordinal ? JSON.stringify(origin) : null}::jsonb,${bodyId}::uuid,${bodyId ? 1 : null})`.execute(
          tx,
        );
        const indexed = indexNative(
          write.type as "entry" | "conversation",
          write.value,
          1,
          ordinal,
        );
        if (ordinal) Object.assign(indexed.fields, origin);
        await sql`insert into pi_durable_records(tenant_id,session_id,id,kind,seq,ordinal,fields) values(${tenant.tenantId}::uuid,${owner.sessionId},${write.value.id},${write.type},1,${ordinal},${JSON.stringify(indexed.fields)}::jsonb)`.execute(
          tx,
        );
      }
      await tx
        .updateTable("runs")
        .set({
          state: "completed",
          settled_at: new Date(),
          output_display_seq: "1",
          output_display_native_seq: "1",
        })
        .where("id", "=", run.runId)
        .execute();
      await tx
        .updateTable("sessions")
        .set({ state: "idle" })
        .where("id", "=", owner.sessionId)
        .execute();
      const values = [
        {
          kind: "turn",
          id: 0,
          ordinal: 0,
          seq: 0,
          entry: null,
          fields: {
            runId: run.runId,
            operationKind: "chat",
            runState: "completed",
            stopReason: "stop",
            coverage: "1",
            nativeCoverage: "1",
            acceptedAt: new Date(1).toISOString(),
          },
          body: {
            input_text: "USER BEFORE",
            input_source: null,
            input_uploads: [],
            scheduled_origin: null,
            output_display_seq: "1",
          },
        },
        ...[2, 3].map((id) => ({
          kind: "record",
          id,
          ordinal: id - 1,
          seq: 1,
          entry: id,
          fields: {},
          body: { fields: {}, committedAt: new Date(1).toISOString(), taskKind: null },
        })),
      ];
      for (const value of values) {
        const text = JSON.stringify(value.body);
        const body = (
          await sql<{
            id: string;
          }>`insert into pi_history_bodies(tenant_id,id,body_kind,sha256,payload_text,payload_bytes)
          values(${tenant.tenantId}::uuid,${randomUUID()}::uuid,'metadata',${sha(text)},${text},${Buffer.byteLength(text)})
          on conflict(tenant_id,body_kind,sha256) do update set sha256=excluded.sha256 returning id`.execute(
            tx,
          )
        ).rows[0]!;
        await sql`insert into pi_history_snapshots(tenant_id,session_id,turn_id,origin_session_id,kind,record_id,seq,ordinal,position,entry_id,body_id,fields,body_bytes)
          values(${tenant.tenantId}::uuid,${owner.sessionId}::uuid,${run.turnId}::uuid,${owner.sessionId}::uuid,${value.kind},${value.id},${value.seq},${value.ordinal},1,${value.entry},${body.id}::uuid,${JSON.stringify(value.fields)}::jsonb,${Buffer.byteLength(text) + 512})`.execute(
          tx,
        );
      }
    });
    const before = (await sql`select body from pi_durable_log order by seq,ordinal`.execute(db))
      .rows;
    await runMigrations(db, "up");
    await upgradeSharedHistory(db);
    expect(
      (await sql`select body from pi_durable_log order by seq,ordinal`.execute(db)).rows,
    ).toEqual(before);
    expect(JSON.stringify(await store.getConversation(owner.sessionId))).toContain("ANSWER BEFORE");
    const tree = new ConversationTreeService({ database: db });
    const fork = await tree.fork(tenant.tenantId, owner.sessionId, randomUUID(), {
      turnId: run.turnId,
      entryId: "3",
    });
    await appendNativeFixture(
      db,
      {
        tenantId: tenant.tenantId,
        sessionId: owner.sessionId,
        runId: run.runId,
        turnId: run.turnId,
      },
      [{ kind: "pi.assistant", model: [fauxAssistantMessage("LATER REMOVED")] }],
    );
    await tree.prune(tenant.tenantId, owner.sessionId, randomUUID(), {
      turnId: run.turnId,
      entryId: "3",
    });
    const prefix = JSON.stringify(await store.getConversation(owner.sessionId));
    await upgradeSharedHistory(db);
    expect(JSON.stringify(await store.getConversation(owner.sessionId))).toBe(prefix);
    expect(prefix).not.toContain("LATER REMOVED");
    expect(JSON.stringify(await store.getConversation(fork.session.sessionId))).toContain(
      "ANSWER BEFORE",
    );
    expect(await images.reap(0)).toBe(0);
    const retainedImage = await new SessionImageReader(db, images).withImage(
      tenant.tenantId,
      fork.session.sessionId,
      image.id,
      async (_ref, chunks) => {
        const parts: Uint8Array[] = [];
        for await (const part of chunks) parts.push(part);
        return Buffer.concat(parts).toString();
      },
      new AbortController().signal,
    );
    expect(retainedImage).toBe("MIGRATED-IMAGE");
  } finally {
    await db.destroy();
    await sql`drop database ${sql.id(name)}`.execute(admin);
    await admin.destroy();
  }
}, 60000);
