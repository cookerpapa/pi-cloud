import { expect, it } from "vitest";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FakeModelServer, FAKE_MODEL_API_KEY } from "@pi-cloud/fake-model-server";
import { type EventPublishMessage } from "@pi-cloud/protocol";
import { PiCloudTurnRunner } from "../src/pi-cloud-turn-runner.ts";
import {
  createCloudTurnContext,
  createCloudExecutionContext,
  createCloudStepContext,
} from "../src/cloud-context.ts";
import type {
  ManagedNativeRuntime,
  DurableSessionHandle,
} from "@pi-cloud/pi-session-postgres/durable";
import { command } from "./fixtures/durable-command.ts";

it.each(["complete", "stop_on_resume"] as const)(
  "runs native input and admission gates (%s)",
  async (mode) => {
    const fake = new FakeModelServer({ defaultScenario: "text" });
    await fake.start();
    const recordSequences = new Map<number, number>();
    const storage = new (class extends MemoryStorage {
      override async commit(
        writes: readonly import("@earendil-works/pi-durable").StorageWrite[],
        context: import("@earendil-works/chord").Context,
      ) {
        const seq = await super.commit(writes, context);
        for (const write of writes)
          recordSequences.set(
            "value" in write ? write.value.id : "record" in write ? write.record.id : write.id,
            seq,
          );
        return seq;
      }
    })();
    const userStop = new AbortController();
    let runtime: Promise<ManagedNativeRuntime> | undefined;
    const events: EventPublishMessage[] = [];
    const controller = new AbortController();
    const turn = createCloudTurnContext(command),
      execution = createCloudExecutionContext({
        command,
        turnContextSha256: turn.sha256,
        runtimeIdentity: { supervisorId: "s", bootId: "b", sandboxId: "worker" },
      });
    let step = 0,
      acquired = 0,
      released = 0;
    const handle: DurableSessionHandle = {
      binding: {
        tenantId: command.payload.tenantId,
        piSessionId: command.payload.piSession.id,
        conversationId: 1,
        sessionId: command.payload.sessionId,
        turnId: command.payload.turnId,
        runId: command.payload.runId,
        executionReference: command.payload.executionReference,
        writerId: command.payload.piSession.writerId,
      },
      recordSequence: async (id) => recordSequences.get(id),
      interrupt: (reason) => controller.abort(reason),
      storage,
      authority: {
        signal: controller.signal,
        assertCurrent: async () => {},
        close: async () => {},
      },
      runtime: (factory) => (runtime ??= factory()) as ReturnType<typeof factory>,
      preparePublication: () => {},
      close: async () => {},
    };
    const runner = new PiCloudTurnRunner({
      onActivity: (value) => {
        if (mode === "stop_on_resume" && value?.phase === "cancelling")
          userStop.abort({
            kind: "pi-cloud.turn-cancellation",
            reason: "user_request",
            gracePeriodMs: 1000,
          });
      },
      openSession: async () => handle,
      resolveModelRuntime: () => ({
        provider: command.payload.model.provider,
        modelId: command.payload.model.modelId,
        api: "openai-completions",
        apiKey: FAKE_MODEL_API_KEY,
        baseUrl: fake.baseUrl,
        contextWindow: 131072,
        maxTokens: 1024,
      }),
      turnTimeoutMs: 10000,
      acquireModelPermit: async () => {
        acquired++;
        return () => {
          released++;
        };
      },
      sandboxContinuity: {
        continuityId: "inactive",
        continuity: "cold_restore",
        environmentSha256: turn.environmentSha256,
        workspaceBindingSha256: turn.workspaceBindingSha256,
        toolPolicySha256: turn.toolPolicySha256,
      },
      createAgentTools: ({ stepWorldState, captureSamplingStep }) => ({
        tools: [],
        systemPrompt: async (base) => base,
        executeWorkflow: async () => {
          throw new Error("No workflow expected");
        },
        transformHeaders: async (headers) => headers ?? {},
        transformContext: async (messages) => {
          await captureSamplingStep(async () => {
            const capture = await stepWorldState.capture();
            return {
              step: createCloudStepContext({
                sequence: ++step,
                turnContextSha256: turn.sha256,
                executionContextSha256: execution.sha256,
                allowedTools: turn.context.tools.names,
                activeTools: [],
                worldState: capture.worldState,
              }),
              modelMessages: capture.modelMessages,
            };
          });
          return messages;
        },
      }),
    });
    try {
      const executing = runner.run(
        {
          ...command,
          payload: {
            ...command.payload,
            ...(mode === "stop_on_resume" ? { stopOnResume: true as const } : {}),
          },
        },
        (event) => {
          events.push(event);
        },
        userStop.signal,
      );
      if (mode === "stop_on_resume") {
        await expect(executing).rejects.toMatchObject({
          code: "turn_cancelled",
          reason: "user_request",
        });
        expect(acquired).toBe(0);
        expect(released).toBe(0);
        expect(events.some((event) => event.payload.event.type === "model.sampling.started")).toBe(
          false,
        );
        return;
      }
      expect((await executing).stopReason).toBe("stop");
      expect(acquired).toBe(1);
      expect(released).toBe(1);
      expect(events.some((event) => event.payload.event.type === "assistant.text.delta")).toBe(
        true,
      );
      const submissions = await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(submissions.items).toHaveLength(1);
      expect(submissions.items[0]?.requestId).toBe(command.payload.runId);
      expect(submissions.items[0]?.status).toBe("done");
    } finally {
      await (await runtime)?.close();
      await fake.stop();
    }
  },
  15000,
);
