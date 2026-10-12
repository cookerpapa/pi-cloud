import { nativeTestDisplay } from "./fixtures/native-test-display.ts";
import { expect, it, vi } from "vitest";
import { MemoryStorage, type StorageWrite, type Seq } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  FakeModelServer,
  FAKE_MODEL_API_KEY,
  type FakeModelScenario,
} from "@pi-cloud/fake-model-server";
import type {
  CandidateToolCommand,
  DurableSessionCommit,
  EventPublishMessage,
  NativeToolEnd,
} from "@pi-cloud/protocol";
import type {
  DurableSessionHandle,
  ManagedNativeRuntime,
} from "@pi-cloud/pi-session-postgres/durable";
import { PiCloudTurnRunner, type PiCloudTurnRunnerOptions } from "../src/pi-cloud-turn-runner.ts";
import { createTrustedRemoteAgentTools } from "../src/trusted-remote-tools.ts";
import {
  createCloudExecutionContext,
  createCloudTurnContext,
  createCloudStepContext,
} from "../src/cloud-context.ts";
import { command } from "./fixtures/durable-command.ts";

async function fixture(
  scenario: FakeModelScenario = "text",
  hold = false,
  override: Partial<PiCloudTurnRunnerOptions> = {},
) {
  const server = new FakeModelServer({ defaultScenario: scenario });
  await server.start();
  const authority = new AbortController(),
    cancelled = new AbortController(),
    events: EventPublishMessage[] = [];
  const commands: CandidateToolCommand[] = [],
    cancellations: string[] = [],
    started = Promise.withResolvers<void>();
  const replies = new Map<
    string,
    {
      request: CandidateToolCommand["request"];
      pending: ReturnType<typeof Promise.withResolvers<NativeToolEnd>>;
    }
  >();
  let preparation: Parameters<DurableSessionHandle["preparePublication"]>[0] | undefined;
  let runtime: Promise<ManagedNativeRuntime> | undefined,
    released = !hold,
    acquired = 0,
    returned = 0;
  const recordSeq = new Map<number, number>();
  const settle = () => {
    for (const value of replies.values())
      value.pending.resolve({
        type: "tool_execution_end",
        toolCallId:
          value.request.operation === "tool.execute" ? value.request.toolCallId : "workflow",
        toolName: value.request.toolName,
        isError: false,
        result: { content: [{ type: "text", text: "complete" }] },
      });
  };
  const textDisplay = nativeTestDisplay((event) =>
    events.push({
      protocolVersion: 1,
      type: "event.publish",
      messageId: event.eventId,
      sentAt: event.occurredAt,
      payload: { executionReference: command.payload.executionReference, event },
    }),
  );
  const storage = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
      return textDisplay.serializePublication(async () => {
        const prepared = this.prepareCommit(writes);
        const confirmed = await textDisplay.compile(this, prepared.writes, prepared.seq);
        const effects = preparation?.({
          seq: prepared.seq,
          nextId: 10000,
          writes: prepared.writes,
        } as unknown as DurableSessionCommit);
        for (const tool of effects?.tools ?? []) {
          commands.push(tool.command);
          started.resolve();
        }
        for (const cancel of effects?.cancellations ?? []) cancellations.push(cancel.operationId);
        effects?.confirmed();
        const seq = prepared.apply();
        confirmed();
        for (const write of writes)
          recordSeq.set(
            "value" in write ? write.value.id : "record" in write ? write.record.id : write.id,
            seq,
          );
        if (released) settle();
        context.abortSignal?.throwIfAborted();
        return seq;
      });
    }
  })();
  const scope = command.payload,
    turn = createCloudTurnContext(command),
    execution = createCloudExecutionContext({
      command,
      turnContextSha256: turn.sha256,
      runtimeIdentity: { supervisorId: "test", bootId: "test", sandboxId: "test" },
    });
  const handle: DurableSessionHandle = {
    ...textDisplay,
    storage,
    binding: {
      tenantId: scope.tenantId,
      sessionId: scope.sessionId,
      piSessionId: scope.piSession.id,
      conversationId: 1,
      runId: scope.runId,
      turnId: scope.turnId,
      writerId: scope.piSession.writerId,
      executionReference: scope.executionReference,
    },
    recordSequence: async (id) => recordSeq.get(id),
    committedSequence: () => Math.max(0, ...recordSeq.values()),
    authority: {
      signal: authority.signal,
      assertCurrent: async () => {
        authority.signal.throwIfAborted();
      },
      close: async () => {},
    },
    interrupt: (reason) => authority.abort(reason),
    runtime: (factory) => (runtime ??= factory()) as ReturnType<typeof factory>,
    preparePublication: (value) => {
      preparation = value;
    },
    close: async () => {},
  };
  const runner = new PiCloudTurnRunner({
    openSession: async () => handle,
    resolveModelRuntime: () => ({
      provider: scope.model.provider,
      modelId: scope.model.modelId,
      api: "openai-completions",
      apiKey: FAKE_MODEL_API_KEY,
      baseUrl: server.baseUrl,
      inputModalities: ["text", "image"],
      contextWindow: 131072,
      maxTokens: 1024,
    }),
    turnTimeoutMs: 30000,
    requestTimeoutMs: 30000,
    acquireModelPermit: async (signal) => {
      signal?.throwIfAborted();
      acquired++;
      return () => {
        returned++;
      };
    },
    sandboxContinuity: {
      continuityId: "not-activated",
      continuity: "cold_restore",
      environmentSha256: turn.environmentSha256,
      workspaceBindingSha256: turn.workspaceBindingSha256,
      toolPolicySha256: turn.toolPolicySha256,
    },
    createAgentTools: ({ stepWorldState, captureSamplingStep }) =>
      createTrustedRemoteAgentTools({
        publishToolCommand: async () => {
          throw new Error("Fixed tools require one native handoff");
        },
        trackWorkflowOperation: () => {},
        workflowUrl: "http://127.0.0.1:1",
        activationId: "20000000-0000-4000-8000-000000000001",
        executionReference: scope.executionReference,
        turnContextSha256: turn.sha256,
        executionContextSha256: execution.sha256,
        workingDirectory: "/workspace",
        supportsImages: true,
        remainingToolCalls: null,
        maximumToolOutputBytes: 65536,
        captureStepContext: (tools, purpose) =>
          captureSamplingStep(
            async (sequence) => {
              const value = await stepWorldState.capture();
              return {
                step: createCloudStepContext({
                  sequence,
                  turnContextSha256: turn.sha256,
                  executionContextSha256: execution.sha256,
                  allowedTools: turn.context.tools.names,
                  activeTools: tools,
                  worldState: value.worldState,
                }),
                modelMessages: value.modelMessages,
              };
            },
            { publishEvent: purpose !== "context_maintenance" },
          ),
        waitForToolReply: (request, signal) => {
          const pending = Promise.withResolvers<NativeToolEnd>();
          replies.set(request.operationId, { request, pending });
          signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
          return pending.promise;
        },
      }),
    ...override,
  });
  return {
    runner,
    storage,
    events,
    commands,
    cancellations,
    started,
    server,
    counts: () => ({ acquired, returned }),
    release: () => {
      released = true;
      settle();
    },
    stop: () =>
      cancelled.abort({
        kind: "pi-cloud.turn-cancellation",
        reason: "user_request",
        gracePeriodMs: 1000,
      }),
    revoke: () => authority.abort(new Error("lease revoked")),
    run: (input = command) =>
      runner.run(
        input,
        (value) => {
          events.push(value);
        },
        cancelled.signal,
      ),
    close: async () => {
      cancelled.abort();
      released = true;
      settle();
      await (await runtime)?.close();
      await server.stop();
    },
  };
}

