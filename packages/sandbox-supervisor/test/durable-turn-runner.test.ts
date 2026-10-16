import { nativeTestDisplay } from "./fixtures/native-test-display.ts";
import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FakeModelServer, FAKE_MODEL_API_KEY } from "@pi-cloud/fake-model-server";
import { type EventPublishMessage } from "@pi-cloud/protocol";
import { PiCloudTurnRunner } from "../src/pi-cloud-turn-runner.ts";
import { RemoteToolSandboxTurnRunner } from "../src/remote-tool-sandbox-turn-runner.ts";
import { resolveWorkspaceSeed } from "../../supervisor-host/src/workspace-seed.ts";
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

it.each(["complete", "stop_on_resume", "stop_before_setup"] as const)(
  "runs native input and admission gates (%s)",
  async (mode) => {
    const fake = new FakeModelServer({ defaultScenario: "text" });
    await fake.start();
    const events: EventPublishMessage[] = [];
    const textDisplay = nativeTestDisplay((event) =>
      events.push({
        protocolVersion: 1,
        type: "event.publish",
        messageId: event.eventId,
        sentAt: event.occurredAt,
        payload: { executionReference: command.payload.executionReference, event },
      }),
    );
    const recordSequences = new Map<number, number>();
    const storage = new (class extends MemoryStorage {
      override async commit(
        writes: readonly import("@earendil-works/pi-durable").StorageWrite[],
        _context: import("@earendil-works/chord").Context,
      ) {
        return textDisplay.serializePublication(async () => {
          const prepared = this.prepareCommit(writes);
          const confirmed = await textDisplay.compile(this, prepared.writes, prepared.seq);
          const seq = prepared.apply();
          confirmed();
          for (const write of writes)
            recordSequences.set(
              "value" in write ? write.value.id : "record" in write ? write.record.id : write.id,
              seq,
            );
          return seq;
        });
      }
    })();
    const userStop = new AbortController();
    let runtime: Promise<ManagedNativeRuntime> | undefined;
    const controller = new AbortController();
    const turn = createCloudTurnContext(command),
      execution = createCloudExecutionContext({
        command,
        turnContextSha256: turn.sha256,
        runtimeIdentity: { supervisorId: "s", bootId: crypto.randomUUID(), sandboxId: "worker" },
      });
    let step = 0,
      acquired = 0,
      released = 0;
    const handle: DurableSessionHandle = {
      ...textDisplay,
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
      committedSequence: () => Math.max(0, ...recordSequences.values()),
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
    let runner: PiCloudTurnRunner | RemoteToolSandboxTurnRunner = new PiCloudTurnRunner({
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
        prepareWorkflow: async () => {
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
    const directory = await mkdtemp(join(tmpdir(), "native-stop-bootstrap-"));
    const activate = vi.fn(async () => {
      throw new Error("Cancelled bootstrap must not activate Cube");
    });
    const leaseReleased = vi.fn();
    const selectedCommand =
      mode === "stop_before_setup"
        ? {
            ...command,
            payload: {
              ...command.payload,
              model: {
                ...command.payload.model,
                provider: "openai-codex" as const,
                modelId: "gpt-6-luna" as const,
              },
            },
          }
        : command;
    try {
      if (mode === "stop_before_setup") {
        userStop.abort({
          kind: "pi-cloud.turn-cancellation",
          reason: "user_request",
          gracePeriodMs: 1000,
        });
        runner = new RemoteToolSandboxTurnRunner({
          broker: {
            create: activate,
            refreshServices: async () => {},
            release: async () => ({ retained: false }),
            workflowUrlFor: () => {
              throw new Error("No Workflow expected");
            },
          },
          runtimeIdentity: { supervisorId: "s", bootId: crypto.randomUUID(), sandboxId: "worker" },
          trustedWorkspaceDirectory: directory,
          workspaceSeedResolver: resolveWorkspaceSeed,
          openAgentSession: async () => handle,
          modelRuntimeLeaseResolver: () => ({
            runtime: {
              kind: "openai_compatible_gateway",
              provider: "openai-codex",
              modelId: "gpt-6-luna",
              api: "openai-codex-responses",
              baseUrl: fake.baseUrl,
              capability: FAKE_MODEL_API_KEY,
              reasoning: false,
              inputModalities: ["text"],
              hostedTools: [],
              contextWindow: 131072,
              autoCompactTokenLimit: 100000,
              maxTokens: 1024,
              serviceTier: null,
              requestTimeoutMs: 1000,
              turnTimeoutMs: 10000,
            },
            release: leaseReleased,
          }),
          acquireModelPermit: async () => {
            acquired++;
            return () => {
              released++;
            };
          },
        });
      }
      const executing = runner.run(
        {
          ...selectedCommand,
          payload: {
            ...selectedCommand.payload,
            ...(mode !== "complete" ? { stopOnResume: true as const } : {}),
          },
        },
        (event) => {
          events.push(event);
        },
        userStop.signal,
      );
      if (mode !== "complete") {
        await expect(executing).rejects.toMatchObject({
          code: "turn_cancelled",
          reason: "user_request",
        });
        expect(acquired).toBe(0);
        expect(released).toBe(0);
        expect(activate).not.toHaveBeenCalled();
        if (mode === "stop_before_setup") expect(leaseReleased).toHaveBeenCalledOnce();
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
      await rm(directory, { recursive: true });
    }
  },
  15000,
);
