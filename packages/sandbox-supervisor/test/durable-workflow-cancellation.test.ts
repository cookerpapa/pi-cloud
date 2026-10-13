import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MemoryStorage, type Seq, type StorageWrite } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { CandidateToolCommand, DurableSessionCommit } from "@pi-cloud/protocol";
import { DurableAgentSession } from "../src/durable/agent-session.ts";

it.each([false, true])(
  "co-commits workflow intent and only cancels unfinished physical work (%s)",
  async (completed) => {
    const models = createModels(),
      provider = fauxProvider({ tokensPerSecond: 1000000 });
    models.setProvider(provider.provider);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("workflow", { script: "return 1" }), {
        stopReason: "toolUse",
      }),
    ]);
    let runtime!: DurableAgentSession;
    const started = Promise.withResolvers<void>();
    const cancels: string[] = [],
      commands: CandidateToolCommand[] = [];
    const dispose = vi.fn();
    const storage = new (class extends MemoryStorage {
      override async commit(writes: readonly StorageWrite[], _ctx: Context): Promise<Seq> {
        const commit = this.prepareCommit(writes);
        const effects = runtime?.preparePublication({
          seq: commit.seq,
          nextId: 1000,
          writes: commit.writes,
        } as unknown as DurableSessionCommit);
        for (const { command } of effects?.tools ?? []) {
          if (!("request" in command)) throw Error("Expected workflow command");
          commands.push(command);
          started.resolve();
        }
        for (const cancellation of effects?.cancellations ?? [])
          cancels.push(cancellation.operationId);
        effects?.confirmed();
        return commit.apply();
      }
    })();
    runtime = await DurableAgentSession.open(storage, {
      models,
      remoteTools: [
        {
          name: "workflow",
          description: "fixture",
          parameters: Type.Object({ script: Type.String() }),
        },
      ],
      settings: { compaction: { enabled: false } },
    });
    try {
      const conversation = await runtime.bind({
        runId: randomUUID(),
        conversationId: 1,
        model: provider.getModel(),
        agent: {},
        context: {},
        remoteTools: ["workflow"],
        tools: [],
        assertCurrent: async () => {},
        openModel: async ({ options }) => ({ model: provider.getModel(), options, release() {} }),
        prepareRemote: async (invocation) => ({
          command: {
            executionReference: "owner",
            toolCallId: "task:" + invocation.taskId,
            nativeToolName: "workflow",
            request: {
              operation: "workflow.exec",
              toolName: "bash",
              toolCallId: invocation.callId,
              script: invocation.args.script,
              activationId: "binding",
              operationId: "operation",
            },
          } as CandidateToolCommand,
          completed: () => completed,
          dispose,
          result: async () => awaitWithContext(new Promise<never>(() => {}), invocation.context),
        }),
      });
      await conversation.submit({ type: "input", content: "run" }, context);
      await started.promise;
      await conversation.abort(context);
      expect(commands).toHaveLength(1);
      expect(cancels).toEqual(completed ? [] : ["operation"]);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  },
);
