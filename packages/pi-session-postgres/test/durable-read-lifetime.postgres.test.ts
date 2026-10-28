import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { ImageAttachmentCodec, PostgresImageAttachmentStore } from "@pi-cloud/session-attachments";
import type { ImageAttachmentReference } from "@pi-cloud/protocol";
import { DurablePostgresProjection, PublishedDurableStorage } from "../src/durable/index.ts";

let admin: Pool, database: Kysely<Database>, reads: Kysely<Database>, name: string, url: string;
beforeAll(async () => {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
  admin = new Pool({ connectionString: endpoint, max: 1 });
  name = `native_reads_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${name}"`);
  const parsed = new URL(endpoint);
  parsed.pathname = `/${name}`;
  url = parsed.toString();
  database = createDatabase({ connectionString: url });
  reads = createDatabase({ connectionString: url, maxConnections: 2, readTimeoutMs: 5_000 });
  await runMigrations(database, "up");
}, 60_000);
afterAll(async () => {
  await reads?.destroy();
  await database?.destroy();
  await admin?.query(`drop database "${name}"`);
  await admin?.end();
});

async function fixture(
  options: {
    readDatabase?: Kysely<Database>;
    images?: ImageAttachmentCodec;
    model?: unknown[];
    imageReference?: ImageAttachmentReference;
    signal?: AbortSignal;
  } = {},
) {
  const scope = { tenantId: randomUUID(), sessionId: randomUUID() };
  await database
    .insertInto("tenants")
    .values({ id: scope.tenantId, slug: scope.tenantId })
    .execute();
  await database
    .insertInto("pi_sessions")
    .values({ tenant_id: scope.tenantId, id: scope.sessionId })
    .execute();
  const projection = new DurablePostgresProjection(database, scope, options.images);
  if (options.imageReference) {
    const ref = options.imageReference;
    await sql`insert into session_image_objects(tenant_id,id,state,sha256,byte_length,mime_type)
      values(${scope.tenantId}::uuid,${ref.id}::uuid,'ready',${ref.sha256},${ref.byteLength},${ref.mimeType})`.execute(
      database,
    );
  }
  await projection.apply({
    seq: 1 as never,
    nextId: 3,
    writes: [
      { type: "conversation", value: { id: 1 as never } },
      {
        type: "entry",
        value: {
          id: 2 as never,
          conversationId: 1 as never,
          kind: "owned.fixture",
          data: "retained",
          ...(options.model ? { model: options.model as never } : {}),
        },
      },
    ],
  });
  const failed = vi.fn();
  const store = await PublishedDurableStorage.open({
    projection: new DurablePostgresProjection(options.readDatabase ?? reads, scope, options.images),
    ...(options.signal ? { signal: options.signal } : {}),
    onReadFailure: failed,
    publish: async (batch) => {
      await projection.apply(batch);
    },
    waitProjected: async () => {},
  });
  return { store, failed, scope, projection };
}

it("cancels a locked native read and a queued read, and closes without unlocking the fixture first", async () => {
  const f = await fixture(),
    lock = Promise.withResolvers<void>(),
    unlock = Promise.withResolvers<void>();
  const holder = database.transaction().execute(async (tx) => {
    await sql`lock table pi_durable_records in access exclusive mode`.execute(tx);
    lock.resolve();
    await unlock.promise;
  });
  await lock.promise;
  const abort = new AbortController();
  const pending = f.store.entry(2 as never, withAbortSignal(abort.signal, context));
  const rejected = expect(pending).rejects.toBeInstanceOf(Error);
  try {
    await vi.waitFor(async () => {
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pi_durable_records%'`.execute(
            database,
          )
        ).rows[0]!.n,
      ).toBe(1);
    });
    const queuedAbort = new AbortController();
    const queued = f.store.entry(2 as never, withAbortSignal(queuedAbort.signal, context));
    const queuedRejected = expect(queued).rejects.toBeInstanceOf(Error);
    queuedAbort.abort(new Error("Queued context ended"));
    await queuedRejected;
    abort.abort(new Error("Active context ended"));
    await rejected;
    await f.store.close(context);
    expect(f.failed).not.toHaveBeenCalled();
    await vi.waitFor(
      async () => {
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pi_durable_records%'`.execute(
              database,
            )
          ).rows[0]!.n,
        ).toBe(0);
      },
      { timeout: 3_000 },
    );
  } finally {
    abort.abort();
    unlock.resolve();
    await holder;
    await rejected;
    await f.store.close(context);
  }
});