it("executes one native post-validation handoff and releases the model permit during the tool wait", async () => {
  const f = await fixture("tool_hold", true);
  const running = f.run();
  try {
    await f.started.promise;
    expect(f.counts()).toEqual({ acquired: 1, returned: 1 });
    expect(f.commands).toHaveLength(1);
    f.release();
    expect((await running).stopReason).toBe("stop");
    const starts = f.events
      .map((value) => value.payload.event)
      .filter((event) => event.type === "tool.started");
    const ends = f.events
      .map((value) => value.payload.event)
      .filter((event) => event.type === "tool.completed");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]!.payload.toolCallId).toBe(f.commands[0]!.toolCallId);
    expect(ends[0]!.payload.toolCallId).toBe(starts[0]!.payload.toolCallId);
  } finally {
    f.release();
    await running.catch(() => {});
    await f.close();
  }
}, 15000);

it.each(["steer", "follow_up"] as const)(
  "consumes durable %s input and keeps reused provider IDs in separate native Tool tasks",
  async (delivery) => {
    const f = await fixture("tool_hold", true);
    const running = f.run();
    try {
      await f.started.promise;
      const id = crypto.randomUUID();
      await f.runner.agentInput(id, "second instruction", delivery);
      f.release();
      await running;
      const submissions = await f.storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(submissions.items.find((value) => value.requestId === id)?.status).toBe("done");
      const starts = f.events
        .map((value) => value.payload.event)
        .filter((event) => event.type === "tool.started");
      expect(new Set(starts.map((value) => value.payload.toolCallId)).size).toBe(starts.length);
      expect(f.counts().acquired).toBe(f.counts().returned);
    } finally {
      f.release();
      await running.catch(() => {});
      await f.close();
    }
  },
  15000,
);

it("co-commits native Stop with operation cancellation without waiting for an unconfirmed guest result", async () => {
  const f = await fixture("tool_hold", true);
  const running = f.run();
  void running.catch(() => {});
  try {
    await f.started.promise;
    f.stop();
    await expect(running).rejects.toMatchObject({ code: "turn_cancelled" });
    expect(f.cancellations).toEqual([f.commands[0]!.request.operationId]);
    expect(f.server.observations).toHaveLength(1);
  } finally {
    f.release();
    await running.catch(() => {});
    await f.close();
  }
}, 15000);

