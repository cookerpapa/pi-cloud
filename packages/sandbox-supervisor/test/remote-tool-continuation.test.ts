import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { MemoryStorage, type StorageWrite, type Seq } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { DurableSessionCommit } from "@pi-cloud/protocol";
import { DurableAgentSession } from "../src/durable/agent-session.ts";
import { fixedRemoteToolDefinitions } from "../src/fixed-remote-tool-definitions.ts";

it("Pi re-enters only the acknowledged proxy wait and commits the original Tool result once", async () => {
  const models = createModels(),
    provider = fauxProvider({ tokensPerSecond: 1_000_000 });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "echo once" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("DONE"),
  ]);
  const started = Promise.withResolvers<void>();
  let runtime: DurableAgentSession | undefined,
    dispatched = 0,
    reattached = 0;
  const journal: StorageWrite[][] = [];
  const storage = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
      const pending = this.prepareCommit(writes);
      const effects = runtime?.preparePublication({
        seq: pending.seq,
        nextId: 10000,
        writes: pending.writes,
      } as unknown as DurableSessionCommit);
      const seq = pending.apply();
      journal.push(structuredClone([...writes]));
      dispatched += effects?.tools.length ?? 0;
      effects?.confirmed();
      return seq;
    }
  })();
  const operationId = randomUUID(),
    bindingId = randomUUID(),
    runId = randomUUID();
  const definition = fixedRemoteToolDefinitions().find((tool) => tool.name === "bash")!;
  const options = {
    models,
    remoteTools: [definition],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  };
  const binding = {
    runId,
    conversationId: 1,
    model: provider.getModel(),
    agent: {},
    context: {},
    tools: [],
    remoteTools: () => ["bash"],
    assertCurrent: async () => {},
    openModel: async ({ options }: { options: object }) => ({
      model: provider.getModel(),
      options,
      release() {},
    }),
    prepareRemote: async (
      invocation: import("../src/durable/remote-tools.ts").RemoteInvocation,
    ) => {
      const cancelled = new AbortController();
      const abort = () => cancelled.abort();
      invocation.context.abortSignal?.addEventListener("abort", abort, { once: true });
      if (invocation.recovery) reattached++;
      return {
        command: {
          executionReference: "fixture",
          toolCallId: `task:${invocation.taskId}`,
          occurredAt: new Date().toISOString(),
          request: {
            operation: "tool.execute",
            operationId,
            activationId: bindingId,
            toolCallId: invocation.callId,
            toolName: "bash",
            args: invocation.args,
          },
          ...(invocation.recovery
            ? {
                replyRecovery: {
                  topic: `pi-cloud.tool-replies.v4.${randomUUID()}`,
                  partition: 0,
                  offset: "0",
                  deadlineAt: Date.now() + 10000,
                  toolCallId: invocation.callId,
                  toolName: "bash",
                },
              }
            : {}),
        },
        completed: () => !!invocation.recovery,
        dispose() {
          cancelled.abort();
          invocation.context.abortSignal?.removeEventListener("abort", abort);
        },
        result: async () => {
          if (invocation.recovery) return { content: [{ type: "text", text: "ORIGINAL RESULT" }] };
          started.resolve();
          return new Promise<never>((_resolve, reject) => {
            cancelled.signal.addEventListener("abort", () => reject(new Error("worker exited")), {
              once: true,
            });
          });
        },
      };
    },
  };
  let prefix: StorageWrite[][] = [];
  runtime = await DurableAgentSession.open(storage, options);
  try {
    const root = await runtime.bind(binding as never);
    const pending = await root.submit(
      { type: "input", content: "Run it", requestId: runId },
      context,
    );
    void pending.wait(context).catch(() => {});
    await started.promise;
    prefix = structuredClone(journal);
    expect(dispatched).toBe(1);
    expect(
      prefix
        .flat()
        .some(
          (w) =>
            w.type === "task" &&
            w.value.kind === "pi.tool" &&
            w.value.state.status === "running" &&
            (w.value.state.checkpoint as { replay?: string }).replay === "safe",
        ),
    ).toBe(true);
  } finally {
    await runtime.close();
    runtime = undefined;
  }
  const restored = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], _ctx: Context): Promise<Seq> {
      const prepared = this.prepareCommit(writes);
      const effects = runtime?.preparePublication({
        seq: prepared.seq,
        nextId: 10000,
        writes: prepared.writes,
      } as unknown as DurableSessionCommit);
      const seq = prepared.apply();
      dispatched += effects?.tools.length ?? 0;
      effects?.confirmed();
      return seq;
    }
  })();
  for (const writes of prefix) await restored.commit(writes, context);
  runtime = await DurableAgentSession.open(restored, options);
  try {
    const root = await runtime.bind(binding as never, "reattach");
    runtime.harness.resume();
    await root.waitForIdle(context);
    const messages = (await root.context(context)).messages;
    expect(reattached).toBe(1);
    expect(dispatched).toBe(1);
    expect(messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("ORIGINAL RESULT");
    expect(JSON.stringify(messages)).toContain("DONE");
  } finally {
    await runtime.close();
  }
}, 30000);
