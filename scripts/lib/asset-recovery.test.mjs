import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, cp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { testPostgres } from "./test-postgres.mjs";
import { testImageStore } from "./test-image-store.mjs";
import { backupAssets, restoreAssets, verifyAssetBackup } from "./asset-recovery.mjs";
import { createDatabase, runMigrations } from "../../packages/database/src/index.ts";
import { createPrivateTenant } from "../../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../packages/control-plane/src/control-plane-store.ts";
import { ConversationReader } from "../../packages/control-plane/src/conversation-reader.ts";
import { appendNativeFixture } from "../../packages/control-plane/test/fixtures/durable-native.ts";
import { createTestWorker } from "../../packages/control-plane/test/admit-test-execution.ts";
import { PostgresImageAttachmentStore } from "../../packages/session-attachments/src/store.ts";
import { readDurableEntries } from "../../packages/pi-session-postgres/src/durable/history.ts";

let pg, sourceImages, targetImages, source, target, admin, directory, scope, image, bytes, before;
const names = ["source", "target"].map(
  (kind) => `recovery_${kind}_${randomUUID().replaceAll("-", "")}`,
);
const revision = "a".repeat(40);
const url = (name) => {
  const value = new URL(pg.url);
  value.pathname = `/${name}`;
  return value.toString();
};
const bundle = () => join(directory, "backup");
const logs = (db) =>
  sql`select session_id,seq,ordinal,body,cloud_origin from pi_durable_log order by session_id,seq,ordinal`
    .execute(db)
    .then((r) => r.rows);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-cloud-recovery-"));
  const started = await Promise.allSettled([testPostgres({}), testImageStore(), testImageStore()]);
  [pg, sourceImages, targetImages] = started.map((result) =>
    result.status === "fulfilled" ? result.value : undefined,
  );
  const errors = started.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Recovery fixture startup failed");
  admin = createDatabase({ connectionString: pg.url, maxConnections: 1 });
  for (const name of names) await sql`create database ${sql.id(name)}`.execute(admin);
  source = createDatabase({ connectionString: url(names[0]), maxConnections: 2 });
  target = createDatabase({ connectionString: url(names[1]), maxConnections: 2 });
  await runMigrations(source, "up");
  const tenant = await createPrivateTenant(source, {
    slug: `restore-${randomUUID()}`,
    ownerDisplayName: "Recovery fixture",
  });
  const store = new ControlPlaneStore({ database: source, ...tenant });
  const project = await store.createProject({ name: "Recovery", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Preserved conversation",
    "elastic",
  );
  const accepted = await store.acceptTurn(session.sessionId, randomUUID(), {
    prompt: "Keep this image and Tool history",
  });
  scope = { ...tenant, ...project, ...session, ...accepted };
  bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDXsAAAAASUVORK5CYII=",
    "base64",
  );
  image = await new PostgresImageAttachmentStore(source, sourceImages.blobs).put(
    scope,
    bytes,
    "image/png",
  );
  const visual = { type: "pi_cloud_image_v1", attachment: image };
  await appendNativeFixture(source, scope, [
    {
      kind: "pi.user",
      model: [
        { role: "user", content: [{ type: "text", text: "Look at this" }, visual], timestamp: 1 },
      ],
    },
    {
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "tool bytes \0 \ud800" }, visual],
          isError: false,
          timestamp: 2,
        },
      ],
    },
    {
      kind: "pi.compaction",
      head: 4,
      model: [{ role: "user", content: "Summary of earlier work", timestamp: 3 }],
    },
    {
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Image retained" }],
          api: "openai-responses",
          provider: "fixture",
          model: "fixture",
          stopReason: "stop",
          timestamp: 4,
          usage: {
            input: 1,
            output: 1,
            totalTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ],
    },
  ]);
  const terminal = {
    state: "completed",
    settled_at: new Date(),
    started_at: new Date(),
    stop_reason: "stop",
  };
  await source.updateTable("runs").set(terminal).where("id", "=", scope.runId).execute();
  await source
    .updateTable("sessions")
    .set({ state: "idle" })
    .where("id", "=", scope.sessionId)
    .execute();
  const oldWorker = await createTestWorker(source);
  const leaseId = randomUUID(),
    now = new Date();
  await source
    .insertInto("session_leases")
    .values({
      tenant_id: scope.tenantId,
      pi_session_id: scope.sessionId,
      lease_id: leaseId,
      worker_id: oldWorker.workerId,
      fencing_token: 1,
      acquired_at: now,
      renewed_at: now,
      valid_until: new Date(now.valueOf() + 60_000),
      released_at: now,
      writer_failed_at: null,
      writer_sealed_at: now,
      writer_seal_offset: 1,
    })
    .execute();
  await source
    .updateTable("runs")
    .set({
      worker_id: oldWorker.workerId,
      lease_id: leaseId,
      fencing_token: 1,
      output_seal_id: randomUUID(),
      output_sealed_at: now,
      output_seal_offset: 1,
      execution_released_at: now,
      agent_exited_at: now,
      native_output_drained: true,
    })
    .where("id", "=", scope.runId)
    .execute();
  await source
    .insertInto("outbox")
    .values({
      id: randomUUID(),
      tenant_id: scope.tenantId,
      aggregate_type: "session_control_change",
      aggregate_id: scope.sessionId,
      topic: "session.control.changed.v1",
      payload: { kind: "control_change", fixture: true },
      available_at: now,
      published_at: null,
      last_error: null,
    })
    .execute();
  before = await logs(source);
}, 120_000);