it("stops provider IO when the current cloud lease is revoked", async () => {
  const f = await fixture("timeout"),
    running = f.run();
  void running.catch(() => {});
  try {
    await vi.waitFor(() => expect(f.server.observations).toHaveLength(1));
    f.revoke();
    await expect(running).rejects.toMatchObject({ code: "session_lease_revoked" });
  } finally {
    await running.catch(() => {});
    await f.close();
  }
}, 15000);

it.each([false, true])(
  "prepares native visual input before any model request (invalid=%s)",
  async (invalid) => {
    let prepared = false;
    const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
    const f = await fixture("text", false, {
      prepareInputUploads: async () => {
        if (invalid) throw new Error("invalid image");
        prepared = true;
        return { images: [image], hints: [] };
      },
      acquireModelPermit: async () => {
        expect(prepared).toBe(true);
        return () => {};
      },
    });
    const upload = {
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      name: "shot.png",
      path: "/workspace/shot.png",
      byteLength: 5,
      mimeType: "image/png",
      sha256: "a".repeat(64),
      image: {
        id: crypto.randomUUID(),
        byteLength: 5,
        mimeType: "image/png" as const,
        sha256: "a".repeat(64),
      },
    };
    try {
      const running = f.run({
        ...command,
        payload: {
          ...command.payload,
          input: { kind: "prompt", text: "inspect", uploads: [upload] },
        },
      });
      if (invalid) {
        await expect(running).rejects.toThrow("invalid image");
        expect(f.server.observations).toHaveLength(0);
      } else {
        await running;
        expect(
          JSON.stringify(
            await f.storage.scanEntries(
              { conversationId: 1 as import("@earendil-works/pi-durable").ConversationId },
              100,
              undefined,
              BACKGROUND_CONTEXT,
            ),
          ),
        ).toContain(image.data);
      }
    } finally {
      await f.close();
    }
  },
  15000,
);

it("decides the project verification reminder from native progress and consumes it only once", async () => {
  const f = await fixture("tool_hold", false, {
    settlementPolicy: {
      command: "npm test",
      cwd: ".",
      workingDirectory: "/workspace",
      timeoutMs: 1000,
      maximumFollowUps: 1,
    },
  });
  try {
    await f.run();
    const entries = (
      await f.storage.scanEntries(
        { conversationId: 1 as import("@earendil-works/pi-durable").ConversationId },
        100,
        undefined,
        BACKGROUND_CONTEXT,
      )
    ).items;
    const reminders = entries.filter(
      (entry) =>
        entry.byTaskId !== undefined &&
        entry.model?.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("project-defined verification step"),
        ),
    );
    expect(reminders).toHaveLength(1);
    expect(f.commands).toHaveLength(2); // Initial work, then the one reminder continuation.
    const { prepareNativeSettlementFollowUp } = await import("../src/pi-settlement-gate.ts");
    const answer = entries
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "assistant")!;
    expect(
      await prepareNativeSettlementFollowUp({
        policy: {
          command: "npm test",
          cwd: ".",
          workingDirectory: "/workspace",
          timeoutMs: 1000,
          maximumFollowUps: 1,
        },
        storage: f.storage,
        conversationId: 1,
        answer: answer as import("@earendil-works/pi-ai").AssistantMessage,
      }),
    ).toBeUndefined();
  } finally {
    await f.close();
  }
}, 15000);

it("settles a Run after individual withdrawal and publishes a consumed human input once", async () => {
  const f = await fixture("tool_hold", true),
    running = f.run();
  const scope = command.payload;
  const submit = (suffix: string, text: string) =>
    f.runner.humanInput({
      action: "submit",
      tenantId: scope.tenantId,
      sessionId: scope.sessionId,
      runId: scope.runId,
      executionReference: scope.executionReference,
      input: {
        inputId: `input-${suffix.repeat(64)}`,
        idempotencyKey: suffix,
        fingerprint: suffix.repeat(64),
        text,
        uploads: [],
        mode: "follow_up",
        acceptedAt: new Date().toISOString(),
      },
    });
  try {
    await f.started.promise;
    const first = await submit("a", "withdraw this");
    await f.runner.humanInput({
      action: "mutate",
      tenantId: scope.tenantId,
      sessionId: scope.sessionId,
      runId: scope.runId,
      executionReference: scope.executionReference,
      mutation: {
        operationId: `edit-${"b".repeat(64)}`,
        fingerprint: "b".repeat(64),
        inputId: `input-${"a".repeat(64)}`,
        revision: first.queue.revision,
        change: { action: "cancel" },
      },
    });
    await submit("c", "human continuation");
    f.release();
    expect((await running).stopReason).toBe("stop");
    const humans = f.events.map((v) => v.payload.event).filter((e) => e.type === "user.input");
    expect(humans).toHaveLength(1);
    expect(humans[0]!.payload).toMatchObject({
      text: "human continuation",
      inputId: `input-${"c".repeat(64)}`,
    });
    expect(
      (await f.storage.scanSubmissions({}, 100, undefined, BACKGROUND_CONTEXT)).items.find(
        (s) => s.requestId === `input-${"a".repeat(64)}`,
      ),
    ).toMatchObject({ status: "unanswered", reason: "aborted" });
  } finally {
    f.release();
    await running.catch(() => {});
    await f.close();
  }
}, 15000);
