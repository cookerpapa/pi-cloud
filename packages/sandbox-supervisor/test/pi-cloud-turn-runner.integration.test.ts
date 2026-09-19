import { FAKE_MODEL_API_KEY, FakeModelServer } from "@pi-cloud/fake-model-server";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  createExecutionReference,
  type AgentModelRuntime,
  type EventPublishMessage,
  type ExecuteTurnCommandMessage,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import {
  PI_MODEL_RETRY_CUSTOM_TYPE,
  type CloudAgentExecutionAuthority,
  type PiSessionMutationOperation,
} from "@pi-cloud/pi-session-postgres";
import {
  buildSessionContext,
  InMemorySessionStorage,
  Session,
} from "@earendil-works/pi-agent-core";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCloudExecutionContext,
  createCloudStepContext,
  createCloudTurnContext,
  PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE,
  PI_SANDBOX_RESET_CUSTOM_TYPE,
  PiCloudTurnRunner,
  PiModelRuntimePool,
  RemoteToolSandboxTurnRunner,
  resolveCompactionReserveTokens,
  type PiModelRuntimeConfig,
  type ProviderHostedActivity,
  applyProviderHostedTranscript,
  type ToolBrokerBoundary,
} from "../src/index.ts";

const command: ExecuteTurnCommandMessage = {
  protocolVersion: 1,
  messageId: "11111111-1111-4111-8111-111111111111",
  sentAt: "2026-08-14T08:00:00.000Z",
  type: "command.turn.execute",
  payload: {
    idempotencyKey: "cloud-runner-integration",
    tenantId: "tenant-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    piSession: { id: "session-1", lane: "main", writerId: "00000000-0000-4000-8000-000000000001" },
    runId: "44444444-4444-4444-8444-444444444444",
    turnId: "turn-1",
    agentId: "root",
    executionReference: createExecutionReference(
      "33333333-3333-4333-8333-333333333333",
      "55555555-5555-4555-8555-555555555555",
      7,
    ),
    nextEventSeq: 1,
    agent: {
      revisionId: "84041f7b-5052-4abf-8bfd-16adf083c67e",
      definitionKey: "pi-coding",
      runtimeKind: "pi_sdk",
      runtimeVersion: "0.84.1",
      harnessVersion: "pi-cloud-harness-v1",
      sessionStorageKind: "pi_session_storage_v1",
    },
    input: { kind: "prompt", text: "请返回确定性的测试响应。" },
    executionMode: "elastic",
    sessionKind: "conversation",
    workspaceSeedKind: "empty",
    sandboxProfileKey: "standard",
    workingDirectory: "/workspace",
    toolCapabilities: ["read", "write", "edit", "bash"],
    model: {
      profileId: "profile-1",
      provider: "pi-cloud-fake",
      modelId: "pi-cloud-fake",
      thinkingLevel: "off",
      serviceTier: null,
      credentialBindingId: "credential-1",
      credentialBindingVersion: 1,
    },
    environment: {
      environmentVersionId: "66666666-6666-4666-8666-666666666666",
      versionNumber: 1,
      profileKey: "pi-cloud-fullstack",
      profileVersion: "1",
      imageRevision: "development",
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    },
  },
};

class TestAuthority implements CloudAgentExecutionAuthority {
  readonly signal = new AbortController().signal;
  closed = false;
  async assertCurrent(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve } as const;
}

