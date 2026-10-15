// Audits actual pinned Pi Tool commit grouping with a deterministic in-process model.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { MemoryStorage, type StorageWrite, type Seq } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import {
  createExecutionReference,
  type DurableSessionCommit,
  type CandidateToolCommand,
} from "@pi-cloud/protocol";
import { DurableAgentSession } from "../../../packages/sandbox-supervisor/src/durable/agent-session.ts";
import type { RemoteInvocation } from "../../../packages/sandbox-supervisor/src/durable/remote-tools.ts";

async function fixture(options: { hold?: boolean; invalid?: boolean; duplicate?: boolean } = {}) {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const call = fauxToolCall("read", options.invalid ? {} : { path: "first.txt" });
  faux.setResponses([
    fauxAssistantMessage(
      options.duplicate ? [call, fauxToolCall("read", { path: "second.txt" })] : call,
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage("DONE"),
  ]);
  let runtime: DurableAgentSession | undefined;
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<import("@earendil-works/pi-durable").ToolExecutionResult>();
  const effectBatches: { seq: number; tools: number; cancellations: number }[] = [];
  const commits: StorageWrite[][] = [],
    commands: CandidateToolCommand[] = [],
    cancels: string[] = [];
  let preparedCount = 0,
    received = false;
  const store = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
      const prepared = this.prepareCommit(writes);
      const effects = runtime?.remote.preparePublication({
        seq: prepared.seq,
        nextId: 100,
        writes: prepared.writes,
      } as unknown as DurableSessionCommit);
      commits.push(structuredClone([...writes]));
      if (effects?.tools.length || effects?.cancellations.length)
        effectBatches.push({
          seq: Number(prepared.seq),
          tools: effects.tools.length,
          cancellations: effects.cancellations.length,
        });
      for (const { command } of effects?.tools ?? []) {
        if (!("request" in command)) throw new Error("Expected the Cube fixture");
        commands.push(command);
        started.resolve();
        if (!options.hold) {
          received = true;
          reply.resolve({ content: [{ type: "text", text: "ONE" }] });
        }
      }
      for (const cancel of effects?.cancellations ?? []) {
        cancels.push(cancel.operationId);
        received = true;
        reply.resolve({
          content: [{ type: "text", text: "LATE CONFIRMED PARTIAL" }],
          isError: true,
        });
      }
      effects?.confirmed();
      return prepared.apply();
    }
  })();
  const definition = {
    name: "read",
    description: "Test transport only",
    parameters: Type.Object({ path: Type.String() }),
  };
  runtime = await DurableAgentSession.open(store, {
    models,
    remoteTools: [definition],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  });
  const runId = randomUUID(),
    reference = createExecutionReference(randomUUID(), runId, 1);
  const conversation = await runtime.bind({
    runId,
    conversationId: 1,
    model: faux.getModel(),
    agent: {},
    context: { sessionId: randomUUID(), turnId: randomUUID() },
    remoteTools: ["read"],
    tools: [],
    assertCurrent: async () => {},
    openModel: async ({ options: request }) => ({
      model: faux.getModel(),
      options: { ...request, apiKey: "private-model-capability" },
      release: () => {},
    }),
    prepareRemote: async (invocation: RemoteInvocation) => {
      preparedCount++;
      return {
        command: {
          executionReference: reference,
          toolCallId: `task:${invocation.taskId}`,
          occurredAt: new Date().toISOString(),
          request: {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.operation",
            activationId: randomUUID(),
            operationId: randomUUID(),

            operation: "tool.execute",
            toolName: "read",
            toolCallId: invocation.callId,
            args: invocation.args,
            timeoutMs: 1000,
            maximumOutputBytes: 65536,
          },
        },
        result: () => awaitWithContext(reply.promise, invocation.context),
        completed: () => received,
        dispose: () => {},
      };
    },
  });
  return {
    runtime,
    runId,
    definition,
    conversation,
    faux,
    commands,
    cancels,
    started,
    commits,
    prepared: () => preparedCount,
    effectBatches,
  };
}

const f = await fixture({ duplicate: true });
try {
  const input = await f.conversation.submit(
    { type: "input", content: "inspect both", requestId: "synthetic-native-batch-probe" },
    BACKGROUND_CONTEXT,
  );
  assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "done");
  assert.equal(f.commands.length, 2);
  const result = {
    baseline: "93635d37",
    nativeVersion: "1.0.0",
    model: "faux; no external request",
    toolCalls: f.commands.length,
    effectBatches: f.effectBatches,
    maximumToolsPerCommit: Math.max(...f.effectBatches.map((b) => b.tools)),
  };
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-handoff-review-native-commits.json",
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} finally {
  await f.runtime.close();
}
