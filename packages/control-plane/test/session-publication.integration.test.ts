import { installBinaryBodyParser } from "../src/binary-body-parser.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { Admin } from "@platformatic/kafka";
import { sql } from "kysely";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { SessionProjector } from "../../runtime-core/src/session-projector.ts";
import { HttpPublicationClient } from "../../runtime-core/src/http-publication-client.ts";
import { WorkerExecutionLog } from "../../runtime-core/src/worker-execution-log.ts";
import type {
  ExecutionPublication,
  AcceptedDurableCommitFact,
  AcceptedExecutionSealFact,
} from "../../runtime-core/src/accepted-fact.ts";
import { SessionPublicationService } from "../src/session-publication-service.ts";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { up as publicationCutover } from "../../database/src/migrations/158_control_plane_publication.ts";

const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
it.skipIf(!postgres || !brokers)(
  "publishes without append-path SQL, restores ingress ownership without retrying lost ACKs, seals and replaces the writer",
  async () => {
    const name = `publication_${randomUUID().replaceAll("-", "")}`,
      topic = `pi-publication-${randomUUID()}`;
    const admin = createDatabase({ connectionString: postgres!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const endpoint = new URL(postgres!);
    endpoint.pathname = `/${name}`;
    const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 8 });
    const kafka = new Admin({ clientId: topic, bootstrapBrokers: brokers! });
    const requestScope = new AsyncLocalStorage<string>(),
      queries: string[] = [],
      openQueries: string[] = [];
    const measured = database.withPlugin({
      transformQuery({ node, queryId }) {
        if (requestScope.getStore()?.endsWith("/append"))
          queries.push(database.getExecutor().compileQuery(node, queryId).sql);
        if (requestScope.getStore()?.endsWith("/open"))
          openQueries.push(database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    let projector!: SessionProjector;
    let loseAppendReply = false;
    const appendRequests: string[] = [];
    const server = Fastify({ logger: false }),
      token = "publication-fixture-" + randomUUID();
    installBinaryBodyParser(server);
    server.addHook("onRequest", (request, _reply, done) => {
      requestScope.run(request.url, done);
    });
    server.addHook("onSend", (request, reply, payload, done) => {
      if (loseAppendReply && request.url.endsWith("/append")) {
        loseAppendReply = false;
        reply.raw.destroy();
      }
      done(null, payload);
    });
    new SessionPublicationService(token, {
      publicationAvailability: () => projector.publicationAvailability(),
      localPublicationAvailability: () => projector.localPublicationAvailability(),
      publicationPartition: (id) => projector.publicationPartition(id),
      ownerForPartition: (p) => projector.ownerForPartition(p),
      openPublication: (p) => projector.openPublication(p),
      appendPublication: (f) => {
        appendRequests.push(f.factId);
        return projector.appendPublication(f);
      },
      acceptSeal: (f) => projector.acceptSeal(f),
      acceptControl: (f) => projector.acceptControl(f),
    }).install(server);
    let client: HttpPublicationClient | undefined, logs: WorkerExecutionLog | undefined;
    const pending: Array<{
      finish: ReturnType<typeof Promise.withResolvers<void>>;
      execution: Promise<unknown>;
    }> = [];
    try {
      await runMigrations(database, "up");
      const url = await server.listen({ host: "127.0.0.1", port: 0 });
      const createProjector = () =>
        new SessionProjector({
          database: measured,
          notificationConnectionString: endpoint.toString(),
          brokers: brokers!,
          clientId: topic,
          topic,
          partitions: 1,
          replicas: 3,
          retentionMs: 600_000,
          advertisedBaseUrl: url,
          publicationToken: token,
          toolCommands: { consume: async () => {} },
        });
      projector = createProjector();
      await projector.start();
      await eventually(() => projector.ownsPartition(0));
      const tenant = await createPrivateTenant(database, {
        slug: name.replaceAll("_", "-"),
        ownerDisplayName: "Publication test",
      });
      const store = new ControlPlaneStore({ database, ...tenant });
      const project = await store.createProject({
        name: "Source publication",
        source: { kind: "empty" },
      });
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "One physical Session",
        "elastic",
      );
      client = new HttpPublicationClient({ baseUrl: url, token });
      expect(await client.publicationAvailability()).toEqual({
        partitionCount: 1,
        partitions: [0],
      });
      logs = new WorkerExecutionLog(database, client);
      async function admit(key: string) {
        const accepted = await store.acceptTurn(session.sessionId, key, { prompt: key });
        const worker = await createTestWorker(database);
        const entered = Promise.withResolvers<{
          publication: ExecutionPublication;
          executionReference: string;
        }>();
        const finish = Promise.withResolvers<void>();
        const execution = worker
          .executor({
            execute: async (_r, _l, admission) => {
              entered.resolve(admission!);
              await finish.promise;
              return { stopReason: "stop" };
            },
          })
          .dispatchRun(accepted.runId);
        void execution.catch(entered.reject);
        pending.push({ finish, execution });
        return { ...accepted, ...(await entered.promise), finish, execution };
      }
      const first = await admit("first");
      const channel = await logs.open({
        ...first,
        sessionId: session.sessionId,
        nextEventSeq: 1,
        piSession: {
          id: session.sessionId,
          conversationId: 1,
          writerId: first.publication.scope.writerId,
        },
      });
      expect(openQueries).toHaveLength(1);
      openQueries.length = 0;
      // Even a matching open cache cannot replace current PG authorization.
      await client.open(first.publication);
      expect(openQueries).toHaveLength(1);
      await expect(
        database.transaction().execute((transaction) => publicationCutover<Database>(transaction)),
      ).rejects.toThrow("Drain Runs, Session leases and seals");
      const nativeId = 2;
      const data = JSON.parse('{"__proto__":{"kept":"opaque"},"constructor":"ordinary"}') as Record<
        string,
        unknown
      >;
      const fact: AcceptedDurableCommitFact = {
        kind: "durable_commit",
        factId: randomUUID(),
        scope: (({ leaseId: _lease, piConversationId: _conversation, ...scope }) => scope)(
          first.publication.scope,
        ),
        commit: {
          seq: 1,
          nextId: 3,
          writes: [
            { type: "conversation", value: { id: 1 } },
            {
              type: "entry",
              value: { id: nativeId, conversationId: 1, kind: "publication-test", data },
            },
          ],
        },
        origins: [
          {
            recordId: nativeId,
            sessionId: session.sessionId,
            runId: first.runId,
            turnId: first.turnId,
          },
        ],
        tools: [],
        cancellations: [],
        display: [],
        occurredAt: new Date().toISOString(),
      };
      queries.length = 0;
      await client.append(fact);
      await eventually(
        async () =>
          (
            await sql`select id from pi_durable_records where tenant_id=${tenant.tenantId}::uuid
        and session_id=${session.sessionId} and kind='entry' and id=${nativeId}`.execute(database)
          ).rows.length === 1,
      );
      expect(queries).toEqual([]);
      const row = (
        await sql<{
          body: string;
        }>`select body from pi_durable_log where tenant_id=${tenant.tenantId}::uuid
        and session_id=${session.sessionId} and record_kind='entry' and record_id=${nativeId}`.execute(
          database,
        )
      ).rows[0]!;
      expect(JSON.parse(row.body)).toMatchObject({ value: { data } });
      const probe = () => ({
        kind: "path_probe" as const,
        factId: randomUUID(),
        scope: fact.scope,
        occurredAt: new Date().toISOString(),
      });
      const samples: number[] = [];
      for (let i = 0; i < 12; i++) {
        const start = performance.now();
        await client.append(probe());
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      process.stdout.write(
        JSON.stringify({
          measurement: "private_http_to_rf3_commit",
          count: samples.length,
          p50Ms: samples[5],
          p95Ms: samples[11],
          appendQueries: queries.length,
        }) + "\n",
      );
      const lost = probe();
      loseAppendReply = true;
      await expect(client.append(lost)).rejects.toBeInstanceOf(Error);
      expect(appendRequests.filter((id) => id === lost.factId)).toHaveLength(1);
      await projector.close();
      projector = createProjector();
      await projector.start();
      await eventually(() => projector.ownsPartition(0));
      const resumed = probe();
      openQueries.length = 0;
      await client.append(resumed);
      // The first request was explicitly rejected before enqueue; only then may
      // the client restore the PG grant on a replacement's empty soft state.
      expect(appendRequests.filter((id) => id === resumed.factId)).toHaveLength(2);
      expect(queries).toEqual([]);
      expect(openQueries).toHaveLength(1);
      await channel.close();
      first.finish.resolve();
      await first.execution;
      await eventually(
        async () =>
          (
            await database
              .selectFrom("runs")
              .select("output_sealed_at")
              .where("id", "=", first.runId)
              .executeTakeFirst()
          )?.output_sealed_at != null,
      );
      openQueries.length = 0;
      await expect(client.open(first.publication)).rejects.toThrow("closed");
      expect(openQueries).toEqual([]);
      const second = await admit("replacement");
      const sealed = await database
        .selectFrom("outbox as o")
        .innerJoin("runs as r", "r.output_seal_id", "o.id")
        .select("o.payload")
        .where("r.id", "=", first.runId)
        .executeTakeFirstOrThrow();
      await expect(
        client.append({
          ...(sealed.payload as unknown as AcceptedExecutionSealFact),
          occurredAt: "2000-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(second.publication.scope.fencingToken).toBeGreaterThan(
        first.publication.scope.fencingToken,
      );
      await client.open(second.publication);
      expect(openQueries).toHaveLength(1);
      openQueries.length = 0;
      await expect(client.append({ ...fact, factId: randomUUID() })).rejects.toBeInstanceOf(Error);
      const wrong = { ...fact, scope: { ...fact.scope, runId: second.runId, fencingToken: 999 } };
      await expect(client.append(wrong)).rejects.toBeInstanceOf(Error);
      await expect(client.open(first.publication)).rejects.toBeInstanceOf(Error);
      expect(openQueries).toEqual([]);
      second.finish.resolve();
      await second.execution;
      await eventually(
        async () =>
          (
            await database
              .selectFrom("runs")
              .select("output_sealed_at")
              .where("id", "=", second.runId)
              .executeTakeFirst()
          )?.output_sealed_at != null,
      );
      // Losing the negative cache requires a PG read, which still rejects the
      // old grant; absence from memory is never permission to reopen it.
      await projector.close();
      projector = createProjector();
      await projector.start();
      await eventually(() => projector.ownsPartition(0));
      openQueries.length = 0;
      await expect(client.open(first.publication)).rejects.toThrow("scope");
      expect(openQueries).toHaveLength(1);
      expect(
        (
          await sql`select id from pi_durable_records where tenant_id=${tenant.tenantId}::uuid and session_id=${session.sessionId} and kind='entry'`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(1);
      await eventually(
        async () =>
          !(
            await database
              .selectFrom("outbox")
              .select("id")
              .where("aggregate_type", "=", "session_terminal_event")
              .where("published_at", "is", null)
              .execute()
          ).length,
      );
      await expect(
        database.transaction().execute((transaction) => publicationCutover<Database>(transaction)),
      ).resolves.toBeUndefined();
    } finally {
      for (const run of pending) run.finish.resolve();
      await Promise.allSettled(pending.map((run) => run.execution));
      await logs?.close().catch(() => {});
      await client?.close().catch(() => {});
      await projector?.close().catch(() => {});
      await server.close();
      await database.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
      await kafka.deleteTopics({ topics: [topic] }).catch(() => {});
      await kafka.close();
    }
  },
  90_000,
);

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeout = 30_000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Publication integration deadline exceeded");
}
