import { MAX_EXECUTION_FACT_BYTES } from "@pi-cloud/protocol";
import { createDatabase } from "@pi-cloud/database";
import { AsyncLocalStorage } from "node:async_hooks";
import { Admin } from "@platformatic/kafka";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { DirectSessionKafkaBus } from "../../runtime-core/src/direct-session-kafka.ts";
import { SessionProjector } from "../../runtime-core/src/session-projector.ts";
import { requestExecutionStreamSeal } from "../../runtime-core/src/execution-stream-seal.ts";
import type {
  AcceptedDurableCommitFact,
  AcceptedExecutionSealFact,
  AcceptedFactScope,
  ExecutionPublication,
} from "../../runtime-core/src/accepted-fact.ts";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { createTestWorker } from "./admit-test-execution.ts";
const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

it.skipIf(!brokers || !postgres)(
  "writes directly through control-plane replacement, fences old writers and resumes the same logical work",
  async () => {
    const f = await nativeSubagentFixture(),
      topic = `direct-session-${crypto.randomUUID()}`;
    const publicationDatabase = createDatabase({
      connectionString: f.url,
      maxConnections: 4,
      checkoutTimeoutMs: 5000,
    });
    const admin = new Admin({ clientId: topic, bootstrapBrokers: brokers! });
    const measured = new AsyncLocalStorage<boolean>(),
      queries: string[] = [];
    const database = f.database.withPlugin({
      transformQuery({ node, queryId }) {
        if (measured.getStore())
          queries.push(f.database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const options = {
      database,
      brokers: brokers!,
      topic,
      clientId: topic,
      partitions: 1,
      replicas: 3,
    };
    const bus = new DirectSessionKafkaBus(options),
      successor = new DirectSessionKafkaBus(options);
    const prechecked = Promise.withResolvers<void>(),
      resumeLate = Promise.withResolvers<void>();
    let holdOnce = true;
    const lateDb = f.database.withPlugin({
      transformQuery({ node }) {
        return node;
      },
      async transformResult({ result }) {
        if (holdOnce) {
          holdOnce = false;
          prechecked.resolve();
          await resumeLate.promise;
        }
        return result;
      },
    });
    const late = new DirectSessionKafkaBus({ ...options, database: lateDb });
    const third = new DirectSessionKafkaBus(options);
    let lateOpening: Promise<void> | undefined, thirdExecution: Promise<unknown> | undefined;
    let projector: SessionProjector | undefined;
    const create = () =>
      new SessionProjector({
        ...options,
        database: f.database,
        publicationDatabase,
        notificationConnectionString: f.url,
        retentionMs: 600000,
        publicationToken: "fixture-".repeat(8),
        advertisedBaseUrl: "http://127.0.0.1:9",
        toolCommands: { consume: async () => {} },
      });
    const permit = { scope: { ...f.scope, leaseId: f.scope.writerId, piConversationId: 1 } };
    const fact = (seq: number, scope: AcceptedFactScope = f.scope): AcceptedDurableCommitFact => ({
      kind: "durable_commit",
      factId: crypto.randomUUID(),
      scope,
      commit: {
        seq,
        nextId: seq + 1,
        writes: [
          {
            type: "entry",
            value: { id: seq, conversationId: 1, kind: "test", data: { text: `entry ${seq}` } },
          },
        ],
      },
      origins: [
        { recordId: seq, runId: scope.runId, sessionId: scope.sessionId, turnId: scope.turnId },
      ],
      display: [],
      cancellations: [],
      tools: [],
      occurredAt: new Date().toISOString(),
    });
    const readRun = () =>
      f.database
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", f.scope.runId)
        .executeTakeFirstOrThrow();
    const finished = Promise.withResolvers<void>();
    let execution: Promise<unknown> | undefined;
    try {
      projector = create();
      await projector.start();
      await vi.waitFor(() => expect(projector!.ownsPartition(0)).toBe(true), { timeout: 30000 });
      await bus.checkHealth();
      expect(await bus.publicationAvailability()).toEqual({ partitionCount: 1, partitions: [0] });
      await measured.run(true, () => bus.open(permit));
      expect(queries).toHaveLength(2); // current PG grant before AND after native init
      queries.length = 0;
      const oversized = fact(2);
      Object.assign(oversized.commit.writes[0]!.value as object, {
        data: { text: "x".repeat(MAX_EXECUTION_FACT_BYTES) },
      });
      await expect(measured.run(true, () => bus.append(oversized))).rejects.toThrow(
        "transport budget",
      );
      expect(bus.publicationFailure(f.scope)).toBeUndefined();
      await measured.run(true, () => bus.append(fact(2)));
      expect(queries).toEqual([]);
      await vi.waitFor(async () => expect((await f.projection.head()).seq).toBe(2), {
        timeout: 10000,
      });
      await projector.close();
      projector = undefined;
      // No control-plane owner or HTTP server exists here. The active producer still commits.
      await measured.run(true, () => bus.append(fact(3)));
      expect(queries).toEqual([]);
      expect((await f.projection.head()).seq).toBe(2);
      projector = create();
      await projector.start();
      await vi.waitFor(async () => expect((await f.projection.head()).seq).toBe(3), {
        timeout: 30000,
      });
      lateOpening = late.open(permit);
      void lateOpening.catch(() => {});
      await prechecked.promise;
      const sealId = crypto.randomUUID();
      await f.database.transaction().execute((tx) =>
        requestExecutionStreamSeal(tx, {
          tenantId: f.scope.tenantId,
          sessionId: f.scope.sessionId,
          turnId: f.scope.turnId,
          runId: f.scope.runId,
          agentId: "root",
          now: new Date(),
          eventId: sealId,
          recover: true,
        }),
      );
      const seal = (
        await f.database
          .selectFrom("outbox")
          .select("payload")
          .where("id", "=", sealId)
          .executeTakeFirstOrThrow()
      ).payload as AcceptedExecutionSealFact;
      await vi.waitFor(async () => expect((await readRun()).state).toBe("queued"), {
        timeout: 30000,
      });
      await expect(bus.append(fact(4))).rejects.toBeInstanceOf(Error);
      await expect(bus.append(fact(4))).rejects.toBeInstanceOf(Error);
      await expect(successor.open(permit)).rejects.toThrow("no longer current");
      const worker = await createTestWorker(f.database);
      const entered = Promise.withResolvers<ExecutionPublication>();
      execution = worker
        .executor({
          execute: async (_r, _l, admission) => {
            entered.resolve(admission.publication);
            await finished.promise;
            return { stopReason: "stop" };
          },
          finish: async () => {},
        })
        .dispatchRun(f.scope.runId);
      void execution.catch(entered.reject);
      const next = await entered.promise;
      expect(next.scope.runId).toBe(f.scope.runId);
      expect(next.scope.writerId).not.toBe(f.scope.writerId);
      expect(next.scope.fencingToken).toBe(2);
      await successor.open(next);
      // Replayed closed evidence must NOT initialize another producer and fence the successor.
      await projector.publishSeal(seal);
      const { leaseId: _lease, piConversationId: _conv, ...scope } = next.scope;
      await successor.append(fact(4, scope));
      await vi.waitFor(async () => expect((await f.projection.head()).seq).toBe(4), {
        timeout: 10000,
      });
      // Late cleanup from the old incarnation cannot drop the new writer.
      await successor.forget(f.scope);
      await successor.append(fact(5, scope));
      await vi.waitFor(async () => expect((await f.projection.head()).seq).toBe(5), {
        timeout: 10000,
      });
      // A delayed initializer passed its first PG check before closure. It fences
      // the current producer, then MUST fail its fresh post-init check.
      resumeLate.resolve();
      await expect(lateOpening).rejects.toThrow("no longer current");
      await expect(successor.append(fact(6, scope))).rejects.toBeInstanceOf(Error);
      await f.database.transaction().execute((tx) =>
        requestExecutionStreamSeal(tx, {
          tenantId: scope.tenantId,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          runId: scope.runId,
          agentId: "root",
          now: new Date(),
          eventId: crypto.randomUUID(),
          recover: true,
        }),
      );
      await vi.waitFor(async () => expect((await readRun()).state).toBe("queued"), {
        timeout: 30000,
      });
      const thirdWorker = await createTestWorker(f.database),
        thirdEntered = Promise.withResolvers<ExecutionPublication>();
      thirdExecution = thirdWorker
        .executor({
          execute: async (_r, _l, a) => {
            thirdEntered.resolve(a.publication);
            await finished.promise;
            return { stopReason: "stop" };
          },
          finish: async () => {},
        })
        .dispatchRun(scope.runId);
      void thirdExecution.catch(thirdEntered.reject);
      const finalPermit = await thirdEntered.promise;
      expect(finalPermit.scope.fencingToken).toBe(3);
      await third.open(finalPermit);
      const { leaseId: _l3, piConversationId: _c3, ...scope3 } = finalPermit.scope;
      await third.append(fact(6, scope3));
      await vi.waitFor(async () => expect((await f.projection.head()).seq).toBe(6), {
        timeout: 10000,
      });
      expect(
        (
          await sql<{
            count: string;
          }>`select count(*) from runs where tenant_id=${f.scope.tenantId}::uuid`.execute(
            f.database,
          )
        ).rows[0]!.count,
      ).toBe("1");
    } finally {
      resumeLate.resolve();
      await lateOpening?.catch(() => {});
      finished.resolve();
      await Promise.allSettled([execution, thirdExecution]);
      await Promise.allSettled([bus.close(), successor.close(), late.close(), third.close()]);
      await projector?.close();
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.close();
      await publicationDatabase.destroy();
      await f.close();
    }
  },
  180000,
);