afterAll(async () => {
  const closed = await Promise.allSettled([source?.destroy(), target?.destroy(), admin?.destroy()]);
  const stopped = await Promise.allSettled([
    pg?.close(),
    sourceImages?.close(),
    targetImages?.close(),
  ]);
  if (directory) await rm(directory, { recursive: true, force: true });
  const errors = [...closed, ...stopped].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length) throw new AggregateError(errors, "Recovery fixture cleanup failed");
}, 60_000);

it("rejects an unprojected seal without producing a selectable backup", async () => {
  await source
    .updateTable("runs")
    .set({ output_sealed_at: null })
    .where("id", "=", scope.runId)
    .execute();
  await source
    .updateTable("pi_sessions")
    .set({ unsealed_runs: 1 })
    .where("id", "=", scope.sessionId)
    .execute();
  await expect(
    backupAssets({
      databaseUrl: url(names[0]),
      blobs: sourceImages.blobs,
      directory: bundle(),
      revision,
    }),
  ).rejects.toThrow("settled Runs");
  expect(await stat(bundle()).catch(() => null)).toBeNull();
  await source
    .updateTable("runs")
    .set({ output_sealed_at: new Date() })
    .where("id", "=", scope.runId)
    .execute();
});

it("rejects open writers and nonempty target stores", async () => {
  await source.updateTable("session_leases").set({ released_at: null }).execute();
  await expect(
    backupAssets({
      databaseUrl: url(names[0]),
      blobs: sourceImages.blobs,
      directory: bundle(),
      revision,
    }),
  ).rejects.toThrow("closed native writers");
  await source.updateTable("session_leases").set({ released_at: new Date() }).execute();
});

it("rolls back an actual post-restore cleanup failure instead of exposing old execution authority", async () => {
  // A foreign-key guard makes the authority reset fail AFTER pg_restore copied
  // all history. This tests the real transaction, not a mocked restore command.
  await sql`create table recovery_failure_guard(worker uuid references workers(id))`.execute(
    source,
  );
  await sql`insert into recovery_failure_guard select id from workers limit 1`.execute(source);
  const broken = join(directory, "reset-failure");
  const manifest = await backupAssets({
    databaseUrl: url(names[0]),
    blobs: sourceImages.blobs,
    directory: broken,
    revision,
  });
  await expect(
    restoreAssets({ databaseUrl: url(names[1]), ...targetImages, directory: broken }),
  ).rejects.toThrow("psql failed");
  expect(
    (await sql`select count(*)::int n from pg_tables where schemaname='public'`.execute(target))
      .rows[0].n,
  ).toBe(0);
  for (const entry of manifest.images)
    await targetImages.blobs.delete(
      `session-images/${entry.tenantId}/${entry.id}`,
      AbortSignal.timeout(5000),
    );
  await sql`drop table recovery_failure_guard`.execute(source);
}, 90_000);

it("uses real pg_dump and includes independently verified immutable image bytes", async () => {
  const manifest = await backupAssets({
    databaseUrl: url(names[0]),
    blobs: sourceImages.blobs,
    directory: bundle(),
    revision,
  });
  expect(manifest.images).toHaveLength(1);
  expect(manifest.images[0].sha256).toBe(image.sha256);
  expect((await stat(bundle())).mode & 0o777).toBe(0o700);
  expect((await stat(join(bundle(), "database.dump"))).mode & 0o777).toBe(0o600);
  expect(await verifyAssetBackup(bundle())).toEqual(manifest);
  expect(await logs(source)).toEqual(before);
}, 90_000);

