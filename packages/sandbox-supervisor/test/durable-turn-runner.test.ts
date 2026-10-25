import { nativeTestDisplay } from "./fixtures/native-test-display.ts";
import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { FakeModelServer, FAKE_MODEL_API_KEY } from "@pi-cloud/fake-model-server";
import { type EventPublishMessage, parseControlToSupervisorMessage } from "@pi-cloud/protocol";
import { PiCloudTurnRunner } from "../src/pi-cloud-turn-runner.ts";
import { AgentRunSupervisor } from "../src/agent-run-supervisor.ts";
import type { TrustedModelRuntimeLease } from "../src/agent-turn-runtime.ts";
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

it.each([
  "complete",
  "stop_on_resume",
  "stop_before_setup",
  "long_work",
  "cold_compact",
  "cold_compact_history",
  "cold_compact_stop",
] as const)(
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
      // The fixture storage spans the seed handle and the independently opened Runner.
      override async close() {}
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
    let initialConversationId = 1;
    if (mode === "cold_compact_history" || mode === "cold_compact_stop") {
      const seed = await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      try {
        const created = await seed.commit(
          (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
          BACKGROUND_CONTEXT,
        );
        initialConversationId = created.id;
        const root = await seed.conversation(created.id, BACKGROUND_CONTEXT);
        if (!root) throw new Error("Seed conversation is missing");
        await root.commit(async (tx) => {
          for (let i = 0; i < 4; i++) {
            await tx.appendEntry(root.id, {
              kind: "pi.user",
              model: [
                {
                  role: "user",
                  content: "Retain the project decision. ".repeat(2000),
                  timestamp: i,
                },
              ],
            });
            await tx.appendEntry(root.id, {
              kind: "pi.assistant",
              model: [fauxAssistantMessage("Recorded.")],
            });
          }
        }, BACKGROUND_CONTEXT);
      } finally {
        await seed.close(BACKGROUND_CONTEXT);
      }
    }
    const userStop = new AbortController();
    const enteredPermit = Promise.withResolvers<void>(),
      releasePermit = Promise.withResolvers<void>();
    const stopping = mode === "stop_on_resume" || mode === "stop_before_setup";
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
        conversationId: initialConversationId,
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
      acquireModelPermit: async (signal) => {
        acquired++;
        if (mode === "long_work") {
          enteredPermit.resolve();
          await awaitWithContext(
            releasePermit.promise,
            withAbortSignal(signal!, BACKGROUND_CONTEXT),
          );
        }
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
        prepareModelRequest: async (messages, _purpose, headers) => {
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
          return { messages: [...messages], headers: headers ?? {} };
        },
      }),
    });
    const directory = await mkdtemp(join(tmpdir(), "native-stop-bootstrap-"));
    const activate = vi.fn(async () => {
      throw new Error("Cancelled bootstrap must not activate Cube");
    });
    const leaseReleased = vi.fn();
    const seedResolver = vi.fn(resolveWorkspaceSeed);
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
      }
      if (mode === "stop_before_setup" || mode.startsWith("cold_compact")) {
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
          workspaceSeedResolver: seedResolver,
          openAgentSession: async () => handle,
          modelRuntimeLeaseResolver: () => ({
            runtime: {
              kind: "openai_compatible_gateway",
              provider: selectedCommand.payload.model.provider,
              modelId: selectedCommand.payload.model.modelId,
              api: mode === "stop_before_setup" ? "openai-codex-responses" : "openai-completions",
              baseUrl: fake.baseUrl,
              capability: FAKE_MODEL_API_KEY,
              reasoning: false,
              inputModalities: ["text"],
              hostedTools: [],
              contextWindow: 131072,
              autoCompactTokenLimit: 100000,
              maxTokens: 1024,
              serviceTier: null,
              eventIdleTimeoutMs: 1000,
            } as unknown as TrustedModelRuntimeLease["runtime"],
            release: leaseReleased,
          }),
          acquireModelPermit: async (_command, signal) => {
            acquired++;
            if (mode === "cold_compact_history" || mode === "cold_compact_stop") {
              enteredPermit.resolve();
              await awaitWithContext(
                releasePermit.promise,
                withAbortSignal(signal!, BACKGROUND_CONTEXT),
              );
            }
            return () => {
              released++;
            };
          },
        });
      }
      if (mode === "long_work") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const wire = parseControlToSupervisorMessage({
        ...selectedCommand,
        payload: {
          ...selectedCommand.payload,
          piSession: {
            ...selectedCommand.payload.piSession,
            conversationId: initialConversationId,
          },
          ...(stopping ? { stopOnResume: true as const } : {}),
          ...(mode.startsWith("cold_compact")
            ? {
                input: {
                  kind: "compact" as const,
                  commandId: crypto.randomUUID(),
                  fingerprint: "a".repeat(64),
                  requestedAt: new Date().toISOString(),
                  instructions: "",
                },
              }
            : {}),
        },
      });
      if (wire.type !== "command.turn.execute") throw new Error("Unexpected fixture command");
      const publish = (event: EventPublishMessage) => {
        events.push(event);
        return {
          protocolVersion: 1 as const,
          type: "event.ack" as const,
          messageId: crypto.randomUUID(),
          sentAt: new Date().toISOString(),
          payload: {
            sessionId: event.payload.event.sessionId,
            executionReference: event.payload.executionReference,
            acknowledgedThroughSeq: event.payload.event.seq,
          },
        };
      };
      const supervisor = new AgentRunSupervisor({ runner });
      const prepared = mode.startsWith("cold_compact")
        ? supervisor.prepare(wire, publish)
        : undefined;
      if (prepared) expect(prepared.ack.payload.status).toBe("accepted");
      const executing = prepared
        ? prepared.run()
        : runner.run(
            wire,
            (event) => {
              events.push(event);
            },
            userStop.signal,
          );
      void executing.catch(() => {});
      if (mode === "cold_compact_history" || mode === "cold_compact_stop") {
        await enteredPermit.promise;
        if (mode === "cold_compact_stop") {
          const p = wire.payload;
          const stop = supervisor.prepareCancellation({
            protocolVersion: 1,
            messageId: crypto.randomUUID(),
            sentAt: new Date().toISOString(),
            type: "command.turn.cancel",
            payload: {
              controlRequestId: crypto.randomUUID(),
              targetRunId: p.runId,
              idempotencyKey: "stop-compact",
              tenantId: p.tenantId,
              projectId: p.projectId,
              workspaceId: p.workspaceId,
              sessionId: p.sessionId,
              runId: p.runId,
              turnId: p.turnId,
              agentId: p.agentId,
              executionReference: p.executionReference,
              reason: "user_request",
              gracePeriodMs: 1000,
            },
          });
          expect(stop.ack.payload.status).toBe("accepted");
          await stop.run();
          await expect(executing).rejects.toMatchObject({
            code: "turn_cancelled",
            reason: "user_request",
          });
          expect(activate).not.toHaveBeenCalled();
          expect(seedResolver).not.toHaveBeenCalled();
          expect(fake.observations).toEqual([]);
          return;
        }
        if (wire.payload.input.kind !== "compact") throw new Error("Expected compact");
        const { kind: _kind, ...input } = wire.payload.input;
        const duplicate = await (runner as RemoteToolSandboxTurnRunner).compact({
          ...input,
          tenantId: wire.payload.tenantId,
          sessionId: wire.payload.sessionId,
          runId: wire.payload.runId,
          executionReference: wire.payload.executionReference,
        });
        expect(duplicate.replayed).toBe(true);
        releasePermit.resolve();
      }
      if (mode === "long_work") {
        await enteredPermit.promise;
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        vi.useRealTimers();
        releasePermit.resolve();
      }
      if (stopping) {
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
      if (mode.startsWith("cold_compact")) {
        expect((await executing).stopReason).toBe(
          mode === "cold_compact" ? "compact_no_op" : "compact_applied",
        );
        expect(acquired).toBe(mode === "cold_compact" ? 0 : 1);
        expect(released).toBe(acquired);
        expect(activate).not.toHaveBeenCalled();
        expect(seedResolver).not.toHaveBeenCalled();
        expect(leaseReleased).toHaveBeenCalledOnce();
        expect(
          (await storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT)).items.some(
            (s) => s.type === "input",
          ),
        ).toBe(false);
        expect(events.some((e) => e.payload.event.type === "assistant.text.delta")).toBe(false);
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
      vi.useRealTimers();
      releasePermit.resolve();
      await (await runtime)?.close();
      await fake.stop();
      await rm(directory, { recursive: true });
    }
  },
  15000,
);
