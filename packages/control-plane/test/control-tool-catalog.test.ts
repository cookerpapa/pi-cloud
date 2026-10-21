import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MemoryStorage, type Seq, type StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ToolReplyMailbox } from "@pi-cloud/event-log";
import {
  createExecutionReference,
  type ControlToolCatalogDefinition,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import { DurableAgentSession } from "../../sandbox-supervisor/src/durable/agent-session.ts";
import { withToolInvocation, type PreparedAgentTool } from "@pi-cloud/sandbox-supervisor";
import { WorkerToolRuntime } from "../../supervisor-host/src/tools/worker-tool-runtime.ts";
import { WorkerToolCatalog } from "../../supervisor-host/src/tools/worker-tool-catalog.ts";
import { restoreToolReply } from "../../supervisor-host/src/tool-reply-result.ts";
import { ControlToolRegistry, controlToolCatalog } from "../src/control-tool-registry.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";

const definition = (name: string): ControlToolCatalogDefinition => ({
  name,
  description: `Perform ${name}`,
  requiresEnvironment: false,
  parameters: { type: "object", properties: {}, additionalProperties: false },
});

it("retains the last valid Worker catalog and rejects collisions without installing executable code", () => {
  const worker = new WorkerToolCatalog();
  expect(worker.ready).toBe(false);
  const snapshot = controlToolCatalog([definition("new_tool")]);
  worker.update(snapshot);
  const changed = vi.fn();
  const stop = worker.subscribe(changed);
  worker.update(snapshot);
  expect(changed).not.toHaveBeenCalled();
  expect(() => worker.update({ ...snapshot, revision: "0".repeat(64) })).toThrow("revision");
  expect(() => controlToolCatalog([definition("bash")])).toThrow("fixed native");
  expect(worker.read()).toEqual(snapshot);
  stop();
});

it("turns oversized completed ordinary results into a bounded error instead of retrying effects", async () => {
  const registry = new ControlToolRegistry();
  const execute = vi.fn(async () => ({
    result: { content: [{ type: "text" as const, text: "x".repeat(60 * 1024) }] },
  }));
  registry.register({ definition: definition("large_result"), execute });
  const result = await registry.execute(
    { toolName: "large_result", nativeCallId: "call", arguments: {} } as AcceptedControlToolCommand,
    () => true,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("effects may already have occurred");
  expect(JSON.stringify(result).length).toBeLessThan(1000);
  expect(execute).toHaveBeenCalledOnce();
});

it("adds and withdraws an unknown Tool within one native submission while retaining an accepted result", async () => {
  const server = new ControlToolRegistry(),
    worker = new WorkerToolCatalog();
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  server.register({
    definition: definition("wait_gate"),
    async execute() {
      started.resolve();
      await release.promise;
      return { result: { content: [{ type: "text", text: "gate complete" }] } };
    },
  });
  worker.update(server.read());
  const disconnect = server.subscribe(() => worker.update(server.read()));
  const mailbox = new ToolReplyMailbox();
  const runId = randomUUID(),
    writerId = randomUUID();
  const executionReference = createExecutionReference(writerId, runId, 1);
  const command = {
    payload: {
      sessionKind: "conversation",
      tenantId: "tenant",
      sessionId: "session",
      runId,
      executionReference,
      piSession: { conversationId: 1 },
    },
  } as import("@pi-cloud/protocol").ExecuteTurnCommandMessage;
  const tools = new WorkerToolRuntime({
    catalog: worker,
    maximumDepth: null,
    nativeConversations: {
      childAnchor: async () => {
        throw new Error("Ordinary Tools do not read native ancestry");
      },
      conversationDepth: async () => 0,
      originalControlIntent: async () => {
        throw new Error("No safe Tool replay");
      },
    },
    control: {
      request: async () => {
        throw new Error("No child command");
      },
    },
    wait: (id, callId, name, signal, scope) =>
      restoreToolReply(mailbox.wait(id, callId, name, signal), undefined, scope, signal),
  });
  const bindings = await tools.create({
    command,
    prepareEnvironment: async () => {
      throw new Error("No guest required");
    },
    prepareWorkflow: async () => {
      throw new Error("No workflow");
    },
  });
  const definitions = () => bindings.current().map((item) => item.tool);
  let runtime: DurableAgentSession | undefined;
  const failures: unknown[] = [];
  const storage = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
      const prepared = this.prepareCommit(writes);
      const effects = runtime?.preparePublication({
        seq: prepared.seq,
        nextId: 100,
        writes: prepared.writes,
      } as unknown as DurableSessionCommit);
      const result = prepared.apply();
      effects?.confirmed();
      for (const { taskId, command: call } of effects?.tools ?? []) {
        if (!("target" in call) || call.target !== "control")
          throw new Error("Expected control transport");
        // The same native intent is acknowledged before executing the handler.
        const accepted: AcceptedControlToolCommand = {
          kind: "control_tool",
          target: "control",
          taskId,
          nativeSequence: Number(result),
          operationId: call.operationId,
          conversationId: call.conversationId,
          toolName: call.toolName,
          contextAnchor: call.contextAnchor,
          nativeCallId: call.nativeCallId,
          arguments: call.arguments,
          replyTopic: "fixture-replies",
          scope: {
            tenantId: "tenant",
            sessionId: "session",
            runId,
            writerId,
            piSessionId: "physical",
            turnId: "turn",
            fencingToken: 1,
          },
        };
        void server
          .execute(accepted, () => true)
          .then((outcome) =>
            mailbox.accept({
              kind: "tool_result",
              sequence: 1,
              operationId: call.operationId,
              result: {
                toolCallId: call.nativeCallId,
                toolName: call.toolName,
                isError: outcome.isError ?? false,
                result: {
                  ...outcome.result,
                  content: outcome.result.content.map((block) => {
                    if (block.type !== "text")
                      throw new Error("Catalog fixture expects text results");
                    return block;
                  }),
                },
              },
            }),
          )
          .catch((error) => failures.push(error));
      }
      return result;
    }
  })();
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const requests: { names: string[]; text: string }[] = [];
  faux.setResponses(
    ["wait_gate", "new_tool", "new_tool", null].map((name) => (input) => {
      requests.push({
        names: getCurrentTools(input.messages).map((tool) => tool.name),
        text: JSON.stringify(input.messages),
      });
      return name
        ? fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: "toolUse" })
        : fauxAssistantMessage("DONE");
    }),
  );
  runtime = await DurableAgentSession.open(storage, {
    models,
    remoteTools: definitions(),
    remoteToolUpdates: { current: definitions, subscribe: worker.subscribe.bind(worker) },
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  });
  const conversation = await runtime.bind({
    runId,
    conversationId: 1,
    model: faux.getModel(),
    agent: {},
    context: {},
    remoteTools: bindings
      .current()
      .filter((item) => item.offered !== false)
      .map((item) => item.tool.name),
    tools: [],
    assertCurrent: async () => {},
    openModel: async (request) => ({
      model: faux.getModel(),
      options: request.options,
      release() {},
    }),
    prepareRemote: (invocation) =>
      withToolInvocation(
        { id: `task:${invocation.taskId}`, nativeToolCallId: invocation.callId },
        () => {
          const tool = bindings.current().find((item) => item.tool.name === invocation.toolName)
            ?.tool as PreparedAgentTool | undefined;
          if (!tool?.prepareExecution) throw new Error("Tool unavailable");
          return tool.prepareExecution(
            invocation.callId,
            invocation.args,
            invocation.context.abortSignal,
          );
        },
      ),
  });
  let calls = 0;
  try {
    const input = await conversation.submit(
      { type: "input", content: "Use the tool catalog", requestId: "catalog-work" },
      context,
    );
    await started.promise;
    const withdraw = server.register({
      definition: definition("new_tool"),
      async execute() {
        calls++;
        withdraw();
        return {
          result: { content: [{ type: "text", text: "ACCEPTED_RESULT_AFTER_WITHDRAWAL" }] },
        };
      },
    });
    release.resolve();
    expect((await input.wait(context)).status).toBe("done");
    expect(failures).toEqual([]);
    expect(requests).toHaveLength(4);
    expect(requests[0]!.names).not.toContain("new_tool");
    expect(requests[1]!.names).toContain("new_tool");
    expect(requests[2]!.names).not.toContain("new_tool");
    expect(requests[2]!.text).toContain("ACCEPTED_RESULT_AFTER_WITHDRAWAL");
    expect(requests[3]!.text).toContain("is not available");
    expect(requests.every((request) => !request.names.includes("contact_supervisor"))).toBe(true);
    expect(calls).toBe(1);
    const history = await conversation.context(context);
    expect(
      history.messages.filter(
        (message) => message.role === "system" && (message.toolsAdded || message.toolsRemoved),
      ),
    ).toHaveLength(3);
    expect(
      await server.execute(
        { toolName: "new_tool", arguments: {} } as AcceptedControlToolCommand,
        () => true,
      ),
    ).toMatchObject({ isError: true });
  } finally {
    release.resolve();
    disconnect();
    await runtime.close();
    mailbox.close();
  }
}, 15_000);
