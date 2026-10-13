import { DirectSessionKafkaBus } from "../../runtime-core/src/direct-session-kafka.ts";
import { Admin } from "@platformatic/kafka";
import { expect, it, vi } from "vitest";
import { SessionProjector } from "../../runtime-core/src/session-projector.ts";
import { ControlToolDispatcher } from "../src/control-tool-dispatcher.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import type { ToolReply } from "@pi-cloud/event-log";

const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
it.skipIf(!postgres || !brokers)(
  "recovers control Tools from native commits and wakes waits through the same Kafka Projector",
  async () => {
    const f = await nativeSubagentFixture(),
      topic = `native-controls-${crypto.randomUUID()}`;
    const admin = new Admin({ clientId: topic, bootstrapBrokers: brokers! });
    const queries: string[] = [];
    const measured = f.database.withPlugin({
      transformQuery({ node, queryId }) {
        queries.push(f.database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
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
    const dispatcher = new ControlToolDispatcher({
      database: measured,
      partitions: 1,
      ownsPartition: (partition) => projector?.ownsPartition(partition) === true,
      execute: (command, current) => controller.executeTool(command, current),
      publish: async (_topic, reply) => {
        replies.set(reply.operationId, reply);
      },
    });
    try {
      projector = new SessionProjector({
        database: f.database,
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
        controlTools: dispatcher,
        controlChanges: {
          load: (partitions, current) => dispatcher.recover(partitions, current),
          reset: () => dispatcher.reset(),
          prepare: async () => {},
          consume: async (change, current) => {
            if (current()) dispatcher.wake(change.scope.tenantId, change.scope.piSessionId);
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
      });
      const command = await f.command({ action: "run", task: "A native child" });
      await vi.waitFor(() => expect(f.children.has(command.operationId)).toBe(true), {
        timeout: 10_000,
      });
      expect(replies.has(command.operationId)).toBe(false);
      // A replacement Projector's in-memory wait list is reconstructed from the
      // same native Task and commit header, not another command queue.
      dispatcher.reset();
      await dispatcher.recover([0], () => true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      queries.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(queries).toEqual([]);
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
    } finally {
      await bus.close();
      await projector?.close();
      await dispatcher.close();
      await controller.close();
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.close();
      await f.close();
    }
  },
  60_000,
);
