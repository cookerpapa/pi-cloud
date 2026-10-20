import { DirectSessionKafkaBus } from "../../runtime-core/src/direct-session-kafka.ts";
import { Admin } from "@platformatic/kafka";
import { expect, it, vi } from "vitest";
import { SessionProjector } from "../../runtime-core/src/session-projector.ts";
import { ControlToolDispatcher } from "../src/control-tool-dispatcher.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import type { ToolReply } from "@pi-cloud/event-log";
import { KafkaToolReplyMailbox, KafkaToolReplyPublisher } from "@pi-cloud/event-log";
import { requestExecutionStreamSeal } from "../../runtime-core/src/execution-stream-seal.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { PostgresDurableSessionHost } from "@pi-cloud/pi-session-postgres/durable";
import { createExecutionReference } from "@pi-cloud/protocol";
import type {
  DurableControlToolDispatch,
  ExecutionPublication,
} from "@pi-cloud/runtime-core/accepted-fact";
import { sql } from "kysely";

const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
it.skipIf(!postgres || !brokers)(
  "recovers control Tools from native commits and wakes waits through the same Kafka Projector",
  async () => {
    const f = await nativeSubagentFixture(),
      topic = `native-controls-${crypto.randomUUID()}`;
    const admin = new Admin({ clientId: topic, bootstrapBrokers: brokers! });
    const queries: string[] = [];
    const inFlightQueries = new Set<unknown>();
    const consumedCommits = new Set<number>();
    let observedWake = 0;
    let executingHandlers = 0;
    const measured = f.database.withPlugin({
      transformQuery({ node, queryId }) {
        inFlightQueries.add(queryId);
        queries.push(f.database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result, queryId }) {
        inFlightQueries.delete(queryId);
        return result;
      },
    });
    let projector: SessionProjector | undefined;
    const bus = new DirectSessionKafkaBus({
      database: f.database,
      brokers: brokers!,
      topic,
      clientId: topic,
      partitions: 1,
      replicas: 3,
    });
    const replies = new Map<string, ToolReply>();
    const replyPublisher = new KafkaToolReplyPublisher(brokers!, topic);
    const mailboxes: KafkaToolReplyMailbox[] = [];
    const executions: Promise<unknown>[] = [];
    const finished = Promise.withResolvers<void>();
    const nativeHost = new PostgresDurableSessionHost({ database: f.database });
    let dropReply = false;
    let waitingHandlers = 0;
    const controller = new SubagentController({
      database: measured,
      managementToken: "fixture-".repeat(8),
      allowInsecureHttp: true,
      deliver: async (_lease, request) => {
        if (request.action === "start_conversation") return f.native.start(request);
        if (request.action === "stop_conversation")
          return f.native.stop(request.executionReference, request.requestId);
      },
    });
    const createDispatcher = () =>
      new ControlToolDispatcher({
        database: measured,
        partitions: 1,
        ownsPartition: (partition) => projector?.ownsPartition(partition) === true,
        execute: async (command, current) => {
          executingHandlers++;
          try {
            const result = await controller.executeTool(command, current);
            if (current() && "waiting" in result) waitingHandlers++;
            return result;
          } finally {
            executingHandlers--;
          }
        },
        publish: async (replyTopic, reply) => {
          if (dropReply) throw new Error("Injected loss before mailbox publication");
          replies.set(reply.operationId, reply);
          if (mailboxes.some((mailbox) => mailbox.topic === replyTopic))
            await replyPublisher.publish(replyTopic, reply);
        },
      });
    let dispatcher = createDispatcher();
    try {
      await replyPublisher.start();
      projector = new SessionProjector({
        database: f.database,
        publicationDatabase: f.database,
        notificationConnectionString: f.url,
        brokers: brokers!,
        topic,
        clientId: topic,
        partitions: 1,
        replicas: 3,
        retentionMs: 600000,
        publicationToken: "fixture-".repeat(8),
        advertisedBaseUrl: "http://127.0.0.1:9",
        toolCommands: { consume: async () => {} },
        controlTools: {
          consume: async (record, current) => {
            if (current?.() !== false) observedWake++;
            await dispatcher.consume(record, current);
            if (current?.() !== false && record.fact.kind === "durable_commit")
              consumedCommits.add(record.fact.commit.seq);
          },
          close: () => dispatcher.close(),
        },
        controlChanges: {
          load: (partitions, current) => dispatcher.recover(partitions, current),
          reset: () => dispatcher.reset(),
          prepare: async () => {},
          consume: async (change, current) => {
            if (current()) {
              observedWake++;
              dispatcher.wake(change.scope.tenantId, change.scope.piSessionId);
            }
          },
        },
      });
      await projector.start();
      await vi.waitFor(() => expect(projector!.ownsPartition(0)).toBe(true), { timeout: 30_000 });
      await bus.open({
        scope: { ...f.scope, leaseId: f.scope.writerId, piConversationId: 1 },
      });
      f.setPublisher(async (fact) => {
        await bus.append(fact);
        await vi.waitFor(
          async () =>
            expect((await f.projection.head()).seq).toBeGreaterThanOrEqual(fact.commit.seq),
          { timeout: 10_000 },
        );
        // PG materialization precedes control consumption. A late, legitimate
        // creation wake must settle before measuring an otherwise idle wait.
        await vi.waitFor(() => expect(consumedCommits.has(fact.commit.seq)).toBe(true), {
          timeout: 10_000,
        });
      });
      const command = await f.command({ task: "A native child" });
      await vi.waitFor(() => expect(f.children.has(command.operationId)).toBe(true), {
        timeout: 10_000,
      });
      expect(replies.has(command.operationId)).toBe(false);
      await vi.waitFor(
        () => {
          expect(waitingHandlers).toBeGreaterThan(0);
          expect(executingHandlers).toBe(0);
          expect(inFlightQueries.size).toBe(0);
        },
        { timeout: 10_000 },
      );
      const settledWaits = waitingHandlers;
      // A replacement Projector's in-memory wait list is reconstructed from the
      // same native Task and commit header, not another command queue.
      dispatcher.reset();
      await dispatcher.recover([0], () => true);
      await vi.waitFor(
        () => {
          expect(waitingHandlers).toBeGreaterThan(settledWaits);
          expect(executingHandlers).toBe(0);
          expect(inFlightQueries.size).toBe(0);
        },
        { timeout: 10_000 },
      );
      // Native projection and its PG control-change publication are distinct
      // ordered records. Restart the bounded observation window only for an
      // actually observed wake, never merely because an unexplained query ran.
      let quiet = false;
      const deadline = performance.now() + 15000;
      while (performance.now() < deadline) {
        await vi.waitFor(
          () => {
            expect(executingHandlers).toBe(0);
            expect(inFlightQueries.size).toBe(0);
          },
          { timeout: 10000 },
        );
        const wake = observedWake;
        queries.length = 0;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (wake !== observedWake) continue;
        expect(queries).toEqual([]);
        quiet = true;
        break;
      }
      expect(quiet).toBe(true);
      await f.settle(command.operationId);
      await vi.waitFor(() => expect(replies.has(command.operationId)).toBe(true), {
        timeout: 10_000,
      });
      const reply = replies.get(command.operationId)!;
      expect(reply).toMatchObject({
        kind: "tool_result",
        result: { isError: false, toolName: "subagent" },
      });
      expect(await f.database.selectFrom("runs").select("id").execute()).toHaveLength(1);

      // The caller never committed this reply. Replace the Worker twice through
      // the real ordered seal + PG claim path; each new mailbox must receive the
      // original outcome without another child/input or adopting the old mailbox.
      for (let incarnation = 0; incarnation < 2; incarnation++) {
        const oldScope = { ...f.scope };
        await f.database.transaction().execute((tx) =>
          requestExecutionStreamSeal(tx, {
            ...f.scope,
            agentId: "root",
            now: new Date(),
            eventId: crypto.randomUUID(),
            recover: true,
          }),
        );
        await vi.waitFor(
          async () => {
            const run = await f.database
              .selectFrom("runs")
              .select("state")
              .where("id", "=", f.scope.runId)
              .executeTakeFirstOrThrow();
            expect(run.state).toBe("queued");
          },
          { timeout: 30000 },
        );
        await bus.forget(oldScope);
        const worker = await createTestWorker(f.database);
        const entered = Promise.withResolvers<ExecutionPublication>();
        const execution = worker
          .executor({
            execute: async (_request, _life, admission) => {
              entered.resolve(admission.publication);
              await finished.promise;
              return { stopReason: "stop" };
            },
            finish: async () => {},
          })
          .dispatchRun(f.scope.runId);
        void execution.catch(entered.reject);
        executions.push(execution);
        const publication = await entered.promise;
        Object.assign(f.scope, {
          writerId: publication.scope.writerId,
          fencingToken: publication.scope.fencingToken,
        });
        await bus.open(publication);
        const reference = createExecutionReference(
          f.scope.writerId,
          f.scope.runId,
          f.scope.fencingToken,
        );
        const handle = await nativeHost.open({
          binding: { ...f.scope, conversationId: 1, executionReference: reference },
          publish: async () => {
            throw new Error("Read-only host fixture");
          },
        });
        const original = await nativeHost.originalControlIntent(reference, 1, command.taskId);
        expect(original).toMatchObject({
          operationId: command.operationId,
          sequence: command.nativeSequence,
          arguments: { task: "A native child" },
        });
        await handle.close();
        const mailbox = new KafkaToolReplyMailbox({
          brokers: brokers!,
          bootId: crypto.randomUUID(),
          replicas: 3,
        });
        mailboxes.push(mailbox);
        await mailbox.start();
        const operationId = crypto.randomUUID(),
          documentId = f.allocateId();
        const wait = mailbox.wait(
          operationId,
          command.nativeCallId,
          "subagent",
          AbortSignal.timeout(15000),
        );
        const recovery: DurableControlToolDispatch = {
          target: "control",
          operationId,
          taskId: command.taskId,
          conversationId: 1,
          toolName: "subagent",
          contextAnchor: null,
          replyTopic: mailbox.topic,
          scope: { ...f.scope },
          recovery: { sequence: original.sequence, operationId: original.operationId, documentId },
        };
        // Lost response followed by Projector replacement must reconstruct the
        // same reference and resolve the original answer, not rerun creation.
        dropReply = true;
        const before = waitingHandlers;
        await f.append(
          [
            {
              type: "document.create",
              record: {
                id: documentId,
                kind: "pi-cloud.tool-recovery",
                scope: { kind: "task", taskId: command.taskId },
                key: operationId,
              },
              content: {
                kind: "base",
                version: 1,
                value: { sequence: original.sequence, operationId: original.operationId },
              },
            },
          ],
          undefined,
          { controlTools: [recovery] },
        );
        await vi.waitFor(() => expect(executingHandlers).toBe(0));
        await dispatcher.close();
        dispatcher = createDispatcher();
        dropReply = false;
        await dispatcher.recover([0], () => true);
        const recovered = await wait.result;
        expect(recovered).toMatchObject({ toolName: "subagent", isError: false });
        expect(JSON.stringify(recovered)).toContain("Child answer");
        expect(f.children.size).toBe(1);
        expect(waitingHandlers).toBe(before);
        const submissions = await sql`select id from pi_durable_current
          where tenant_id=${f.scope.tenantId}::uuid and session_id=${f.scope.piSessionId}
            and kind='submission'`.execute(f.database);
        expect(submissions.rows).toHaveLength(1);
      }
      await f.finishCall(command);
      await dispatcher.close();
      dispatcher = createDispatcher();
      replies.clear();
      await dispatcher.recover([0], () => true);
      expect(replies.size).toBe(0);
    } finally {
      finished.resolve();
      await Promise.allSettled(executions);
      await nativeHost.close();
      await bus.close();
      await projector?.close();
      await dispatcher.close();
      await controller.close();
      await Promise.allSettled(mailboxes.map((mailbox) => mailbox.shutdown()));
      await replyPublisher.close();
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.close();
      await f.close();
    }
  },
  150_000,
);
