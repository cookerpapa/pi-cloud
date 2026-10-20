import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { Harness, LiveDoc, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "@pi-cloud/pi-session-postgres/durable";
import { isHostedToolBlock } from "../src/provider-hosted-transcript.ts";
import {
  modelHttpFixture,
  controlled,
  created,
  added,
  done,
  success,
} from "./fixtures/model-http.ts";
import {
  projectDurableTranscript,
  type NativeHistoryRow,
} from "../../runtime-core/src/canonical-pi-conversation.ts";

let admin: Pool, database: Kysely<Database>, name: string;
beforeAll(async () => {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
  admin = new Pool({ connectionString: endpoint, max: 1 });
  name = `hosted_native_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(endpoint);
  url.pathname = `/${name}`;
  database = createDatabase({
    connectionString: url.toString(),
    maxConnections: 2,
    readTimeoutMs: 10_000,
  });
  await runMigrations(database, "up");
}, 60_000);
afterAll(async () => {
  await database?.destroy();
  await admin?.query(`drop database "${name}"`);
  await admin?.end();
});

it("keeps hosted progress out of PG streaming history, then restores its aborted canonical entry", async () => {
  const scope = { tenantId: randomUUID(), sessionId: randomUUID() };
  await database
    .insertInto("tenants")
    .values({ id: scope.tenantId, slug: scope.tenantId })
    .execute();
  await database
    .insertInto("pi_sessions")
    .values({ tenant_id: scope.tenantId, id: scope.sessionId })
    .execute();
  const projection = new DurablePostgresProjection(database, scope);
  const storage = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      await projection.apply(batch, [], {
        topic: "owned-model-fixture",
        partition: 0,
        offset: BigInt(batch.seq),
      });
    },
    waitProjected: async () => {},
  });
  const ready = Promise.withResolvers<ReturnType<typeof controlled>>();
  const f = await modelHttpFixture("openai-codex", (_attempt, signal) => {
    const stream = controlled(signal);
    ready.resolve(stream);
    return stream.response;
  });
  const { harness, root } = await f.harness(storage);
  try {
    const submission = await root.submit({ type: "input", content: "search fixture" }, context);
    const upstream = await ready.promise;
    const search = {
      type: "web_search_call",
      id: "search-pg",
      status: "completed",
      action: { type: "search", query: "owned completed hosted item" },
    };
    upstream.send(created, added({ ...search, status: "in_progress" }, 0), done(search, 0));
    await vi.waitFor(
      async () =>
        expect(
          (await harness.snapshot(LiveDoc, root.id, context))?.generation?.message?.content.some(
            isHostedToolBlock,
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    const liveRows = await sql<{ n: number }>`select count(*)::int n from pi_durable_log
      where tenant_id=${scope.tenantId}::uuid and body like '%owned completed hosted item%'`.execute(
      database,
    );
    expect(liveRows.rows[0]!.n).toBe(0);
    await root.abort(context);
    expect((await submission.wait(context)).status).toBe("unanswered");
    await harness.close(context);
    await storage.close(context);

    const cold = await PublishedDurableStorage.open({
      projection: new DurablePostgresProjection(database, scope),
      publish: async () => {
        throw new Error("Cold history must not dispatch or mutate");
      },
      waitProjected: async () => {},
    });
    const reopened = await Harness.open(
      cold,
      { models: f.scoped.models, registry: createRegistry() },
      context,
    );
    try {
      const conversation = await reopened.conversation(root.id, context);
      const entries = await conversation!.entries({}, 100, undefined, context);
      const messages = entries.items.flatMap((entry) => entry.model ?? []);
      expect(
        messages
          .flatMap((m) => (m.role === "assistant" ? m.content : []))
          .filter(isHostedToolBlock),
      ).toHaveLength(1);
      expect(f.payloads).toHaveLength(1);
      const { rows } =
        await sql<NativeHistoryRow>`select r.id::text,r.seq::text,r.fields,l.body,c.committed_at
        from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
        join pi_durable_commits c using(tenant_id,session_id,seq)
        where r.tenant_id=${scope.tenantId}::uuid and r.session_id=${scope.sessionId} and r.kind='entry'
        order by r.id`.execute(database);
      const view = projectDurableTranscript(rows, {
        throughSequence: 10,
        terminalSequence: 10,
        stopReason: "aborted",
        failure: null,
        cancellation: null,
        occurredAt: new Date().toISOString(),
      });
      expect(view.items.filter((i) => i.kind === "hosted_search")).toMatchObject([
        { activityId: "search-pg", status: "completed" },
      ]);
      expect(view.items.filter((i) => i.kind === "text")).toEqual([]);
    } finally {
      await reopened.close(context);
      await cold.close(context);
    }
  } finally {
    console.log("hosted fixture: await harness.close(context); await storage.c");
    await harness.close(context);
    await storage.close(context);
    await f.close();
  }
});

it("checkpoints committed hosted progress on writer handoff and resumes the original native input", async () => {
  const scope = { tenantId: randomUUID(), sessionId: randomUUID() };
  await database
    .insertInto("tenants")
    .values({ id: scope.tenantId, slug: scope.tenantId })
    .execute();
  await database
    .insertInto("pi_sessions")
    .values({ tenant_id: scope.tenantId, id: scope.sessionId })
    .execute();
  const projection = new DurablePostgresProjection(database, scope);
  const open = (view: DurablePostgresProjection) =>
    PublishedDurableStorage.open({
      projection: view,
      publish: async (batch) => {
        await view.apply(batch, [], {
          topic: "owned-handoff",
          partition: 0,
          offset: BigInt(batch.seq),
        });
      },
      waitProjected: async () => {},
    });
  const storage = await open(projection),
    ready = Promise.withResolvers<ReturnType<typeof controlled>>();
  const old = await modelHttpFixture("openai-codex", (_attempt, signal) => {
    const stream = controlled(signal);
    ready.resolve(stream);
    return stream.response;
  });
  const { harness, root } = await old.harness(storage);
  const requestId = randomUUID();
  let successor: Awaited<ReturnType<typeof modelHttpFixture>> | undefined;
  let cold: PublishedDurableStorage | undefined,
    resumed: Awaited<ReturnType<typeof Harness.open>> | undefined;
  try {
    const input = await root.submit(
      { type: "input", content: "continue after handoff", requestId },
      context,
    );
    const upstream = await ready.promise;
    const search = {
      type: "web_search_call",
      id: "handoff-search",
      status: "completed",
      action: { type: "search", query: "handoff prefix" },
    };
    upstream.send(created, added({ ...search, status: "in_progress" }, 0), done(search, 0));
    await vi.waitFor(
      async () =>
        expect(
          (await harness.snapshot(LiveDoc, root.id, context))?.generation?.message?.content.some(
            isHostedToolBlock,
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    await harness.close(context);
    await storage.close(context);
    await old.close();
    // The production seal performs this checkpoint after ordered old-writer
    // closure. This isolated fixture substitutes synchronous PG for Kafka.
    await database
      .transaction()
      .execute((tx) => projection.checkpointLiveIn(tx, projection.liveState.fork()));
    successor = await modelHttpFixture("openai-codex", () => success());
    cold = await open(new DurablePostgresProjection(database, scope));
    resumed = await Harness.open(
      cold,
      { models: successor.scoped.models, registry: createRegistry() },
      context,
    );
    const conversation = (await resumed.conversation(root.id, context))!;
    await conversation.waitForIdle(context);
    const receipt = await cold.submissionByRequest(root.id, requestId, context);
    expect(receipt?.id).toBe(input.id);
    expect(receipt?.status).toBe("done");
    const history = await conversation.entries({}, 100, undefined, context);
    const hosted = history.items
      .flatMap((entry) => entry.model ?? [])
      .flatMap((m) => (m.role === "assistant" ? m.content : []))
      .filter(isHostedToolBlock);
    expect(hosted).toHaveLength(1);
    expect(successor.payloads).toHaveLength(1);
    // Pi keeps interrupted Entries as history but excludes aborted/error
    // Assistant messages from subsequent model context; do not override it.
    expect(JSON.stringify(successor.payloads[0])).not.toContain("handoff-search");
  } finally {
    await resumed?.close(context);
    await cold?.close(context);
    await successor?.close();
    await harness.close(context);
    await storage.close(context);
    await old.close();
  }
});
