import { FAKE_MODEL_API_KEY, FakeModelServer } from "@pi-cloud/fake-model-server";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  createExecutionLease,
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCloudAttemptContext,
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
    piSession: { id: "session-1", lane: "main" },
    runId: "44444444-4444-4444-8444-444444444444",
    turnId: "turn-1",
    agentId: "root",
    executionLease: createExecutionLease(
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
      async capture() {
        throw new Error("unused");
      },
      async release() {
        throw new Error("unused");
      },
      async stop() {},
      operationUrlFor() {
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

  it("prebinds an existing development machine without reporting a renewed lease as a reset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-development-continuity-"));
    const developmentCommand: ExecuteTurnCommandMessage = {
      ...command,
      payload: {
        ...command.payload,
        executionMode: "development_environment",
        workingDirectory: "/home/user/project",
      },
    };
    const turn = createCloudTurnContext(developmentCommand, undefined);
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
      committedWorkspaceRevision: null,
      toolPolicySha256: turn.toolPolicySha256,
    });
    const authority = new TestAuthority();
    const create = vi.fn(async (request: Parameters<ToolBrokerBoundary["create"]>[0]) => ({
      toolBrokerProtocolVersion: 1 as const,
      type: "tool_sandbox.reserved" as const,
      requestId: request.requestId,
      activationId: "99999999-9999-4999-8999-999999999999",
      executionLease: request.assignment.executionLease,
      ownerBaseUrl: "http://tool-broker.test",
      workspaceRoot: "/home/user/project",
      continuity: "warm_reuse" as const,
      continuityId: "development-runtime-1",
    }));
    const capture = vi.fn(async () => ({
      toolBrokerProtocolVersion: 1 as const,
      type: "tool_sandbox.unused" as const,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      activationId: "99999999-9999-4999-8999-999999999999",
    }));
    const release = vi.fn(async () => ({ retained: false }));
    const broker = {
      create,
      capture,
      async refreshServices() {},
      release,
      async stop() {},
      operationUrlFor() {
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
      expect(create).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(
        (await session.findEntriesOnBranch()).filter(
          (entry) => entry.type === "custom" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
        ),
      ).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detaches a failed Agent Run without destroying or resetting its development machine", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-development-model-failure-"));
    const fake = new FakeModelServer({
      scenarioSequence: ["tool_call", "disconnect", "disconnect", "disconnect"],
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
    const turn = createCloudTurnContext(developmentCommand, undefined);
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
      committedWorkspaceRevision: null,
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
      executionLease: request.assignment.executionLease,
      ownerBaseUrl: "http://tool-broker.test",
      workspaceRoot: "/home/user/project",
      continuity: "warm_reuse" as const,
      continuityId: "development-runtime-1",
    }));
    const capture = vi.fn(async () => {
      throw new Error("A failed model response must not settle the development machine");
    });
    const release = vi.fn(async () => ({ retained: true }));
    const stop = vi.fn(async () => undefined);
    const modelLeaseRelease = vi.fn(async () => undefined);
    const broker = {
      create,
      capture,
      release,
      stop,
      async refreshServices() {},
      operationUrlFor() {
        return "http://tool-broker.test/internal/v1/tool-operation";
      },
    } as ToolBrokerBoundary;
    const runner = new RemoteToolSandboxTurnRunner({
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
    try {
      await expect(
        runner.run(developmentCommand, () => undefined, new AbortController().signal),
      ).rejects.toMatchObject({ code: "model_error" });
      expect(create).toHaveBeenCalledTimes(1);
      expect(capture).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(
        "99999999-9999-4999-8999-999999999998",
        expect.anything(),
        { kind: "detach" },
      );
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
      await fake.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
      const turn = createCloudTurnContext(command, undefined);
      const attempt = createCloudAttemptContext({
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
          committedWorkspaceRevision: null,
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
                    attemptContextSha256: attempt.sha256,
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