describe("PiCloudTurnRunner integration", () => {
  it("recovers an HTTP-200 SSE overflow with fresh maintenance/agent Steps and one terminal", async () => {
    const requests: unknown[] = [],
      events: PiCloudEvent[] = [],
      purposes: string[] = [];
    let sequence = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      if (requests.length === 1)
        send({
          type: "error",
          code: "context_too_large",
          message: "Your input exceeds the context window of this model",
        });
      else {
        const text = requests.length === 2 ? "Earlier work summarized" : "recovered answer";
        const item = {
          type: "message",
          id: `message-${requests.length}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        send({
          type: "response.created",
          response: { id: `response-${requests.length}`, status: "in_progress", output: [] },
        });
        send({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        send({
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        send({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: text,
        });
        send({ type: "response.output_text.done", output_index: 0, content_index: 0, text });
        send({ type: "response.output_item.done", output_index: 0, item });
        send({
          type: "response.completed",
          response: {
            id: `response-${requests.length}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
          },
        });
      }
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Listener missing");
      const session = new Session(
        new InMemorySessionStorage({ id: "overflow-http", createdAt: 1 }),
      );
      await session.appendMessage({
        role: "user",
        content: "earlier-history ".repeat(400),
        timestamp: 1,
      });
      const turn = createCloudTurnContext(command);
      const runner = new PiCloudTurnRunner({
        resolveModelRuntime: () => ({
          provider: command.payload.model.provider,
          modelId: command.payload.model.modelId,
          api: "openai-responses",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: FAKE_MODEL_API_KEY,
          contextWindow: 1_000_000,
          autoCompactTokenLimit: 900_000,
          maxTokens: 65536,
        }),
        openSession: async () => ({ session, lane: "main", authority: new TestAuthority() }),
        sandboxContinuity: {
          continuityId: "unused",
          continuity: "cold_restore",
          environmentSha256: turn.environmentSha256,
          workspaceBindingSha256: turn.workspaceBindingSha256,
          toolPolicySha256: turn.toolPolicySha256,
        },
        createAgentTools: ({ captureSamplingStep, stepWorldState }) => ({
          tools: [],
          systemPrompt: async (base) => base,
          executeWorkflow: async () => {
            throw new Error("No tools");
          },
          transformHeaders: async (headers = {}) => headers,
          async transformContext(messages, purpose = "agent") {
            purposes.push(purpose);
            await captureSamplingStep(
              async () => {
                const world = await stepWorldState.capture();
                return {
                  step: createCloudStepContext({
                    sequence: ++sequence,
                    turnContextSha256: turn.sha256,
                    executionContextSha256: "b".repeat(64),
                    allowedTools: [],
                    activeTools: [],
                    worldState: world.worldState,
                  }),
                  modelMessages: world.modelMessages,
                };
              },
              { publishEvent: purpose === "agent" },
            );
            return messages;
          },
        }),
      });
      const input = {
        ...command,
        payload: { ...command.payload, budgets: { compactionKeepRecentTokens: 32 } },
      } as ExecuteTurnCommandMessage;
      await expect(
        runner.run(input, (message) => {
          events.push(message.payload.event);
        }),
      ).resolves.toMatchObject({ stopReason: "stop" });
      expect(requests).toHaveLength(3);
      expect(purposes).toEqual(["agent", "context_maintenance", "agent"]);
      expect(
        events.filter((e) => e.type === "model.sampling.started").map((e) => e.payload),
      ).toMatchObject([
        { stepSequence: 1, samplingAttempt: 1 },
        { stepSequence: 3, samplingAttempt: 1 },
      ]);
      expect(
        events.filter((e) => e.type === "context.compaction.completed").map((e) => e.payload),
      ).toMatchObject([{ reason: "overflow", status: "completed", willRetry: true }]);
      expect(events.filter((e) => e.type === "model.sampling.retry.scheduled")).toHaveLength(0);
      expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
      expect(events.filter((e) => e.type === "turn.failed")).toHaveLength(0);
      expect(await session.findEntries({ type: "compaction" })).toHaveLength(1);
      expect(JSON.stringify(requests[2])).toContain("Earlier work summarized");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(["deepseek", "foreign-provider"])(
    "samples a compacted native search tail without exposing extension blocks to Pi Models: %s",
    async (sourceProvider) => {
      const requests: { input: { type: string; id?: string }[] }[] = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "response-fixture",
              status: "completed",
              output: [],
              usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
            },
          })}\n\n`,
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Test listener missing");
        const modelId = "deepseek-v4-pro";
        const selection = { ...command.payload.model, provider: "deepseek", modelId };
        const input = { ...command, payload: { ...command.payload, model: selection } };
        const session = new Session(
          new InMemorySessionStorage({ id: command.payload.sessionId, createdAt: 1 }),
        );
        const searchMessage: import("@earendil-works/pi-ai").AssistantMessage = {
          role: "assistant",
          api: "openai-responses",
          provider: sourceProvider,
          model: modelId,
          content: [
            {
              type: "text",
              text: "Earlier search answer",
              textSignature: JSON.stringify({ v: 1, id: "msg-search" }),
            },
          ],
          usage: {
            input: 50000,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 50001,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        };
        applyProviderHostedTranscript(searchMessage, {
          provider: sourceProvider,
          api: "openai-responses",
          modelId,
          stepSequence: 1,
          stepSha256: "a".repeat(64),
          samplingAttempt: 1,
          items: [
            {
              outputIndex: 0,
              type: "web_search_call",
              id: "search-1",
              nativeItem: {
                type: "web_search_call",
                id: "search-1",
                status: "completed",
                action: { type: "search", query: "fixture search" },
              },
            },
            { outputIndex: 1, type: "message", id: "msg-search" },
          ],
        });
        const compacted = await session.appendEntry(
          {
            id: "compact-search",
            type: "compaction",
            summary: "Earlier work",
            retainedTail: [searchMessage],
            tokensBefore: 100000,
          },
          "main",
        );
        const turn = createCloudTurnContext(input);
        const runner = new PiCloudTurnRunner({
          resolveModelRuntime: () => ({
            provider: "deepseek",
            modelId,
            api: "openai-responses",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: FAKE_MODEL_API_KEY,
            contextWindow: 128000,
            maxTokens: 8192,
          }),
          openSession: async () => ({ session, lane: "main", authority: new TestAuthority() }),
          sandboxContinuity: {
            continuityId: "unused",
            continuity: "cold_restore",
            environmentSha256: turn.environmentSha256,
            workspaceBindingSha256: turn.workspaceBindingSha256,
            toolPolicySha256: turn.toolPolicySha256,
          },
          createAgentTools: ({ captureSamplingStep, stepWorldState }) => ({
            tools: [],
            systemPrompt: async (base) => base,
            executeWorkflow: async () => {
              throw new Error("No guest work expected");
            },
            transformHeaders: async (headers = {}) => headers,
            async transformContext(messages) {
              await captureSamplingStep(async () => {
                const captured = await stepWorldState.capture();
                return {
                  step: createCloudStepContext({
                    sequence: 1,
                    turnContextSha256: turn.sha256,
                    executionContextSha256: "b".repeat(64),
                    allowedTools: [],
                    activeTools: [],
                    worldState: captured.worldState,
                  }),
                  modelMessages: captured.modelMessages,
                };
              });
              return messages;
            },
          }),
        });
        await expect(runner.run(input, () => {})).resolves.toMatchObject({ stopReason: "stop" });
        expect(requests).toHaveLength(1);
        expect(requests[0]!.input.filter((item) => item.type === "web_search_call")).toHaveLength(
          sourceProvider === "deepseek" ? 1 : 0,
        );
        expect(await session.getEntry("compact-search")).toEqual(compacted);
        expect(JSON.stringify(compacted)).toContain("providerHostedToolCall");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it.each(["missing", "throws"])(
    "releases Session authority when model lookup %s",
    async (failure) => {
      const config: PiModelRuntimeConfig = {
        provider: "pi-cloud-fake",
        modelId: "pi-cloud-fake",
        baseUrl: "http://unused.invalid",
        api: "openai-completions",
        apiKey: FAKE_MODEL_API_KEY,
      };
      const pool = new PiModelRuntimePool(0);
      const lease = await pool.acquire(config);
      const release = vi.fn(lease.release);
      const lookup = vi.spyOn(lease.runtime, "getModel").mockImplementation(() => {
        if (failure === "throws") throw new Error("model lookup failed");
        return undefined;
      });
      const acquire = vi
        .spyOn(pool, "acquire")
        .mockResolvedValue({ runtime: lease.runtime, release });
      const authority = new TestAuthority();
      const session = new Session(
        new InMemorySessionStorage({ id: command.payload.sessionId, createdAt: Date.now() }),
      );
      const runner = new PiCloudTurnRunner({
        resolveModelRuntime: () => config,
        modelRuntimePool: pool,
        openSession: async () => ({ session, lane: "main", authority }),
        sandboxContinuity: {
          continuityId: "unused",
          continuity: "cold_restore",
          environmentSha256: "a".repeat(64),
          workspaceBindingSha256: "b".repeat(64),
          toolPolicySha256: "c".repeat(64),
        },
        createAgentTools: () => {
          throw new Error("Model lookup must precede Tools");
        },
      });
      try {
        await expect(runner.run(command, () => {})).rejects.toThrow(
          failure === "missing" ? "Configured model is unavailable" : "model lookup failed",
        );
        expect(release).toHaveBeenCalledTimes(1);
        expect(authority.closed).toBe(true);
      } finally {
        acquire.mockRestore();
        lookup.mockRestore();
        lease.release();
        await authority.close();
      }
    },
  );

  it.each(["model", "session"])(
    "settles queued controls when %s preparation fails",
    async (phase) => {
      const preparing = Promise.withResolvers<void>();
      const authority = new TestAuthority();
      const session = new Session(
        new InMemorySessionStorage({ id: command.payload.sessionId, createdAt: Date.now() }),
      );
      const runner = new PiCloudTurnRunner({
        resolveModelRuntime: async () => {
          await preparing.promise;
          if (phase === "model") throw new Error("model startup failed");
          return {
            provider: "pi-cloud-fake",
            modelId: "pi-cloud-fake",
            baseUrl: "http://unused.invalid",
            api: "openai-completions",
            apiKey: FAKE_MODEL_API_KEY,
          };
        },
        openSession: async () => {
          if (phase === "session") throw new Error("session startup failed");
          return { session, lane: "main", authority };
        },
        sandboxContinuity: {
          continuityId: "unused",
          continuity: "cold_restore",
          environmentSha256: "a".repeat(64),
          workspaceBindingSha256: "b".repeat(64),
          toolPolicySha256: "c".repeat(64),
        },
        createAgentTools: () => {
          throw new Error("Tools cannot start during preparation failure");
        },
      });
      const run = runner.run(command, () => {}).catch((error) => error);
      const queued = [
        runner.steer("new focus"),
        runner.agentInput("child-1", "child input", "notify"),
      ].map((p) => p.catch((error) => error));
      preparing.resolve();
      expect(await run).toMatchObject({ message: `${phase} startup failed` });
      const settled = async (promises: Promise<unknown>[]) =>
        Promise.race([
          Promise.all(promises),
          new Promise((resolve) => setTimeout(() => resolve("controls stranded"), 50)),
        ]);
      expect(await settled(queued)).toEqual([
        expect.objectContaining({ code: "steer_target_unavailable" }),
        expect.objectContaining({ code: "steer_target_unavailable" }),
      ]);
      expect(authority.closed).toBe(phase === "model");
      expect(await settled([runner.steer("late focus").catch((error) => error)])).toEqual([
        expect.objectContaining({ code: "steer_target_unavailable" }),
      ]);
    },
  );

  it("reports cancellation before first sampling without inventing a Cloud Step", async () => {
    const fake = new FakeModelServer({ scenarioSequence: ["text"] });
    await fake.start();
    const session = new Session(
      new InMemorySessionStorage({ id: command.payload.sessionId, createdAt: Date.now() }),
    );
    const authority = new TestAuthority();
    const controller = new AbortController();
    const events: EventPublishMessage[] = [];
    const turn = createCloudTurnContext(command);
    const runner = new PiCloudTurnRunner({
      resolveModelRuntime: () => ({
        provider: "pi-cloud-fake",
        modelId: "pi-cloud-fake",
        baseUrl: fake.baseUrl,
        api: "openai-completions",
        apiKey: FAKE_MODEL_API_KEY,
      }),
      openSession: async (_command, readSignal) => {
        expect(readSignal).toBeInstanceOf(AbortSignal);
        controller.abort({
          kind: "pi-cloud.turn-cancellation",
          reason: "user_request",
          gracePeriodMs: 0,
        });
        expect(readSignal?.aborted).toBe(true);
        return { session, lane: "main", authority };
      },
      sandboxContinuity: {
        continuityId: "never-activated",
        continuity: "cold_restore",
        environmentSha256: turn.environmentSha256,
        workspaceBindingSha256: turn.workspaceBindingSha256,
        toolPolicySha256: turn.toolPolicySha256,
      },
      createAgentTools: () => ({
        tools: [],
        systemPrompt: async (base) => base,
        executeWorkflow: async () => {
          throw new Error("No tools should start");
        },
        transformContext: async () => {
          throw new Error("No sampling should start");
        },
        transformHeaders: async (headers = {}) => headers,
      }),
    });
    try {
      await expect(
        runner.run(
          command,
          (event) => {
            events.push(event);
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "PiTurnCancelledError", reason: "user_request" });
      expect(fake.observations).toHaveLength(0);
      expect(events.some(({ payload }) => payload.event.type === "model.sampling.started")).toBe(
        false,
      );
      expect(authority.closed).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it("does not reserve a physical Sandbox when registered local Tools remain unused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-lazy-sandbox-"));
    const session = new Session(
      new InMemorySessionStorage({ id: command.payload.sessionId, createdAt: Date.now() }),
    );
    const authority = new TestAuthority();
    const create = vi.fn(async () => {
      throw new Error("A text-only model response must not reserve a Sandbox");
    });
    const broker = {
      create,
      async refreshServices() {},
      async release() {
        throw new Error("unused");
      },
      async stop() {},
      operationResultUrlFor() {
        return "http://tool-broker.test/internal/v1/tool-operation";
      },
    } as ToolBrokerBoundary;
    const runner = new RemoteToolSandboxTurnRunner({
      broker,
      runtimeIdentity: {
        supervisorId: "supervisor-lazy-test",
        bootId: "77777777-7777-4777-8777-777777777779",
        sandboxId: "sandbox-lazy-test",
      },
      trustedWorkspaceDirectory: directory,
      scenario: "text",
      openAgentSession: async () => ({ session, lane: "main", authority }),
    });
    try {
      await expect(
        runner.run(command, () => undefined, new AbortController().signal),
      ).resolves.toMatchObject({ stopReason: "stop" });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps owned-machine chat independent of Tool Broker without reporting a reset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-development-continuity-"));
    const developmentCommand: ExecuteTurnCommandMessage = {
      ...command,
      payload: {
        ...command.payload,
        executionMode: "development_environment",
        workingDirectory: "/home/user/project",
      },
    };
    const turn = createCloudTurnContext(developmentCommand);
    const session = new Session(
      new InMemorySessionStorage({
        id: developmentCommand.payload.sessionId,
        createdAt: Date.now(),
      }),
    );
    await session.appendCustomEntry(PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE, {
      schemaVersion: 3,
      sandbox: { status: "active", continuityId: "development-runtime-1" },
      environmentSha256: turn.environmentSha256,
      workspaceBindingSha256: turn.workspaceBindingSha256,

      toolPolicySha256: turn.toolPolicySha256,
    });
    const authority = new TestAuthority();
    const create = vi.fn(async (request: Parameters<ToolBrokerBoundary["create"]>[0]) => ({
      toolBrokerProtocolVersion: 1 as const,
      type: "tool_sandbox.reserved" as const,
      requestId: request.requestId,
      activationId: "99999999-9999-4999-8999-999999999999",
      executionReference: request.assignment.executionReference,
      ownerBaseUrl: "http://tool-broker.test",
      workspaceRoot: "/home/user/project",
      continuity: "warm_reuse" as const,
      continuityId: "development-runtime-1",
    }));
    const release = vi.fn(async () => ({ retained: false }));
    const broker = {
      create,
      async refreshServices() {},
      release,
      async stop() {},
      operationResultUrlFor() {
        return "http://tool-broker.test/internal/v1/tool-operation";
      },
    } as ToolBrokerBoundary;
    const runner = new RemoteToolSandboxTurnRunner({
      broker,
      runtimeIdentity: {
        supervisorId: "supervisor-development-test",
        bootId: "77777777-7777-4777-8777-777777777780",
        sandboxId: "sandbox-development-test",
      },
      trustedWorkspaceDirectory: directory,
      scenario: "text",
      openAgentSession: async () => ({ session, lane: "main", authority }),
    });
    try {
      await expect(
        runner.run(developmentCommand, () => undefined, new AbortController().signal),
      ).resolves.toMatchObject({ stopReason: "stop" });
      expect(create).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(
        (await session.findEntriesOnBranch()).filter(
          (entry) => entry.type === "custom" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
        ),
      ).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { cleanupFails: false, toolFails: false },
    { cleanupFails: true, toolFails: false },
    { cleanupFails: true, toolFails: true },
  ])(
    "preserves a failed Run and its development machine: %j",
    async ({ cleanupFails, toolFails }) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-cloud-development-model-failure-"));
      const fake = new FakeModelServer({
        scenarioSequence: toolFails
          ? ["java_followup"]
          : ["tool_call", "disconnect", "disconnect", "disconnect"],
      });
      await fake.start();
      const developmentCommand: ExecuteTurnCommandMessage = {
        ...command,
        payload: {
          ...command.payload,
          executionMode: "development_environment",
          workingDirectory: "/home/user/project",
          model: {
            ...command.payload.model,
            provider: "deepseek",
            modelId: "deepseek-v4-flash",
            thinkingLevel: "off",
          },
        },
      };
      const turn = createCloudTurnContext(developmentCommand);
      const session = new Session(
        new InMemorySessionStorage({
          id: developmentCommand.payload.sessionId,
          createdAt: Date.now(),
        }),
      );
      await session.appendCustomEntry(PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE, {
        schemaVersion: 3,
        sandbox: { status: "active", continuityId: "development-runtime-1" },
        environmentSha256: turn.environmentSha256,
        workspaceBindingSha256: turn.workspaceBindingSha256,

        toolPolicySha256: turn.toolPolicySha256,
      });
      const authority = new TestAuthority();
      const checkpointEvents: PiCloudEvent[] = [];
      const checkpointOperations: PiSessionMutationOperation[] = [];
      const create = vi.fn(async (request: Parameters<ToolBrokerBoundary["create"]>[0]) => ({
        toolBrokerProtocolVersion: 1 as const,
        type: "tool_sandbox.reserved" as const,
        requestId: request.requestId,
        activationId: "99999999-9999-4999-8999-999999999998",
        executionReference: request.assignment.executionReference,
        ownerBaseUrl: "http://tool-broker.test",
        workspaceRoot: "/home/user/project",
        continuity: "warm_reuse" as const,
        continuityId: "development-runtime-1",
      }));
      const release = vi.fn(async () => {
        if (cleanupFails) throw new Error("cleanup transport unavailable");
        return { retained: true };
      });
      const stop = vi.fn(async () => undefined);
      const modelLeaseRelease = vi.fn(async () => undefined);
      const broker = {
        create,
        release,
        stop,
        async refreshServices() {},
        operationResultUrlFor() {
          return "http://tool-broker.test/internal/v1/tool-operation";
        },
      } as ToolBrokerBoundary;
      const runner = new RemoteToolSandboxTurnRunner({
        publishToolCommand: async (command) => ({
          operationId: command.request.operationId,
          accepted: true,
        }),
        broker,
        runtimeIdentity: {
          supervisorId: "supervisor-development-failure-test",
          bootId: "77777777-7777-4777-8777-777777777781",
          sandboxId: "sandbox-development-failure-test",
        },
        trustedWorkspaceDirectory: directory,
        modelRuntimeLeaseResolver: async () => ({
          runtime: {
            kind: "openai_compatible_gateway",
            provider: "deepseek",
            modelId: "deepseek-v4-flash",
            baseUrl: fake.baseUrl,
            api: "openai-completions",
            capability: FAKE_MODEL_API_KEY,
            reasoning: false,
            contextWindow: 131_072,
            autoCompactTokenLimit: 100_000,
            maxTokens: 16_384,
            requestTimeoutMs: 1_000,
            turnTimeoutMs: 5_000,
            inputModalities: ["text"],
            hostedTools: [],
            serviceTier: null,
          } as unknown as AgentModelRuntime,
          release: modelLeaseRelease,
        }),
        openAgentSession: async () => ({
          session,
          lane: "main",
          authority,
          mutationPublisher: {
            async synchronize() {},
            async mutate(operation, attachedEvents = []) {
              if (operation.kind !== "append_items") {
                throw new Error("Runtime checkpoint must use one atomic append batch");
              }
              const results = [];
              for (const item of operation.items) {
                results.push(
                  item.kind === "append_entry"
                    ? await session.appendEntry(item.entry, item.lane)
                    : await session.appendRecord(item.record),
                );
              }
              checkpointOperations.push(operation);
              checkpointEvents.push(...attachedEvents);
              return { items: results };
            },
          },
        }),
        createTrustedTools: () => [
          {
            executionPlane: "platform",
            tool: {
              name: "inspect_workspace",
              label: "Inspect Workspace",
              description: "Return one deterministic inspection result",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
              } as never,
              async execute() {
                return { content: [{ type: "text", text: "workspace inspected" }], details: {} };
              },
            },
          },
        ],
      });
      const nativeFetch = globalThis.fetch;
      const toolFetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "cubesandbox_tool_result_unknown",
                message: "Guest disconnected after dispatch",
                retryable: false,
              },
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
      );
      if (toolFails)
        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
          String(input).startsWith("http://tool-broker.test")
            ? toolFetch()
            : nativeFetch(input, init),
        );
      try {
        await expect(
          runner.run(developmentCommand, () => undefined, new AbortController().signal),
        ).rejects.toMatchObject({
          code: toolFails ? "cubesandbox_tool_result_unknown" : "model_error",
        });
        if (toolFails) {
          expect(toolFetch).toHaveBeenCalledTimes(1);
          expect(fake.observations).toHaveLength(1);
          const messages = buildSessionContext(await session.findEntriesOnBranch()).messages;
          expect(
            messages.some(
              (message) =>
                message.role === "toolResult" &&
                JSON.stringify(message).includes("cubesandbox_tool_result_unknown"),
            ),
          ).toBe(true);
        }
        expect(create).toHaveBeenCalledTimes(toolFails ? 1 : 0);
        if (toolFails)
          expect(release).toHaveBeenCalledWith(
            "99999999-9999-4999-8999-999999999998",
            expect.anything(),
            { kind: "detach" },
          );
        else expect(release).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(modelLeaseRelease).toHaveBeenCalledTimes(1);
        expect(checkpointEvents.map((event) => event.type)).toContain("tool.started");
        expect(checkpointOperations).toContainEqual(
          expect.objectContaining({
            kind: "append_items",
            items: [
              expect.objectContaining({
                kind: "append_record",
                record: expect.objectContaining({ type: "tool_started" }),
              }),
            ],
          }),
        );
        expect(
          (await session.findEntriesOnBranch()).filter(
            (entry) => entry.type === "custom" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
          ),
        ).toHaveLength(0);
      } finally {
        vi.unstubAllGlobals();
        await fake.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("reuses an idle ModelRuntime without sharing one between active Runs", async () => {
    const pool = new PiModelRuntimePool(1);
    const runtime: PiModelRuntimeConfig = {
      provider: "pi-cloud-fake",
      modelId: "pi-cloud-fake",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      apiKey: FAKE_MODEL_API_KEY,
      contextWindow: 131_072,
    };

    const first = await pool.acquire(runtime);
    first.release();
    const reused = await pool.acquire(runtime);
    expect(reused.runtime).toBe(first.runtime);

    const concurrent = await pool.acquire(runtime);
    expect(concurrent.runtime).not.toBe(reused.runtime);
    concurrent.release();
    reused.release();
  });

  it("configures the native Codex Responses provider with a short-lived gateway credential", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "pi-cloud-provider-gateway" },
      }),
    ).toString("base64url");
    const pool = new PiModelRuntimePool(0);
    const lease = await pool.acquire({
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      baseUrl: "http://127.0.0.1:4200",
      api: "openai-codex-responses",
      apiKey: `${header}.${payload}.${"s".repeat(43)}`,
      transport: "sse",
      reasoning: true,
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
      maxTokens: 65_536,
      inputModalities: ["text", "image"],
      hostedTools: ["web_search"],
    });
    expect(lease.runtime.getProviderAuthStatus("openai-codex")).toMatchObject({
      configured: true,
    });
    expect(lease.runtime.getModel("openai-codex", "gpt-5.6-terra")).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "http://127.0.0.1:4200",
      input: ["text", "image"],
    });
    expect(
      resolveCompactionReserveTokens(
        { contextWindow: 1_000_000, autoCompactTokenLimit: 900_000 },
        16_384,
      ),
    ).toBe(100_000);
    lease.release();
  });

  it("configures native DeepSeek Responses with Provider-hosted Web Search", async () => {
    const pool = new PiModelRuntimePool(0);
    const lease = await pool.acquire({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      baseUrl: "http://127.0.0.1:4200/v1",
      api: "openai-responses",
      apiKey: FAKE_MODEL_API_KEY,
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      inputModalities: ["text"],
      hostedTools: ["web_search"],
    });
    expect(lease.runtime.getModel("deepseek", "deepseek-v4-flash")).toMatchObject({
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:4200/v1",
      input: ["text"],
      compat: {
        supportsDeveloperRole: false,
        supportsLongCacheRetention: false,
      },
    });
    lease.release();
  });

  it.each(["rate_limit", "disconnect"] as const)(
    "recovers native Pi sampling through the HTTP transport: %s",
    async (failure) => {
      const fake = new FakeModelServer({ scenarioSequence: [failure, "text"] });
      await fake.start();
      const session = new Session(
        new InMemorySessionStorage({ id: command.payload.sessionId, createdAt: Date.now() }),
      );
      const authority = new TestAuthority();
      const events: EventPublishMessage[] = [];
      const checkpointOperations: PiSessionMutationOperation[] = [];
      const checkpointEvents: PiCloudEvent[] = [];
      const turn = createCloudTurnContext(command);
      const attempt = createCloudExecutionContext({
        command,
        runtimeIdentity: {
          supervisorId: "supervisor-cloud-test",
          bootId: "77777777-7777-4777-8777-777777777778",
          sandboxId: "sandbox-cloud-test",
        },
        turnContextSha256: turn.sha256,
      });
      let stepSequence = 0;
      let authorityWasActiveAtSettlement = false;
      let receivedSystemPrompt = "";
      const sourceEvents: string[] = [];
      let hostedActivityListener: ((activity: ProviderHostedActivity) => void) | undefined;
      let hostedActivityStarted = false;
      const modelPreparationStarted = deferred<void>();
      const sessionPreparationStarted = deferred<void>();
      const runner = new PiCloudTurnRunner({
        resolveModelRuntime: async () => {
          modelPreparationStarted.resolve(undefined);
          await sessionPreparationStarted.promise;
          return {
            provider: "pi-cloud-fake",
            modelId: "pi-cloud-fake",
            baseUrl: fake.baseUrl,
            api: "openai-completions",
            apiKey: FAKE_MODEL_API_KEY,
            contextWindow: 131_072,
          };
        },
        openSession: async () => {
          sessionPreparationStarted.resolve(undefined);
          await modelPreparationStarted.promise;
          return {
            session,
            lane: "main",
            authority,
            mutationPublisher: {
              async synchronize() {},
              async mutate(operation, attachedEvents = []) {
                if (operation.kind !== "append_items") {
                  throw new Error("Runtime checkpoint must use one atomic append batch");
                }
                const results = [];
                for (const item of operation.items) {
                  results.push(
                    item.kind === "append_entry"
                      ? await session.appendEntry(item.entry, item.lane)
                      : await session.appendRecord(item.record),
                  );
                }
                checkpointOperations.push(operation);
                checkpointEvents.push(...attachedEvents);
                return { items: results };
              },
            },
          };
        },
        sandboxContinuity: {
          continuityId: "88888888-8888-4888-8888-888888888888",
          continuity: "cold_restore",
          environmentSha256: turn.environmentSha256,
          workspaceBindingSha256: turn.workspaceBindingSha256,

          toolPolicySha256: turn.toolPolicySha256,
        },
        subscribeHostedActivity(listener) {
          hostedActivityListener = listener;
          return () => {
            hostedActivityListener = undefined;
          };
        },
        createAgentTools: ({ captureSamplingStep, stepWorldState }) => ({
          tools: [],
          executeWorkflow: async () => {
            throw new Error("unused in this test");
          },
          async systemPrompt(base) {
            receivedSystemPrompt = base;
            return base;
          },
          async transformContext(messages, purpose = "agent") {
            await captureSamplingStep(
              async () => {
                const captured = await stepWorldState.capture();
                return {
                  step: createCloudStepContext({
                    sequence: (stepSequence += 1),
                    turnContextSha256: turn.sha256,
                    executionContextSha256: attempt.sha256,
                    allowedTools: command.payload.toolCapabilities,
                    activeTools: ["read", "write", "edit", "bash"],
                    worldState: captured.worldState,
                  }),
                  modelMessages: captured.modelMessages,
                };
              },
              { publishEvent: purpose === "agent" },
            );
            return messages;
          },
          async transformHeaders(headers = {}) {
            return headers;
          },
        }),
        observeEvent(event) {
          if (event.type === "message_start" && !hostedActivityStarted) {
            hostedActivityStarted = true;
            hostedActivityListener?.({
              phase: "started",
              toolName: "web_search",
              activityId: "ws-integration",
            });
          } else if (event.type === "message_update" && hostedActivityStarted) {
            hostedActivityStarted = false;
            hostedActivityListener?.({
              phase: "completed",
              toolName: "web_search",
              activityId: "ws-integration",
              outcome: "completed",
              action: { type: "search", queries: ["integration source"] },
            });
          }
          sourceEvents.push(
            event.type === "message_end" && event.message.role === "assistant"
              ? `${event.type}:${event.message.errorMessage ?? event.message.stopReason}`
              : event.type,
          );
        },
        onSettled() {
          authorityWasActiveAtSettlement = !authority.closed;
        },
      });

      try {
        const result = await runner
          .run(command, (event) => {
            events.push(event);
          })
          .catch((error: unknown) => {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}: ${sourceEvents.join(",")}`,
            );
          });
        expect(result.stopReason).toBe("stop");
        expect(events.map((event) => event.payload.event.type)).toContain("turn.started");
        expect(events.map((event) => event.payload.event.type)).toContain("assistant.text.delta");
        const eventTypes = events.map((event) => event.payload.event.type);
        expect(eventTypes).toContain("provider.hosted_tool.started");
        expect(eventTypes).toContain("provider.hosted_tool.completed");
        expect(eventTypes.indexOf("provider.hosted_tool.started")).toBeLessThan(
          eventTypes.indexOf("provider.hosted_tool.completed"),
        );
        expect(eventTypes.indexOf("provider.hosted_tool.completed")).toBeLessThan(
          eventTypes.indexOf("assistant.text.delta"),
        );
        const textEvents = events.filter(
          (event) => event.payload.event.type === "assistant.text.delta",
        );
        expect(textEvents).toHaveLength(failure === "disconnect" ? 3 : 2);
        expect(
          textEvents
            .map((event) =>
              event.payload.event.type === "assistant.text.delta"
                ? event.payload.event.payload.text
                : "",
            )
            .join(""),
        ).toBe(
          `${failure === "disconnect" ? "partial-before-disconnect" : ""}PiCloud fake stream OK.`,
        );
        expect(
          events.some(
            ({ payload: { event } }) =>
              event.type === "model.sampling.completed" && event.payload.outcome === "completed",
          ),
        ).toBe(false);
        expect(
          checkpointEvents.some(
            (event) =>
              event.type === "model.sampling.completed" && event.payload.outcome === "completed",
          ),
        ).toBe(true);
        expect(checkpointOperations).toContainEqual(
          expect.objectContaining({
            kind: "append_items",
            items: expect.arrayContaining([
              expect.objectContaining({
                kind: "append_entry",
                entry: expect.objectContaining({ type: "message" }),
              }),
              expect.objectContaining({
                kind: "append_record",
                record: expect.objectContaining({ type: "usage" }),
              }),
            ]),
          }),
        );
        expect(events.map((event) => event.payload.event.type)).toContain(
          "model.sampling.retry.scheduled",
        );
        expect(fake.observations.map((observation) => observation.scenario)).toEqual([
          failure,
          "text",
        ]);
        expect((await session.getStats()).messageCount).toBe(2);
        const entries = await session.findEntriesOnBranch();
        if (failure === "disconnect") {
          expect(
            entries.filter(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "pi-cloud.interrupted_assistant_prefix",
            ),
          ).toHaveLength(1);
        }
        const baseline = entries.find(
          (entry) =>
            entry.type === "custom" && entry.customType === PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE,
        );
        const prompt = entries.find(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
        const retry = entries.find(
          (entry) => entry.type === "custom" && entry.customType === PI_MODEL_RETRY_CUSTOM_TYPE,
        );
        expect(baseline).toBeDefined();
        expect(prompt).toBeDefined();
        expect(retry).toMatchObject({
          type: "custom",
          data: { nextSamplingAttempt: 2, maximumSamplingAttempts: 3 },
        });
        expect(JSON.stringify(buildSessionContext(entries).messages)).not.toContain(
          PI_MODEL_RETRY_CUSTOM_TYPE,
        );
        expect(prompt!.seq).toBeGreaterThan(baseline!.seq);
        expect(authorityWasActiveAtSettlement).toBe(true);
        expect(authority.closed).toBe(true);
        expect(receivedSystemPrompt).toContain("所有对用户可见的内容");
      } finally {
        await fake.stop();
      }
    },
  );
});