it("rejects damaged/missing bytes and mismatched schema before touching the target", async () => {
  const broken = join(directory, "broken");
  await cp(bundle(), broken, { recursive: true });
  const path = join(broken, "images", scope.tenantId, image.id);
  await writeFile(path, "damaged");
  await expect(
    restoreAssets({ databaseUrl: url(names[1]), ...targetImages, directory: broken }),
  ).rejects.toThrow("integrity");
  await rm(path);
  await expect(verifyAssetBackup(broken)).rejects.toThrow();
  const manifest = JSON.parse(await readFile(join(broken, "manifest.json"), "utf8"));
  manifest.schemaSha256 = "0".repeat(64);
  await writeFile(join(broken, "manifest.json"), JSON.stringify(manifest));
  await expect(verifyAssetBackup(broken)).rejects.toThrow("schema");
  expect(
    (await sql`select count(*)::int n from pg_tables where schemaname='public'`.execute(target))
      .rows[0].n,
  ).toBe(0);
  await targetImages.assertEmptyBucket();
});

it("refuses an existing database or nonempty attachment bucket", async () => {
  await sql`create table existing_data(value text)`.execute(target);
  await expect(
    restoreAssets({ databaseUrl: url(names[1]), ...targetImages, directory: bundle() }),
  ).rejects.toThrow("database must be empty");
  await sql`drop table existing_data`.execute(target);
  await targetImages.blobs.put(
    "existing-object",
    Buffer.from("keep"),
    "text/plain",
    AbortSignal.timeout(5000),
  );
  await expect(
    restoreAssets({ databaseUrl: url(names[1]), ...targetImages, directory: bundle() }),
  ).rejects.toThrow("bucket must be empty");
  await targetImages.blobs.delete("existing-object", AbortSignal.timeout(5000));
});

it("restores after source loss, preserves exact native history/images and admits only new work in a new Workspace", async () => {
  await source.destroy();
  source = undefined;
  await sql`drop database ${sql.id(names[0])}`.execute(admin);
  await sourceImages.close();
  const started = performance.now();
  const result = await restoreAssets({
    databaseUrl: url(names[1]),
    ...targetImages,
    directory: bundle(),
  });
  console.log(
    JSON.stringify({
      event: "asset-recovery-drill",
      restoreMilliseconds: Math.round(performance.now() - started),
      images: result.images,
      sourceRemoved: true,
    }),
  );
  expect(result.restored).toBe(true);
  expect(await logs(target)).toEqual(before);
  expect(
    await new PostgresImageAttachmentStore(target, targetImages.blobs).get(scope.tenantId, image),
  ).toEqual(bytes);
  const reader = new ConversationReader(target, scope.tenantId);
  const conversation = await reader.getConversation(scope.sessionId);
  expect(conversation.turns[0].prompt).toBe("Keep this image and Tool history");
  const restored = await target
    .selectFrom("sessions")
    .selectAll()
    .where("id", "=", scope.sessionId)
    .executeTakeFirstOrThrow();
  expect(restored.workspace_id).not.toBe(scope.workspaceId);
  expect(restored).toMatchObject({
    state: "cold",
    compute_session_id: null,
    development_environment_id: null,
    execution_mode: "elastic",
  });
  expect(
    await target
      .selectFrom("runs")
      .select(["lease_id", "worker_id", "output_seal_id", "output_first_topic"])
      .where("id", "=", scope.runId)
      .executeTakeFirstOrThrow(),
  ).toEqual({
    lease_id: null,
    worker_id: null,
    output_seal_id: null,
    output_first_topic: null,
  });
  for (const table of [
    "session_leases",
    "active_execution_scopes",
    "outbox",
    "workspace_runtimes",
    "sandbox_tool_bindings",
    "workers",
    "accepted_fact_projection_offsets",
  ])
    expect(
      (await sql`select count(*)::int n from ${sql.table(table)}`.execute(target)).rows[0].n,
      table,
    ).toBe(0);
  const history = await readDurableEntries(target, {
    tenantId: scope.tenantId,
    sessionId: scope.sessionId,
    conversationId: 1,
    limit: 10,
  });
  expect(history.map((r) => r.entry.kind)).toContain("pi.compaction");
  const worker = await createTestWorker(target);
  const calls = [];
  const executor = worker.executor({
    async execute(request) {
      calls.push(request);
      return { stopReason: "stop" };
    },
  });
  expect(await executor.dispatchNext()).toEqual({ status: "idle" });
  const store = new ControlPlaneStore({ database: target, ...scope });
  const accepted = await store.acceptTurn(scope.sessionId, randomUUID(), {
    prompt: "Continue in the new environment",
  });
  expect(accepted.runId).not.toBe(scope.runId);
  expect(await executor.dispatchNext()).toMatchObject({
    status: "completed",
    runId: accepted.runId,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].workspaceId).toBe(restored.workspace_id);
}, 120_000);
