import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ToolReplyMailbox } from "@pi-cloud/event-log";
import { PostgresDurableSessionHost } from "@pi-cloud/pi-session-postgres/durable";
import { RemoteToolSandboxTurnRunner, SubagentControlClient } from "@pi-cloud/sandbox-supervisor";
import { WorkerToolRuntime } from "../../supervisor-host/src/tools/worker-tool-runtime.ts";
import { CloudModelRegistry } from "../../sandbox-supervisor/src/durable/model-registry.ts";
import { WorkerExecutionLog } from "../../runtime-core/src/worker-execution-log.ts";
import { DurableSessionPublisher } from "../../runtime-core/src/durable-session-publisher.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { ControlToolDispatcher } from "../src/control-tool-dispatcher.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { command as sample } from "../../sandbox-supervisor/test/fixtures/durable-command.ts";
import type { EventPublishMessage } from "@pi-cloud/protocol";
import { sql } from "kysely";

it.each([false, true])(
  "runs native Conversations under one grant and contains child publication failure (%s)",
  async (publicationFails) => {
    const f = await nativeSubagentFixture(),
      directory = await mkdtemp(join(tmpdir(), "pi-native-conversations-"));
    const childStarted = Promise.withResolvers<void>(),
      continueChild = Promise.withResolvers<void>();
    const parentWaiting = Promise.withResolvers<void>(),
      continueParent = Promise.withResolvers<void>();
    const provider = fauxProvider({
      provider: "openai-codex",
      models: [{ id: "gpt-6-luna", reasoning: true, contextWindow: 131072, maxTokens: 2048 }],
      tokensPerSecond: 1_000_000,
    });
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("subagent", { action: "run", task: "Child task", tools: [] }),
        { stopReason: "toolUse" },
      ),
      async () => {
        childStarted.resolve();
        await continueChild.promise;
        return fauxAssistantMessage("FIRST CHILD ANSWER");
      },
      fauxAssistantMessage("CHILD DONE"),
      async (context) => {
        expect(
          context.messages.some(
            (message) =>
              message.role === "toolResult" &&
              JSON.stringify(message.content).includes("CHILD DONE"),
          ),
        ).toBe(true);
        parentWaiting.resolve();
        if (!publicationFails) await continueParent.promise;
        return fauxAssistantMessage("ROOT DONE");
      },
    ]);
    const configure = vi
      .spyOn(CloudModelRegistry.prototype, "configure")
      .mockImplementation(function (this: CloudModelRegistry) {
        this.models.setProvider(provider.provider);
        return provider.getModel();
      });
    const replies = new ToolReplyMailbox(),
      native = new PostgresDurableSessionHost({ database: f.database });
    const projection = new ExecutionStreamProjector(f.database),
      events: EventPublishMessage[] = [];
    let runner!: RemoteToolSandboxTurnRunner,
      offset = 0n;
    const controller = new SubagentController({
      database: f.database,
      managementToken: "test-".repeat(10),
      allowInsecureHttp: true,
      deliver: async (_reference, request) => {
        if (request.action === "start_conversation") return runner.startConversation(request);
        if (request.action === "stop_conversation")
          return runner.stopConversation(request.executionReference, request.requestId);
        return runner.agentInput(
          request.runId,
          request.requestId,
          request.message,
          request.delivery,
          request.executionReference,
          request.conversationId,
        );
      },
    });
    const dispatcher = new ControlToolDispatcher({
      database: f.database,
      partitions: 1,
      ownsPartition: () => true,
      execute: (call, current) => controller.executeTool(call, current),
      publish: async (_topic, reply) => replies.accept(reply),
    });
    const log = new WorkerExecutionLog({
      checkHealth: async () => {},
      append: async (fact) => {
        const record = { fact, topic: "native-bridge", partition: 0, offset: offset++ };
        if (
          publicationFails &&
          fact.kind === "agent_event" &&
          fact.event.type === "turn.completed" &&
          fact.scope.sessionId !== f.scope.sessionId
        )
          throw new Error("Injected child publication ACK loss");
        await projection.project(record);
        await dispatcher.consume(record);
        return { factId: fact.factId, durable: true };
      },
    });
    const writer = await log.open({
      executionReference: f.reference,
      sessionId: f.scope.sessionId,
      turnId: f.scope.turnId,
      piSession: { id: f.scope.piSessionId, conversationId: 1, writerId: f.scope.writerId },
      nextEventSeq: 1,
      publication: { scope: { ...f.scope, leaseId: f.scope.writerId, piConversationId: 1 } },
    });
    const publisher = new DurableSessionPublisher({
      channels: log,
      replyTopic: "pi-cloud.tool-replies.v3.fixture",
    });
    const control = new SubagentControlClient(native, {
      topic: "pi-cloud.tool-replies.v3.fixture",
      wait: (...args) =>
        replies.wait(...args) as Promise<import("@pi-cloud/protocol").ToolResultPayload>,
    });
    const tools = new WorkerToolRuntime({
      nativeConversations: native,
      control,
      maximumDepth: null,
      wait: (id, callId, name, signal) =>
        replies.wait(id, callId, name, signal) as Promise<
          import("@pi-cloud/protocol").ToolResultPayload
        >,
    });
    const release = vi.fn(async () => {}),
      create = vi.fn(async () => {
        throw new Error("No VM should be needed");
      });
    runner = new RemoteToolSandboxTurnRunner({
      trustedWorkspaceDirectory: directory,
      runtimeIdentity: {
        supervisorId: "fixture",
        sandboxId: "fixture",
        bootId: crypto.randomUUID(),
      },
      broker: {
        create,
        release: async () => ({ retained: true }),
        refreshServices: async () => {},
        workflowUrlFor: () => "http://fixture.invalid",
      },
      conversations: native,
      openConversationLog: (command) => {
        const p = command.payload;
        const view = log.openConversation(p.executionReference, {
          conversationId: p.piSession.conversationId,
          sessionId: p.sessionId,
          turnId: p.turnId,
          nextEventSeq: p.nextEventSeq,
        });
        return {
          publish: async (event) => {
            events.push(event);
            await view.ingest(event);
          },
          close: () => view.close(),
        };
      },
      openAgentSession: (command) => {
        const p = command.payload;
        return native.open({
          binding: {
            tenantId: p.tenantId,
            piSessionId: p.piSession.id,
            conversationId: p.piSession.conversationId,
            sessionId: p.sessionId,
            turnId: p.turnId,
            runId: p.runId,
            executionReference: p.executionReference,
            writerId: p.piSession.writerId,
          },
          publish: (value) => publisher.scoped(p.executionReference).publish(value),
        });
      },
      createTrustedTools: (command, context) => tools.create({ command, ...context }),
      modelRuntimeLeaseResolver: () => ({
        runtime: {
          kind: "openai_compatible_gateway",
          provider: "openai-codex",
          modelId: "gpt-6-luna",
          baseUrl: "http://model.invalid",
          api: "openai-codex-responses",
          capability: "fixture-local-model",
          reasoning: true,
          contextWindow: 131072,
          autoCompactTokenLimit: 100000,
          maxTokens: 2048,
          inputModalities: ["text"],
          hostedTools: [],
          serviceTier: null,
          requestTimeoutMs: 5000,
          turnTimeoutMs: 15000,
        },
        release,
      }),
      turnTimeoutMs: 15000,
    });
    const command = structuredClone(sample);
    Object.assign(command.payload, {
      tenantId: f.scope.tenantId,
      sessionId: f.scope.sessionId,
      turnId: f.scope.turnId,
      runId: f.scope.runId,
      executionReference: f.reference,
      toolCapabilities: [],
      input: { kind: "prompt", text: "Delegate a child" },
      piSession: { id: f.scope.piSessionId, conversationId: 1, writerId: f.scope.writerId },
    });
    Object.assign(command.payload.model, { provider: "openai-codex", modelId: "gpt-6-luna" });
    try {
      const work = runner.run(
        command,
        async (event) => {
          events.push(event);
          await writer.ingest(event);
        },
        new AbortController().signal,
      );
      void work.catch(() => {});
      await Promise.race([
        childStarted.promise,
        work.then(() => {
          throw new Error("Child did not start");
        }),
      ]);
      let conversationId = 0;
      await vi.waitFor(async () => {
        const child = await f.database
          .selectFrom("subagent_conversations as v")
          .innerJoin("sessions as s", "s.id", "v.child_session_id")
          .select("s.pi_conversation_id")
          .executeTakeFirstOrThrow();
        expect(child.pi_conversation_id).not.toBeNull();
        conversationId = Number(child.pi_conversation_id);
      });
      const messageId = crypto.randomUUID();
      expect(
        await runner.agentInput(
          f.scope.runId,
          messageId,
          "Additional child context",
          "follow_up",
          f.reference,
          conversationId,
        ),
      ).toEqual({ accepted: true });
      continueChild.resolve();
      if (publicationFails)
        await expect(work).rejects.toMatchObject({ code: "writer_publication_failed" });
      else {
        await Promise.race([
          parentWaiting.promise,
          work.then(() => {
            throw new Error("Parent did not wait");
          }),
        ]);
        expect(
          await runner.agentInput(
            f.scope.runId,
            messageId,
            "Additional child context",
            "follow_up",
            f.reference,
            conversationId,
          ),
        ).toEqual({ accepted: true });
        expect(
          await runner.agentInput(
            f.scope.runId,
            crypto.randomUUID(),
            "Late input",
            "follow_up",
            f.reference,
            conversationId,
          ),
        ).toEqual({ accepted: false });
        const receipts = await sql<{ n: string }>`select count(*)::text n from pi_durable_records
        where tenant_id=${f.scope.tenantId}::uuid and session_id=${f.scope.piSessionId} and kind='submission'
          and fields->>'request'=${JSON.stringify(messageId)}`.execute(f.database);
        expect(receipts.rows[0]!.n).toBe("1");
        continueParent.resolve();
        expect(await work).toMatchObject({ stopReason: "stop" });
        expect(provider.state.callCount).toBe(4);
      }
      expect(release).toHaveBeenCalledTimes(2);
      expect(native.hasExecution(f.reference)).toBe(false);
      const children = await f.database.selectFrom("subagent_executions").selectAll().execute();
      expect(children).toHaveLength(1);
      expect(children[0]!.state).toBe("completed");
      expect(await f.database.selectFrom("runs").select("id").execute()).toHaveLength(1);
      expect(
        events.some(
          ({ payload }) =>
            payload.event.sessionId === children[0]!.child_session_id &&
            payload.event.type === "turn.completed",
        ),
      ).toBe(true);
      expect(create).not.toHaveBeenCalled();
    } finally {
      continueChild.resolve();
      continueParent.resolve();
      configure.mockRestore();
      replies.close();
      await dispatcher.close();
      await controller.close();
      await native.close();
      await publisher.close();
      await log.close().catch((error) => {
        if (!publicationFails) throw error;
      });
      await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
