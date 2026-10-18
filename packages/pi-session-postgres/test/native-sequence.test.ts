// Isolated real PostgreSQL plus an in-memory blob port; no production services.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ImageAttachmentCodec, PostgresImageAttachmentStore } from "@pi-cloud/session-attachments";
import { PublishedDurableStorage } from "../src/durable/published-storage.ts";
import { DurablePostgresProjection } from "../src/durable/postgres-projection.ts";

let db: ReturnType<typeof createDatabase>, admin: Pool, name: string;
beforeAll(async () => {
  const url = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  if (!url) throw Error("Use scripts/run-with-test-postgres.mjs; production DBs are not supported");
  admin = new Pool({ connectionString: url, max: 1 });
  name = `native_sequence_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${name}"`);
  const endpoint = new URL(url);
  endpoint.pathname = `/${name}`;
  db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
  await runMigrations(db, "up");
}, 60000);
afterAll(async () => {
  await db?.destroy();
  if (admin) {
    await admin.query(`drop database "${name}"`);
    await admin.end();
  }
});

it("reads cold sequence metadata without loading an image or body", async () => {
  const tenantId = randomUUID(),
    sessionId = randomUUID();
  await db.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
  await db.insertInto("pi_sessions").values({ tenant_id: tenantId, id: sessionId }).execute();
  const bytes = Buffer.alloc(192 * 1024, 42),
    data = bytes.toString("base64");
  const objects = new Map<string, Buffer>();
  let unavailable = false,
    transferred = 0;
  const attachments = new PostgresImageAttachmentStore(db, {
    async put(key, value) {
      objects.set(key, Buffer.from(value));
    },
    async *readStream(key) {
      if (unavailable) throw Error("Fixture object transport unavailable");
      const value = objects.get(key);
      if (!value) throw Error("Fixture object missing");
      transferred += value.byteLength;
      yield value;
    },
    async delete(key) {
      objects.delete(key);
    },
  });
  const codec = new ImageAttachmentCodec(attachments);
  const projection = new DurablePostgresProjection(db, { tenantId, sessionId }, codec);
  const store = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      const packed = await codec.pack({ tenantId }, batch);
      await projection.apply(packed, [], {
        topic: "review-fixture",
        partition: 0,
        offset: BigInt(batch.seq),
      });
    },
    waitProjected: async (through) => {
      expect((await projection.head()).seq).toBeGreaterThanOrEqual(through);
    },
  });
  const models = createModels(),
    provider = fauxProvider({
      tokensPerSecond: 1_000_000,
      models: [{ id: "vision", input: ["text", "image"] }],
    });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("picture", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("DONE"),
  ]);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "review",
      tools: [
        defineTool({
          name: "picture",
          description: "Synthetic bytes at the image codec boundary",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "image", data, mimeType: "image/png" }] }),
        }),
      ],
    }),
  );
  const harness = await Harness.open(
    store,
    { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
    context,
  );
  try {
    const m = provider.getModel();
    const root = await harness.root(context, {
      agent: { model: { provider: m.provider, modelId: m.id } },
    });
    const submission = await root.submit({ type: "input", content: "get picture" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const result = (await root.context(context)).entries.find((e) => e.kind === "pi.tool-result")!;
    expect(result).toBeDefined();
    const sequenceQueries = vi.spyOn(projection, "recordSequence");
    const sequence = await store.recordSequence(result.id);
    expect(sequenceQueries).not.toHaveBeenCalled();
    await store.flush();
    const bodyQueries = vi.spyOn(projection, "get"),
      imageGets = vi.spyOn(attachments, "get");
    transferred = 0;
    expect(await store.recordSequence(result.id)).toBe(sequence);
    expect(await store.recordSequence(result.id)).toBe(sequence);
    expect(bodyQueries).not.toHaveBeenCalled();
    expect(imageGets).not.toHaveBeenCalled();
    expect(transferred).toBe(0);
    expect(sequenceQueries).toHaveBeenCalledTimes(2);
    unavailable = true;
    await expect(store.recordSequence(result.id)).resolves.toBe(sequence);
    expect(await store.recordSequence(1000000)).toBeUndefined();
    expect(await store.recordSequence(0)).toBeUndefined();
    const { rows } = await sql<{
      seq: string;
    }>`select seq from pi_durable_records where tenant_id=${tenantId}::uuid and session_id=${sessionId} and id=${result.id}`.execute(
      db,
    );
    expect(Number(rows[0]!.seq)).toBe(sequence);
  } finally {
    unavailable = false;
    await harness.close(context);
    await store.close(context);
  }
}, 30000);