it("classifies unavailable data for recovery but keeps corrupt content fatal", async () => {
  const short = createDatabase({ connectionString: url, maxConnections: 1, readTimeoutMs: 150 });
  const f = await fixture({ readDatabase: short });
  const lock = Promise.withResolvers<void>(),
    unlock = Promise.withResolvers<void>();
  const holder = database.transaction().execute(async (tx) => {
    await sql`lock table pi_durable_records in access exclusive mode`.execute(tx);
    lock.resolve();
    await unlock.promise;
  });
  try {
    await lock.promise;
    await expect(f.store.entry(2 as never, context)).rejects.toMatchObject({
      code: "native_storage_unavailable",
      retryable: true,
    });
    expect(f.failed).toHaveBeenCalledOnce();
  } finally {
    unlock.resolve();
    await holder;
    await f.store.close(context);
    await short.destroy();
  }
  const corrupt = await fixture();
  try {
    await sql`update pi_history_bodies set payload_text='invalid native JSON',
      payload_bytes=octet_length('invalid native JSON')
      where tenant_id=${corrupt.scope.tenantId}::uuid and id in (
        select entry_body_id from pi_durable_writes
        where tenant_id=${corrupt.scope.tenantId}::uuid and session_id=${corrupt.scope.sessionId} and record_id=2
      )`.execute(database);
    await expect(corrupt.store.entry(2 as never, context)).rejects.toBeInstanceOf(SyntaxError);
    expect(corrupt.failed).not.toHaveBeenCalled();
  } finally {
    await corrupt.store.close(context);
  }
});

it("propagates native read cancellation to image hydration", async () => {
  const bytes = Buffer.from("owned immutable image fixture");
  const ref = {
    id: randomUUID(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    mimeType: "image/png" as const,
  };
  const entered = Promise.withResolvers<AbortSignal>();
  const codec = new ImageAttachmentCodec({
    put: async () => ref,
    get: async (_tenant, _reference, signal) => {
      expect(signal).toBeDefined();
      entered.resolve(signal!);
      return new Promise<Buffer>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    },
  });
  const f = await fixture({
    images: codec,
    imageReference: ref,
    model: [
      { role: "user", timestamp: 1, content: [{ type: "pi_cloud_image_v1", attachment: ref }] },
    ],
  });
  const abort = new AbortController();
  const pending = f.store.entry(2 as never, withAbortSignal(abort.signal, context));
  const rejected = expect(pending).rejects.toBeInstanceOf(Error);
  try {
    const imageSignal = await entered.promise;
    abort.abort(new Error("Native read ended"));
    await rejected;
    expect(imageSignal.aborted).toBe(true);
    expect(f.failed).not.toHaveBeenCalled();
  } finally {
    abort.abort();
    await rejected;
    await f.store.close(context);
  }
});

it("cancels attachment inventory reads on the dedicated read pool", async () => {
  const f = await fixture(),
    bytes = Buffer.from("Owned image inventory");
  let bodyReads = 0;
  const images = new PostgresImageAttachmentStore(
    database,
    {
      put: async () => {},
      delete: async () => {},
      async *readStream() {
        bodyReads++;
        yield bytes;
      },
    },
    reads,
  );
  const ref = await images.put(f.scope, bytes, "image/png");
  const lock = Promise.withResolvers<void>(),
    unlock = Promise.withResolvers<void>();
  const holder = database.transaction().execute(async (tx) => {
    await sql`lock table session_image_objects in access exclusive mode`.execute(tx);
    lock.resolve();
    await unlock.promise;
  });
  await lock.promise;
  const abort = new AbortController();
  const pending = images.get(f.scope.tenantId, ref, abort.signal);
  const rejected = expect(pending).rejects.toBeInstanceOf(Error);
  try {
    await vi.waitFor(async () => {
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%session_image_objects%'`.execute(
            database,
          )
        ).rows[0]!.n,
      ).toBe(1);
    });
    abort.abort(new Error("Image inventory read cancelled"));
    await rejected;
    expect(bodyReads).toBe(0);
  } finally {
    abort.abort();
    unlock.resolve();
    await holder;
    await rejected;
    await f.store.close(context);
  }
});

it("reports a bounded cold-open acquisition failure without borrowing authority capacity", async () => {
  const f = await fixture(),
    short = createDatabase({ connectionString: url, maxConnections: 1, readTimeoutMs: 150 });
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const holder = short.connection().execute(async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const failed = vi.fn();
  try {
    await expect(
      PublishedDurableStorage.open({
        projection: new DurablePostgresProjection(short, f.scope),
        publish: async () => {},
        waitProjected: async () => {},
        onReadFailure: failed,
      }),
    ).rejects.toMatchObject({ code: "native_storage_unavailable" });
    expect(failed).toHaveBeenCalledOnce();
    expect((await sql<{ n: number }>`select 1 n`.execute(database)).rows[0]!.n).toBe(1);
  } finally {
    release.resolve();
    await holder;
    await short.destroy();
    await f.store.close(context);
  }
});

it("still adopts an acknowledged commit when its caller is cancelled", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const store = await PublishedDurableStorage.open({
    projection: new DurablePostgresProjection(reads, f.scope),
    publish: async (batch) => {
      await f.projection.apply(batch);
      entered.resolve();
      await proceed.promise;
    },
    waitProjected: async () => {},
  });
  const abort = new AbortController();
  const commit = store.commit(
    [
      {
        type: "entry",
        value: { id: 3 as never, conversationId: 1 as never, kind: "owned.ack", data: "confirmed" },
      },
    ],
    withAbortSignal(abort.signal, context),
  );
  try {
    await entered.promise;
    abort.abort(new Error("Caller stopped after ACK"));
    proceed.resolve();
    expect(await commit).toBe(2);
    expect((await store.entry(3 as never, context))?.entry.data).toBe("confirmed");
  } finally {
    proceed.resolve();
    await commit;
    await store.close(context);
    await f.store.close(context);
  }
});
