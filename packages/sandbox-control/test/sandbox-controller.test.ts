import { BindingClosurePending } from "../src/sandbox-bindings.ts";
import { InMemorySandboxBindings } from "./helpers/in-memory-sandbox-bindings.ts";
import { SandboxCreationError } from "../src/sandbox-provider.ts";
import { InMemoryWorkspaceRuntimeStateRepository } from "./helpers/in-memory-workspace-runtime-state-repository.ts";
import type { ToolSandboxAssignment, ToolSandboxCreateRequest } from "@pi-cloud/protocol";
import {
  createExecutionReference,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@pi-cloud/protocol";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SandboxControlError,
  CUBESANDBOX_TOOL_POLICY,
  SandboxController,
  loadSandboxControlConfig,
  type SandboxControllerOptions,
  type SandboxCreateSpec,
  type SandboxProvider,
} from "../src/index.ts";

type TestSandboxControlDefaults = "stateRepository" | "ownerBaseUrl" | "imageRevision" | "bindings";
type TestSandboxControllerOptions = Omit<SandboxControllerOptions, TestSandboxControlDefaults> &
  Partial<Pick<SandboxControllerOptions, TestSandboxControlDefaults>>;

function testBroker(options: TestSandboxControllerOptions): SandboxController {
  const bindings = options.bindings ?? new InMemorySandboxBindings();
  const stateRepository = options.stateRepository ?? new InMemoryWorkspaceRuntimeStateRepository();
  if (
    stateRepository instanceof InMemoryWorkspaceRuntimeStateRepository &&
    bindings instanceof InMemorySandboxBindings
  )
    stateRepository.onQuarantine = (id) => bindings.commitPhysicalClosure(id);
  return new SandboxController({
    bindings,
    stateRepository,
    ownerBaseUrl: "http://sandbox-control.test",
    imageRevision: "development",
    ...options,
  });
}

const ACTIVATION_ID = "10000000-0000-4000-8000-000000000010";
const SECOND_ACTIVATION_ID = "20000000-0000-4000-8000-000000000020";
const TURN_CONTEXT_SHA256 = "b".repeat(64);
const ATTEMPT_CONTEXT_SHA256 = "c".repeat(64);
const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-provider-test",
  projectId: "project-provider-test",
  workspaceId: "workspace-provider-test",
  supervisorId: "supervisor-provider-test",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
  runId: "command-provider-test",
  sessionId: "session-provider-test",
  turnId: "turn-provider-test",
  executionReference: createExecutionReference(
    "10000000-0000-4000-8000-000000000003",
    "10000000-0000-4000-8000-000000000003",
    5,
  ),
};
const environment = {
  environmentVersionId: "10000000-0000-4000-8000-000000000004",
  versionNumber: 1,
  profileKey: "pi-cloud-fullstack" as const,
  profileVersion: "1" as const,
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};
const environmentValidation = {
  profileKey: "pi-cloud-fullstack" as const,
  profileVersion: "1" as const,
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  isolationBoundary: "microvm" as const,
  runtime: "cubesandbox-kvm" as const,
  networkMode: "public_web_proxy_private_denied" as const,
  runAsUser: "1000:1000" as const,
  readOnlyRootFilesystem: false as const,
  tools: [
    { name: "node" as const, version: "v24.18.0" },
    { name: "java" as const, version: 'openjdk version "17.0.19"' },
    { name: "python" as const, version: "Python 3.11.2" },
    { name: "git" as const, version: "git version 2.39.5" },
  ],
  recipeCommands: [],
};

const createRequest: ToolSandboxCreateRequest = {
  toolBrokerProtocolVersion: 1,
  type: "tool_sandbox.create",
  requestId: "10000000-0000-4000-8000-000000000011",
  sandboxProfileKey: "standard",
  toolRoot: "/workspace",
  assignment,
  turnContextSha256: TURN_CONTEXT_SHA256,
  executionContextSha256: ATTEMPT_CONTEXT_SHA256,
  allowedTools: ["read", "write", "edit", "bash"],
  executionMode: "elastic",
  environment,
  workspaceSeed: { kind: "sample_java" },
};

function providerFixture() {
  let createSpec: SandboxCreateSpec | undefined;
  let createCount = 0;
  let destroyed = false;
  let runtimeState: "running" | "paused" = "running";
  const terminalInput = vi.fn(async () => undefined);
  const terminalResize = vi.fn(async () => undefined);
  const discoverHttpServices = vi.fn<NonNullable<SandboxProvider["discoverHttpServices"]>>(
    async () => ({ listeningPorts: [], httpServices: [] }),
  );
  const listWorkspaceDirectory = vi.fn<NonNullable<SandboxProvider["listWorkspaceDirectory"]>>(
    async (request) => ({
      toolBrokerProtocolVersion: 1,
      type: "workspace.directory_listed",
      requestId: request.requestId,
      tenantId: request.tenantId,
      workspaceId: request.workspaceId,
      path: request.path,
      entries: [],
      truncated: false,
    }),
  );
  const readWorkspaceFile = vi.fn<NonNullable<SandboxProvider["readWorkspaceFile"]>>(
    async (request) => ({
      toolBrokerProtocolVersion: 1,
      type: "workspace.file_read",
      requestId: request.requestId,
      tenantId: request.tenantId,
      workspaceId: request.workspaceId,
      path: request.path,
      content: Buffer.from("source\n").toString("base64"),
      sha256: createHash("sha256").update("source\n").digest("hex"),
      executable: false,
      sizeBytes: 7,
    }),
  );
  const pause = vi.fn<NonNullable<SandboxProvider["pause"]>>(async () => {
    runtimeState = "paused";
  });
  const resume = vi.fn<NonNullable<SandboxProvider["resume"]>>(async (handle) => {
    runtimeState = "running";
    return handle;
  });
  const persistentCapsule = vi.fn<NonNullable<SandboxProvider["persistentCapsule"]>>(
    async (handle) => ({ handle, capsule: "test-exclusive-machine-capsule" }),
  );
  const probeExecution = vi.fn<NonNullable<SandboxProvider["probeExecution"]>>(async (handle) => ({
    continuityId: handle.runtimeId,
  }));
  const adoptPersistentCapsule = vi.fn<NonNullable<SandboxProvider["adoptPersistentCapsule"]>>(
    async () => {
      throw new Error("Provider fixture has no detached machine to adopt");
    },
  );
  const detachPersistent = vi.fn<NonNullable<SandboxProvider["detachPersistent"]>>(
    async () => undefined,
  );
  const openPreviewConnection = vi.fn<NonNullable<SandboxProvider["openPreviewConnection"]>>(
    async () => new PassThrough(),
  );
  const listDirectory = vi.fn<NonNullable<SandboxProvider["listDirectory"]>>(
    async (_handle, path) => ({
      path,
      entries: [],
    }),
  );
  const createDirectory = vi.fn<NonNullable<SandboxProvider["createDirectory"]>>(
    async (_handle, path, name) => ({
      path,
      entries: [{ name, path: `${path === "/" ? "" : path}/${name}`, kind: "directory" }],
    }),
  );
  const provider: SandboxProvider = {
    providerId: "cubesandbox",
    async describeExecution(handle, bindingId, toolRoot) {
      return {
        version: 2,
        target: {
          apiUrl: "http://cube.test",
          sandboxId: handle.runtimeName,
          nodeId: "node-test",
          bootId: "11111111-1111-4111-8111-111111111111",
        },
        attachment: {
          activationId: bindingId,
          toolRoot,
        },
      };
    },
    executionIdentity(handle) {
      return handle.activationId;
    },
    async observeRuntimeInventory() {
      return new Map();
    },
    async observeRuntime(handle) {
      return {
        runtimeName: handle.runtimeName,
        nodeId: "node-test",
        presence: "present",
        state: "running",
      };
    },
    defaultPolicy: CUBESANDBOX_TOOL_POLICY,
    async checkHealth() {},
    async create(spec, authorization) {
      createCount += 1;
      createSpec = spec;
      return {
        allocation: authorization,
        runtimeNodeId: "node-test",
        providerApiVersion: 1,
        providerId: "cubesandbox",
        activationId: spec.activationId,
        runtimeId: "66666666-6666-4666-8666-666666666666",
        runtimeName: `pi-cloud-tool-${spec.activationId}`.slice(0, 63),
        workspaceRoot: spec.toolRoot ?? "/workspace",
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation,
      };
    },
    discoverHttpServices,
    async openTerminal() {
      return {
        pid: 77,
        output: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from("shell\r\n");
          },
        },
        sendInput: terminalInput,
        resize: terminalResize,
        async kill() {},
        disconnect() {},
      };
    },
    openPreviewConnection,
    listDirectory,
    createDirectory,
    pause,
    resume,
    persistentCapsule,
    probeExecution,
    adoptPersistentCapsule,
    detachPersistent,
    listWorkspaceDirectory,
    readWorkspaceFile,
    async destroy() {
      destroyed = true;
    },
    async inspect(handle) {
      return {
        providerApiVersion: 1,
        providerId: "cubesandbox",
        state: runtimeState,
        handle,
        effectiveIsolation: {
          isolationBoundary: "microvm",
          runtime: "cubesandbox-kvm",
          user: "1000:1000",
          privileged: false,
          readOnlyRootFilesystem: false,
          networkMode: "public_web_proxy_private_denied",
          mountCount: 0,
          hasDockerSocket: false,
          pidLimit: 128,
          processLimit: 128,
          memoryBytes: 768 * 1_024 * 1_024,
          cpuNano: 1_000_000_000,
          droppedCapabilities: ["ALL"],
          securityOptions: ["no-new-privileges"],
          sandboxKernelRelease: "6.1.0-cube",
        },
      };
    },
    async destroyPersistentCapsule() {},
    async destroyRuntime() {},
    async close() {},
  };
  return {
    provider,
    discoverHttpServices,
    listWorkspaceDirectory,
    readWorkspaceFile,
    terminalInput,
    terminalResize,
    pause,
    resume,
    persistentCapsule,
    probeExecution,
    detachPersistent,
    openPreviewConnection,
    listDirectory,
    createDirectory,
    get createSpec() {
      return createSpec;
    },
    get createCount() {
      return createCount;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

describe("provider-backed Sandbox controller", () => {
  it.each([false, true])(
    "prepares immutable input images without an Agent Tool and waits for guest cancellation (cancel=%s)",
    async (cancel) => {
      const fixture = providerFixture(),
        repository = new InMemoryWorkspaceRuntimeStateRepository();
      const bytes = Buffer.from("image-source"),
        source = {
          id: crypto.randomUUID(),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.length,
          mimeType: "image/png" as const,
        };
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>();
      const prepare = vi.fn<NonNullable<SandboxProvider["prepareInputImage"]>>(
        async (_handle, content) => {
          const received: Uint8Array[] = [];
          for await (const chunk of content.chunks) received.push(chunk);
          expect(Buffer.concat(received)).toEqual(bytes);
          expect(content.byteLength).toBe(bytes.length);
          entered.resolve();
          if (cancel) await finish.promise;
          return { data: bytes.toString("base64"), mimeType: "image/png", hints: [] };
        },
      );
      fixture.provider.prepareInputImage = prepare;
      const withStream = vi.fn(async (tenantId, ref, consume, signal) => {
        expect(tenantId).toBe(assignment.tenantId);
        expect(ref).toEqual(source);
        return consume(
          (async function* () {
            yield bytes;
          })(),
          signal,
        );
      });
      const put = vi.fn(async () => source);
      const broker = testBroker({
        provider: fixture.provider,
        stateRepository: repository,
        inputImages: { withStream, put },
      });
      const reserved = await broker.create(createRequest);
      const request = {
        toolBrokerProtocolVersion: 1 as const,
        type: "tool_sandbox.prepare_input_images" as const,
        requestId: crypto.randomUUID(),
        activationId: reserved.activationId,
        assignment,
        images: [source],
      };
      const controller = new AbortController();
      let settled = false;
      const result = broker.prepareInputImages(request, controller.signal).then(
        (value) => {
          settled = true;
          return value;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      try {
        await entered.promise;
        if (cancel) {
          controller.abort(new Error("cancelled"));
          let released = false;
          const release = broker
            .release({
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.release",
              requestId: crypto.randomUUID(),
              activationId: reserved.activationId,
              assignment,
              disposition: "keep_warm",
            })
            .then(() => {
              released = true;
            });
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(settled).toBe(false);
          expect(released).toBe(false);
          await expect(
            broker.prepareInputImages({ ...request, requestId: crypto.randomUUID() }),
          ).rejects.toMatchObject({ code: "steer_target_unavailable" });
          finish.resolve();
          expect(await result).toBeInstanceOf(Error);
          await release;
        } else
          expect(await result).toMatchObject({
            images: [{ sourceId: source.id, image: source, hints: [] }],
          });
        expect(put).not.toHaveBeenCalled();
        expect(prepare).toHaveBeenCalledOnce();
      } finally {
        finish.resolve();
        await result;
        await broker.close();
      }
    },
  );

  it("reports a machine snapshot failure while preserving the VM and closing ownership", async () => {
    const fixture = providerFixture(),
      repository = new InMemoryWorkspaceRuntimeStateRepository();
    const closeRepository = vi.spyOn(repository, "close");
    const closeProvider = vi.spyOn(fixture.provider, "close");
    const broker = testBroker({ provider: fixture.provider, stateRepository: repository });
    await broker.provisionDevelopmentEnvironment({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: crypto.randomUUID(),
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "fixture-user",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      generation: 1,
      profileKey: "standard",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    const failure = new Error("machine snapshot unavailable");
    fixture.persistentCapsule.mockRejectedValueOnce(failure);
    await expect(broker.close()).rejects.toBe(failure);
    expect(fixture.destroyed).toBe(false);
    expect(fixture.detachPersistent).toHaveBeenCalledOnce();
    expect(closeProvider).toHaveBeenCalledOnce();
    expect(closeRepository).toHaveBeenCalledOnce();
    await expect(
      repository.developmentEnvironmentOwner(assignment.tenantId, "fixture-user", ACTIVATION_ID),
    ).resolves.toMatchObject({ status: "owned", state: "unknown" });
  });

  it("does not overwrite the first shutdown error when ownership cleanup also fails", async () => {
    const fixture = providerFixture(),
      repository = new InMemoryWorkspaceRuntimeStateRepository();
    const first = new Error("provider close failed"),
      second = new Error("ownership close failed");
    vi.spyOn(fixture.provider, "close").mockRejectedValue(first);
    vi.spyOn(repository, "close").mockRejectedValue(second);
    const broker = testBroker({ provider: fixture.provider, stateRepository: repository });
    await expect(broker.close()).rejects.toMatchObject({ errors: [first, second], cause: first });
  });

  it("adopts active elastic bindings after controller restart without stopping native execution", async () => {
    const fixture = providerFixture(),
      bindings = new InMemorySandboxBindings();
    const create = vi.spyOn(fixture.provider, "create"),
      stop = vi.spyOn(bindings, "closeBinding");
    const first = testBroker({
      provider: fixture.provider,
      bindings,
      idGenerator: () => ACTIVATION_ID,
    });
    const binding = await first.create(createRequest);
    const handle = await create.mock.results[0]!.value;
    await first.close();
    expect(stop).not.toHaveBeenCalled();
    expect(fixture.destroyed).toBe(false);
    expect(bindings.rows.has(binding.activationId)).toBe(true);
    const state = new InMemoryWorkspaceRuntimeStateRepository();
    vi.spyOn(state, "claimRecoverableWorkspaceRuntimes").mockResolvedValueOnce([
      {
        activationId: ACTIVATION_ID,
        runtimeCapsule: "test-exclusive-machine-capsule",
        sandboxProfileKey: "standard",
        workspace: assignment,
      },
    ]);
    vi.spyOn(fixture.provider, "adoptPersistentCapsule").mockResolvedValue(handle);
    const second = testBroker({ provider: fixture.provider, bindings, stateRepository: state });
    expect(await second.recoverPersistentDevelopmentEnvironments()).toBe(1);
    expect(second.ownsToolBinding(binding.activationId)).toBe(true);
    expect(second.admittedCount).toBe(1);
    expect(fixture.createCount).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    await second.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: binding.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith(binding.activationId, assignment, false);
    expect(fixture.destroyed).toBe(false);
    await second.close();
  });

  it("retries pending ordered closure without quarantining or partially restoring a shared VM", async () => {
    const fixture = providerFixture(),
      bindings = new InMemorySandboxBindings();
    const create = vi.spyOn(fixture.provider, "create");
    const first = testBroker({ provider: fixture.provider, bindings });
    const active = await first.create(createRequest);
    const next = nextBindingRequest(assignment.workspaceId);
    const closing = await first.create(next);
    const handle = await create.mock.results[0]!.value;
    await first.close();
    bindings.rows.set(closing.activationId, {
      ...bindings.rows.get(closing.activationId)!,
      dispatchClosed: true,
    });
    bindings.onClose = async () => {
      throw new BindingClosurePending(new Error("publication unavailable"));
    };
    const state = new InMemoryWorkspaceRuntimeStateRepository();
    vi.spyOn(state, "claimRecoverableWorkspaceRuntimes").mockImplementation(
      async (_limit, excluded = []) =>
        excluded.includes(handle.activationId)
          ? []
          : [
              {
                activationId: handle.activationId,
                runtimeCapsule: "test-exclusive-machine-capsule",
                sandboxProfileKey: "standard",
                workspace: assignment,
              },
            ],
    );
    const update = vi.spyOn(state, "setWorkspaceRuntimeState");
    vi.spyOn(fixture.provider, "adoptPersistentCapsule").mockResolvedValue(handle);
    const replacement = testBroker({
      provider: fixture.provider,
      bindings,
      stateRepository: state,
    });
    expect(await replacement.recoverPersistentDevelopmentEnvironments()).toBe(0);
    expect(replacement.ownsToolBinding(active.activationId)).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(fixture.destroyed).toBe(false);
    bindings.onClose = async () => {};
    expect(await replacement.recoverPersistentDevelopmentEnvironments()).toBe(1);
    expect(replacement.ownsToolBinding(active.activationId)).toBe(true);
    expect(replacement.ownsToolBinding(closing.activationId)).toBe(false);
    expect(update).toHaveBeenCalledWith(handle.activationId, "active", expect.anything());
    await replacement.close();
  });

  it("retires an orphaned terminal channel while preserving its shared VM", async () => {
    vi.useFakeTimers();
    const fixture = providerFixture(),
      state = new InMemoryWorkspaceRuntimeStateRepository();
    const retire = vi.spyOn(state, "setTerminalState"),
      destroy = vi.spyOn(fixture.provider, "destroyRuntime");
    vi.spyOn(state, "claimOrphanedTerminals").mockResolvedValueOnce([
      {
        terminalId: ACTIVATION_ID,
        tenantId: assignment.tenantId,
        userId: "user",
        projectId: assignment.projectId,
        workspaceId: assignment.workspaceId,
        sessionId: assignment.sessionId,
        fencingToken: 1,
        sharedRuntime: true,
      },
    ]);
    const manager = testBroker({ provider: fixture.provider, stateRepository: state });
    try {
      await vi.advanceTimersByTimeAsync(30001);
      expect(retire).toHaveBeenCalledWith(ACTIVATION_ID, "released");
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("separates compute on one Workspace and keeps each binding's explicit cwd", async () => {
    const fixture = providerFixture(),
      bindings = new InMemorySandboxBindings();
    let now = 1_000;
    const stop = vi.spyOn(fixture.provider, "destroy");
    const created: SandboxCreateSpec[] = [];
    const original = fixture.provider.create;
    fixture.provider.create = async (spec, authorization) => {
      created.push(spec);
      return { ...(await original(spec, authorization)), runtimeId: spec.activationId };
    };
    const manager = testBroker({
      provider: fixture.provider,
      bindings,
      maximumActiveSandboxes: 4,
      warmTtlMs: 1_000,
      clock: () => now,
    });
    const scope = crypto.randomUUID();
    const childAssignment = (suffix: string): ToolSandboxAssignment => ({
      ...assignment,
      sessionId: suffix,
      turnId: suffix,
    });
    const child = childAssignment("child"),
      descendant = childAssignment("descendant");
    try {
      const root = await manager.create(createRequest);
      const one = await manager.create({
        ...createRequest,
        requestId: crypto.randomUUID(),
        assignment: child,
        computeSessionId: scope,
        toolRoot: "/workspace/worktrees/a",
      });
      const two = await manager.create({
        ...createRequest,
        requestId: crypto.randomUUID(),
        assignment: descendant,
        computeSessionId: scope,
        toolRoot: "/workspace/worktrees/b",
      });
      expect(created).toHaveLength(2);
      expect(created.map((spec) => spec.assignment.workspaceId)).toEqual([
        assignment.workspaceId,
        assignment.workspaceId,
      ]);
      expect(created.map((spec) => spec.volumeMountPath)).toEqual(["/workspace", "/workspace"]);
      expect([...bindings.rows.values()].map((row) => row.descriptor.attachment.toolRoot)).toEqual([
        "/workspace",
        "/workspace/worktrees/a",
        "/workspace/worktrees/b",
      ]);
      expect(one.continuityId).toBe(two.continuityId);
      expect(root.continuityId).not.toBe(one.continuityId);
      await manager.release({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: crypto.randomUUID(),
        activationId: one.activationId,
        assignment: child,
        disposition: "keep_warm",
      });
      expect(created).toHaveLength(2);
      await manager.release({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: crypto.randomUUID(),
        activationId: two.activationId,
        assignment: descendant,
        disposition: "keep_warm",
      });
      expect(manager.warmCount).toBe(1);
      now += 2_000;
      await manager.reapWarm();
      expect(manager.warmCount).toBe(0);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop.mock.calls[0]?.[0].activationId).toBe(created[1]?.activationId);
      expect(manager.ownsToolBinding(root.activationId)).toBe(true);
      expect(created).toHaveLength(2);
    } finally {
      await manager.close();
    }
  });
  it("does not retain a destroyed development handle when state publication fails", async () => {
    const fixture = providerFixture();
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    vi.spyOn(repository, "setDevelopmentEnvironmentState").mockRejectedValueOnce(
      new Error("state commit rejected"),
    );
    const manager = testBroker({ provider: fixture.provider, stateRepository: repository });
    try {
      await expect(
        manager.provisionDevelopmentEnvironment({
          developmentEnvironmentProtocolVersion: 1,
          type: "development_environment.provision",
          requestId: crypto.randomUUID(),
          environmentId: ACTIVATION_ID,
          tenantId: assignment.tenantId,
          userId: "fixture-user",
          projectId: assignment.projectId,
          workspaceId: assignment.workspaceId,
          generation: 1,
          profileKey: "standard",
          environment,
          workspaceSeed: { kind: "sample_java" },
        }),
      ).rejects.toThrow("state commit rejected");
      expect(fixture.destroyed).toBe(true);
      expect(manager.admittedCount).toBe(0);
      expect(manager.activeCount).toBe(0);
    } finally {
      await manager.close();
    }
  });

  it.each([true, false])(
    "keeps development-machine quota until failed creation proves absence (%s)",
    async (absenceConfirmed) => {
      const fixture = providerFixture();
      const repository = new InMemoryWorkspaceRuntimeStateRepository();
      const state = vi.spyOn(repository, "setDevelopmentEnvironmentState");
      vi.spyOn(fixture.provider, "create").mockRejectedValue(
        new SandboxCreationError(new Error("creation response lost"), absenceConfirmed),
      );
      const manager = testBroker({ provider: fixture.provider, stateRepository: repository });
      try {
        await expect(
          manager.provisionDevelopmentEnvironment({
            developmentEnvironmentProtocolVersion: 1,
            type: "development_environment.provision",
            requestId: crypto.randomUUID(),
            environmentId: ACTIVATION_ID,
            tenantId: assignment.tenantId,
            userId: "fixture-user",
            projectId: assignment.projectId,
            workspaceId: assignment.workspaceId,
            generation: 1,
            profileKey: "standard",
            environment,
            workspaceSeed: { kind: "sample_java" },
          }),
        ).rejects.toThrow();
        expect(manager.admittedCount).toBe(absenceConfirmed ? 0 : 1);
        expect(state).toHaveBeenLastCalledWith(
          ACTIVATION_ID,
          absenceConfirmed ? "failed" : "unknown",
          expect.any(Object),
        );
      } finally {
        await manager.close();
      }
    },
  );

  it("retains the machine handle and quota when failure cleanup cannot confirm destruction", async () => {
    const fixture = providerFixture();
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    const state = vi
      .spyOn(repository, "setDevelopmentEnvironmentState")
      .mockRejectedValueOnce(new Error("PG failed"));
    vi.spyOn(fixture.provider, "destroy").mockRejectedValue(new Error("stop unknown"));
    const manager = testBroker({ provider: fixture.provider, stateRepository: repository });
    try {
      await expect(
        manager.provisionDevelopmentEnvironment({
          developmentEnvironmentProtocolVersion: 1,
          type: "development_environment.provision",
          requestId: crypto.randomUUID(),
          environmentId: ACTIVATION_ID,
          tenantId: assignment.tenantId,
          userId: "fixture-user",
          projectId: assignment.projectId,
          workspaceId: assignment.workspaceId,
          generation: 1,
          profileKey: "standard",
          environment,
          workspaceSeed: { kind: "sample_java" },
        }),
      ).rejects.toThrow("PG failed");
      expect(manager.admittedCount).toBe(1);
      expect(state).toHaveBeenLastCalledWith(
        ACTIVATION_ID,
        "unknown",
        expect.objectContaining({
          handle: expect.objectContaining({ activationId: ACTIVATION_ID }),
          runtimeCapsule: expect.any(String),
        }),
      );
    } finally {
      await manager.close();
    }
  });

  it("requires durable allocation closure even after a retry reports a preflight rejection", async () => {
    const fixture = providerFixture(),
      repository = new InMemoryWorkspaceRuntimeStateRepository();
    const state = vi.spyOn(repository, "setDevelopmentEnvironmentState");
    vi.spyOn(fixture.provider, "create").mockRejectedValue(
      new SandboxCreationError(new Error("local preflight rejected"), true),
    );
    fixture.provider.destroyRuntime = vi.fn(async () => {
      throw new Error("older creation outcome unavailable");
    });
    const manager = testBroker({ provider: fixture.provider, stateRepository: repository });
    try {
      await expect(
        manager.provisionDevelopmentEnvironment({
          developmentEnvironmentProtocolVersion: 1,
          type: "development_environment.provision",
          requestId: randomUUID(),
          environmentId: ACTIVATION_ID,
          tenantId: assignment.tenantId,
          userId: "fixture-user",
          projectId: assignment.projectId,
          workspaceId: assignment.workspaceId,
          generation: 1,
          profileKey: "standard",
          environment,
          workspaceSeed: { kind: "sample_java" },
        }),
      ).rejects.toThrow();
      expect(repository.closedAllocations.has(ACTIVATION_ID)).toBe(true);
      expect(manager.admittedCount).toBe(1);
      expect(state).toHaveBeenLastCalledWith(ACTIVATION_ID, "unknown", expect.any(Object));
    } finally {
      await manager.close();
    }
  });

  it("coalesces concurrent provisioning of the same development machine", async () => {
    const fixture = providerFixture();
    const manager = testBroker({ provider: fixture.provider });
    const request: Parameters<SandboxController["provisionDevelopmentEnvironment"]>[0] = {
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: crypto.randomUUID(),
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "fixture-user",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      generation: 1,
      profileKey: "standard",
      environment,
      workspaceSeed: { kind: "sample_java" },
    };
    try {
      const responses = await Promise.all([
        manager.provisionDevelopmentEnvironment(request),
        manager.provisionDevelopmentEnvironment({ ...request, requestId: crypto.randomUUID() }),
      ]);
      expect(responses.every((response) => response.type === "development_environment.state")).toBe(
        true,
      );
      expect(fixture.createCount).toBe(1);
      expect(manager.admittedCount).toBe(1);
    } finally {
      await manager.close();
    }
  });

  it("keeps global resource reconciliation off the reservation critical path", async () => {
    const fixture = providerFixture();
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    const retired = vi.spyOn(repository, "listRetiredWarmWorkspaceRuntimeIds");
    const orphaned = vi.spyOn(repository, "claimOrphanedWorkspaceRuntimes");
    const terminal = vi.spyOn(repository, "claimUnboundWorkspaceRuntimes");
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository: repository,
      idGenerator: () => ACTIVATION_ID,
    });

    await expect(manager.create(createRequest)).resolves.toMatchObject({
      activationId: createRequest.requestId,
    });
    expect(retired).not.toHaveBeenCalled();
    expect(orphaned).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();

    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: createRequest.requestId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    await manager.close();
  });

  it("admits simultaneous Tool bindings for two Sessions sharing one Workspace", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
    });
    const siblingAssignment: ToolSandboxAssignment = {
      ...assignment,
      sandboxId: "20000000-0000-4000-8000-000000000021",
      runId: "second-shared-workspace-run",
      sessionId: "second-shared-workspace-session",
      turnId: "second-shared-workspace-turn",
      executionReference: createExecutionReference(
        "20000000-0000-4000-8000-000000000022",
        "20000000-0000-4000-8000-000000000023",
        6,
      ),
    };

    const firstReservation = manager.create(createRequest);
    let secondResolved = false;
    const secondReservation = manager
      .create({
        ...createRequest,
        requestId: "20000000-0000-4000-8000-000000000024",
        assignment: siblingAssignment,
      })
      .then((result) => {
        secondResolved = true;
        return result;
      });

    await expect(firstReservation).resolves.toMatchObject({
      activationId: createRequest.requestId,
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(secondResolved).toBe(true);
    const second = await secondReservation;
    expect(second.activationId).toBe("20000000-0000-4000-8000-000000000024");
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: createRequest.requestId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: second.activationId,
      assignment: siblingAssignment,
      disposition: "keep_warm",
    });
    await manager.close();
  });

  it("keeps a user-owned development KVM across PTY disconnect and supports pause/resume", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    await expect(
      manager.provisionDevelopmentEnvironment({
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.provision",
        requestId: "11111111-1111-4111-8111-111111111111",
        environmentId: ACTIVATION_ID,
        tenantId: assignment.tenantId,
        userId: "77777777-7777-4777-8777-777777777777",
        projectId: assignment.projectId,
        workspaceId: assignment.workspaceId,
        generation: 1,
        profileKey: "standard",
        environment,
        workspaceSeed: { kind: "sample_java" },
      }),
    ).resolves.toMatchObject({ state: "running" });
    expect(fixture.createSpec?.toolRoot).toBe("/home/user");
    const agent = await manager.create({
      ...createRequest,
      executionMode: "development_environment",
    });
    expect(agent.activationId).toBe(createRequest.requestId);
    expect(agent).toMatchObject({
      continuity: "warm_reuse",
      continuityId: "66666666-6666-4666-8666-666666666666",
    });
    await expect(
      manager.release({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: "21111111-1111-4111-8111-111111111113",
        activationId: agent.activationId,
        assignment,
        disposition: "detach",
      }),
    ).resolves.toMatchObject({ retained: true });
    expect(fixture.createCount).toBe(1);
    await expect(
      manager.browseDevelopmentEnvironment({
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.create_directory",
        requestId: "21111111-1111-4111-8111-111111111121",
        environmentId: ACTIVATION_ID,
        tenantId: assignment.tenantId,
        userId: "77777777-7777-4777-8777-777777777777",
        path: "/home/user",
        name: "new-project",
      }),
    ).resolves.toMatchObject({
      type: "development_environment.directory",
      entries: [{ name: "new-project", kind: "directory" }],
    });
    expect(fixture.createDirectory).toHaveBeenCalledWith(
      expect.anything(),
      "/home/user",
      "new-project",
    );
    const secondAssignment = {
      ...assignment,
      turnId: "21111111-1111-4111-8111-111111111114",
      runId: "second-development-environment-run",
      executionReference: createExecutionReference(
        "21111111-1111-4111-8111-111111111116",
        "21111111-1111-4111-8111-111111111115",
        3,
      ),
    };
    const secondAgent = await manager.create({
      ...createRequest,
      requestId: "21111111-1111-4111-8111-111111111117",
      assignment: secondAssignment,
      executionMode: "development_environment",
    });
    expect(secondAgent).toMatchObject({
      continuity: "warm_reuse",
      continuityId: "66666666-6666-4666-8666-666666666666",
    });
    await expect(
      manager.browseDevelopmentEnvironment({
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.create_directory",
        requestId: "21111111-1111-4111-8111-111111111122",
        environmentId: ACTIVATION_ID,
        tenantId: assignment.tenantId,
        userId: "77777777-7777-4777-8777-777777777777",
        path: "/home/user",
        name: "created-concurrently",
      }),
    ).resolves.toMatchObject({
      type: "development_environment.directory",
      entries: [{ name: "created-concurrently", kind: "directory" }],
    });
    const concurrentTerminal = await manager.openDevelopmentEnvironmentTerminal({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment_terminal.open",
      requestId: "22222222-2222-4222-8222-222222222222",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      rows: 24,
      cols: 100,
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: secondAgent.activationId,
      assignment: secondAssignment,
      disposition: "detach",
    });
    expect(fixture.createCount).toBe(1);
    expect(fixture.destroyed).toBe(false);
    await concurrentTerminal.close();
    expect(fixture.destroyed).toBe(false);
    await manager.developmentEnvironmentLifecycle({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      requestId: "33333333-3333-4333-8333-333333333333",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      action: "pause",
    });
    expect(fixture.pause).toHaveBeenCalledOnce();
    await manager.developmentEnvironmentLifecycle({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      requestId: "44444444-4444-4444-8444-444444444444",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      action: "resume",
    });
    expect(fixture.resume).toHaveBeenCalledOnce();
    await manager.developmentEnvironmentLifecycle({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.lifecycle",
      requestId: "55555555-5555-4555-8555-555555555555",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      action: "release",
    });
    expect(fixture.destroyed).toBe(true);
    await manager.close();
  });

  it("gives parent and child Conversations of one Run independent bindings to one development KVM", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.provisionDevelopmentEnvironment({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: "21600000-0000-4000-8000-000000000001",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      generation: 1,
      profileKey: "standard",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    const parentPending = manager.create({
      ...createRequest,
      executionMode: "development_environment",
    });
    const childAssignment: ToolSandboxAssignment = {
      ...assignment,
      sessionId: "session-provider-test-child",
      turnId: "turn-provider-test-child",
    };
    const [parent, child] = await Promise.all([
      parentPending,
      manager.create({
        ...createRequest,
        requestId: "21600000-0000-4000-8000-000000000004",
        assignment: childAssignment,
        executionMode: "development_environment",
      }),
    ]);
    expect(parent.activationId).toBe(createRequest.requestId);
    expect(child.activationId).toBe("21600000-0000-4000-8000-000000000004");
    expect(child.continuityId).toBe(parent.continuityId);
    expect(fixture.listDirectory).not.toHaveBeenCalled();
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "21600000-0000-4000-8000-000000000007",
      activationId: child.activationId,
      assignment: childAssignment,
      disposition: "detach",
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "21600000-0000-4000-8000-000000000008",
      activationId: parent.activationId,
      assignment,
      disposition: "detach",
    });
    expect(fixture.createCount).toBe(1);
    await manager.close();
  });

  it("releases a database-owned development environment after its in-memory handle is lost", async () => {
    const fixture = providerFixture();
    const destroyRuntime = vi.fn(async () => undefined);
    fixture.provider.destroyRuntime = destroyRuntime;
    const stateRepository = new InMemoryWorkspaceRuntimeStateRepository();
    const environmentId = "21111111-1111-4111-8111-111111111121";
    vi.spyOn(stateRepository, "closeAllocation").mockResolvedValue({
      status: "authorized",
      authorization: { createBefore: Date.now() + 300_000 },
    });
    await stateRepository.reserveDevelopmentEnvironment({
      environmentId,
      tenantId: assignment.tenantId,
      userId: "user-provider-test",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      environmentVersionId: environment.environmentVersionId,
      generation: 3,
      profileKey: "standard",
    });
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository,
      idGenerator: () => ACTIVATION_ID,
    });

    await expect(
      manager.developmentEnvironmentLifecycle({
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.lifecycle",
        requestId: "21111111-1111-4111-8111-111111111122",
        environmentId,
        tenantId: assignment.tenantId,
        userId: "user-provider-test",
        action: "release",
      }),
    ).resolves.toMatchObject({ state: "released" });
    expect(destroyRuntime).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("leaves a running development KVM online while its Sandbox control shuts down", async () => {
    const fixture = providerFixture();
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository: repository,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.provisionDevelopmentEnvironment({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: "61111111-1111-4111-8111-111111111111",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      generation: 1,
      profileKey: "standard",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });

    await manager.close();

    expect(fixture.pause).not.toHaveBeenCalled();
    expect(fixture.detachPersistent).toHaveBeenCalledOnce();
    expect(fixture.destroyed).toBe(false);
    await expect(
      repository.developmentEnvironmentOwner(
        assignment.tenantId,
        "77777777-7777-4777-8777-777777777777",
        ACTIVATION_ID,
      ),
    ).resolves.toMatchObject({ status: "owned", state: "running" });
  });

  it("quarantines a broken development binding without deleting its VM, capsule or first error", async () => {
    const fixture = providerFixture();
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    const returnMachine = vi.spyOn(repository, "returnDevelopmentEnvironment");
    const destroyRuntime = vi.spyOn(fixture.provider, "destroyRuntime");
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository: repository,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.provisionDevelopmentEnvironment({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: "63111111-1111-4111-8111-111111111111",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      generation: 1,
      profileKey: "standard",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    const binding = await manager.create({
      ...createRequest,
      executionMode: "development_environment",
    });
    await manager.quarantineExecutionTarget({
      apiUrl: "http://cube.test",
      sandboxId: `pi-cloud-tool-${ACTIVATION_ID}`.slice(0, 63),
      nodeId: "node-test",
      bootId: "11111111-1111-4111-8111-111111111111",
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: binding.activationId,
      assignment: assignment,
      disposition: "detach",
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: binding.activationId,
      assignment: assignment,
      disposition: "detach",
    });
    expect(returnMachine).toHaveBeenCalledWith(
      ACTIVATION_ID,
      ACTIVATION_ID,
      "unknown",
      expect.objectContaining({
        handle: expect.objectContaining({ runtimeId: "66666666-6666-4666-8666-666666666666" }),
        runtimeCapsule: "test-exclusive-machine-capsule",
        failureCode: "cubesandbox_tool_unavailable",
      }),
    );
    expect(destroyRuntime).not.toHaveBeenCalled();
    expect(fixture.destroyed).toBe(false);
    await manager.recoverPersistentDevelopmentEnvironments();
    await expect(
      manager.create({ ...createRequest, executionMode: "development_environment" }),
    ).resolves.toMatchObject({ continuity: "warm_reuse" });
    expect(fixture.createCount).toBe(1);
    await manager.close();
    expect(fixture.destroyed).toBe(false);
  });

  it("returns a borrowed development KVM to machine authority before Broker shutdown", async () => {
    const fixture = providerFixture();
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository: repository,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.provisionDevelopmentEnvironment({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: "62111111-1111-4111-8111-111111111111",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      generation: 1,
      profileKey: "standard",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    const borrowed = await manager.create({
      ...createRequest,
      executionMode: "development_environment",
    });

    await manager.close();

    expect(borrowed.activationId).toBe(createRequest.requestId);
    expect(fixture.pause).not.toHaveBeenCalled();
    expect(fixture.detachPersistent).toHaveBeenCalledOnce();
    expect(fixture.destroyed).toBe(false);
    await expect(
      repository.developmentEnvironmentOwner(
        assignment.tenantId,
        "77777777-7777-4777-8777-777777777777",
        ACTIVATION_ID,
      ),
    ).resolves.toMatchObject({ status: "owned", state: "running", agentActive: false });
  });

  it("does not add a redundant directory probe to development-machine binding admission", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.provisionDevelopmentEnvironment({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment.provision",
      requestId: "51111111-1111-4111-8111-111111111111",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      generation: 1,
      profileKey: "standard",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    fixture.listDirectory.mockRejectedValueOnce(
      new SandboxControlError(
        "development_environment_directory_unavailable",
        "Directory does not exist",
        false,
      ),
    );
    const binding = await manager.create({
      ...createRequest,
      toolRoot: "/missing",
      executionMode: "development_environment",
    });
    expect(binding.activationId).toBe(createRequest.requestId);
    expect(fixture.listDirectory).not.toHaveBeenCalled();
    expect(fixture.destroyed).toBe(false);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "51111111-1111-4111-8111-111111111113",
      activationId: binding.activationId,
      assignment,
      disposition: "detach",
    });
    const terminal = await manager.openDevelopmentEnvironmentTerminal({
      developmentEnvironmentProtocolVersion: 1,
      type: "development_environment_terminal.open",
      requestId: "51111111-1111-4111-8111-111111111112",
      environmentId: ACTIVATION_ID,
      tenantId: assignment.tenantId,
      userId: "77777777-7777-4777-8777-777777777777",
      rows: 24,
      cols: 100,
    });
    await terminal.close();
    await manager.close();
  });

  it("lets a human terminal and an Agent use the same elastic Workspace", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
    });
    const terminal = await manager.openTerminal({
      tenantId: assignment.tenantId,
      userId: "user-provider-test",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
      environment,
      workspaceSeed: { kind: "sample_java" },
      size: { rows: 24, cols: 100 },
    });
    expect(terminal).toMatchObject({ terminalId: ACTIVATION_ID, pid: 77 });
    await terminal.sendInput(Buffer.from("pwd\r"));
    await terminal.resize({ rows: 40, cols: 120 });
    expect(fixture.terminalInput).toHaveBeenCalledWith(Buffer.from("pwd\r"));
    expect(fixture.terminalResize).toHaveBeenCalledWith({ rows: 40, cols: 120 });
    const agent = await manager.create(createRequest);
    expect(agent.activationId).toBe(createRequest.requestId);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "21500000-0000-4000-8000-000000000002",
      activationId: agent.activationId,
      assignment,
      disposition: "keep_warm",
    });
    expect(fixture.createCount).toBe(1);
    await terminal.close();
    expect(fixture.destroyed).toBe(false);
    expect(manager.warmCount).toBe(1);
    await manager.close();
  });

  it("rejects the removed Session-persistent elastic Sandbox mode", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    await expect(
      manager.create({ ...createRequest, executionMode: "development_environment" }),
    ).rejects.toMatchObject({ code: "elastic_execution_mode_mismatch", retryable: false });
    expect(fixture.createCount).toBe(0);
    await manager.close();
  });

  it("opens a human terminal in the existing warm Workspace runtime", async () => {
    class RetiringTerminalRepository extends InMemoryWorkspaceRuntimeStateRepository {
      override async reserveTerminal(input: { terminalId: string }) {
        return {
          status: "reserved" as const,
          executionReference: createExecutionReference(
            input.terminalId,
            "30000000-0000-4000-8000-000000000001",
            2,
          ),
          workspaceRuntimeId: ACTIVATION_ID,
        };
      }
    }
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository: new RetiringTerminalRepository(),
      idGenerator: (() => {
        const ids = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
        return () => ids.shift()!;
      })(),
    });
    const created = await manager.create({ ...createRequest });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "31000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
    });

    const terminal = await manager.openTerminal({
      tenantId: assignment.tenantId,
      userId: "user-provider-test",
      projectId: assignment.projectId,
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
      environment,
      workspaceSeed: { kind: "sample_java" },
      size: { rows: 24, cols: 100 },
    });
    expect(fixture.createCount).toBe(1);
    expect(manager.warmCount).toBe(0);

    const terminalRunAssignment = {
      ...assignment,
      runId: "command-provider-test-terminal-shared",
      turnId: "turn-provider-test-terminal-shared",
      executionReference: createExecutionReference(
        "31000000-0000-4000-8000-000000000003",
        "31000000-0000-4000-8000-000000000003",
        7,
      ),
    };
    const terminalRun = await manager.create({
      ...createRequest,
      requestId: "31000000-0000-4000-8000-000000000004",
      assignment: terminalRunAssignment,
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "31000000-0000-4000-8000-000000000006",
      activationId: terminalRun.activationId,
      assignment: terminalRunAssignment,
      disposition: "keep_warm",
    });
    expect(fixture.createCount).toBe(1);

    await terminal.close();
    expect(fixture.destroyed).toBe(false);
    expect(manager.warmCount).toBe(1);
    await manager.close();
  });

  it("retains an idle Workspace runtime without a provider authority handoff", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const created = await manager.create({ ...createRequest });
    await expect(
      manager.release({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: "32000000-0000-4000-8000-000000000002",
        activationId: created.activationId,
        assignment,
        disposition: "keep_warm",
      }),
    ).resolves.toMatchObject({ retained: true });
    await manager.close();
  });

  it("proxies a tenant-authorized port through a retained private-ingress Cube", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const created = await manager.create({ ...createRequest });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "32000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
    });

    const connection = await manager.openPreviewConnection({
      tenantId: assignment.tenantId,
      userId: "user-provider-test",
      workspaceId: assignment.workspaceId,
      target: { kind: "conversation", sessionId: assignment.sessionId },
      port: 8000,
      expiresAt: Date.now() + 60_000,
    });
    expect(fixture.openPreviewConnection).toHaveBeenCalledWith(
      expect.objectContaining({ activationId: ACTIVATION_ID }),
      8000,
    );
    connection.destroy();
    await manager.close();
  });

  it("rejects a new activation when the Sandbox Domain is at capacity", async () => {
    class DomainCapacityRepository extends InMemoryWorkspaceRuntimeStateRepository {
      override async reserve() {
        return { status: "capacity" as const };
      }
    }
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      stateRepository: new DomainCapacityRepository(),
    });

    await expect(manager.create(createRequest)).rejects.toMatchObject({
      code: "sandbox_domain_capacity_exhausted",
      retryable: true,
    });
    expect(fixture.createCount).toBe(0);
  });

  it("keeps the Session lease above the provider and binds an immutable identity handle", async () => {
    const fixture = providerFixture(),
      bindings = new InMemorySandboxBindings();
    const manager = testBroker({
      provider: fixture.provider,
      bindings,
      idGenerator: () => ACTIVATION_ID,
    });
    const created = await manager.create(createRequest);
    const row = bindings.rows.get(created.activationId)!;
    expect(row.snapshot.assignment.executionReference).toBe(assignment.executionReference);
    expect(row.descriptor.attachment.toolRoot).toBe(createRequest.toolRoot);
    expect(row.descriptor.target.sandboxId).toBe(
      fixture.createSpec && "pi-cloud-tool-" + ACTIVATION_ID,
    );
    expect(fixture.createCount).toBe(1);
    await manager.close();
  });

  it("records structured HTTP listeners without exposing Preview routing to the model", async () => {
    const fixture = providerFixture();
    fixture.discoverHttpServices.mockResolvedValueOnce({
      listeningPorts: [3_000],
      httpServices: [{ port: 3_000, protocol: "http" }],
    });
    const observe = vi.fn(async () => undefined);
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      serviceRegistry: { observe, async end() {}, async endRuntime() {} },
    });
    const created = await manager.create(createRequest);
    expect(observe).not.toHaveBeenCalled();
    expect(fixture.discoverHttpServices).not.toHaveBeenCalled();
    await manager.refreshServices(created.activationId, assignment);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          kind: "conversation",
          targetId: assignment.sessionId,
        }),
        listeningPorts: [3_000],
        httpServices: [{ port: 3_000, protocol: "http" }],
      }),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: created.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    await manager.close();
  });

  it("enforces the Run Tool snapshot independently of model visibility", async () => {
    const fixture = providerFixture(),
      bindings = new InMemorySandboxBindings();
    const manager = testBroker({
      provider: fixture.provider,
      bindings,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.create({ ...createRequest, allowedTools: ["read"] });
    expect(bindings.rows.get(createRequest.requestId)?.snapshot.allowedTools).toEqual(["read"]);
    expect("execute" in manager).toBe(false);
    await manager.close();
  });

  it("queues materialization behind the global active Sandbox admission limit", async () => {
    const fixture = providerFixture();
    const manager = testBroker({ provider: fixture.provider, maximumActiveSandboxes: 1 });
    const first = await manager.create(createRequest);
    const next = nextBindingRequest("another-workspace");
    const waiting = manager.create(next);
    await vi.waitFor(() => expect(manager.admissionWaitingCount).toBe(1));
    expect(fixture.createCount).toBe(1);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: first.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    const second = await waiting;
    expect(second.workspaceRoot).toBe(next.toolRoot);
    expect(fixture.createCount).toBe(2);
    expect(manager.admissionWaitingCount).toBe(0);
    await manager.close();
  });

  it("closes queued materialization before shutdown releases physical capacity", async () => {
    const fixture = providerFixture();
    const manager = testBroker({ provider: fixture.provider, maximumActiveSandboxes: 1 });
    await manager.create(createRequest);
    const waiting = manager.create(nextBindingRequest("other")).catch((error) => error);
    await vi.waitFor(() => expect(manager.admissionWaitingCount).toBe(1));
    await manager.close();
    expect(await waiting).toMatchObject({ code: "tool_binding_admission_closed" });
    expect(fixture.createCount).toBe(1);
    expect(fixture.destroyed).toBe(false);
    expect(fixture.detachPersistent).toHaveBeenCalledOnce();
  });

  it("reads current Workspace files without consuming Cube admission capacity", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      maximumActiveSandboxes: 1,
    });
    const active = await manager.create(createRequest);
    expect(manager.admittedCount).toBe(1);
    await expect(
      manager.readWorkspaceFile({
        toolBrokerProtocolVersion: 1,
        type: "workspace.read_file",
        requestId: "20000000-0000-4000-8000-000000000051",
        tenantId: assignment.tenantId,
        workspaceId: assignment.workspaceId,
        sessionId: assignment.sessionId,
        rootPath: "",
        path: "surface_check.py",
        maximumBytes: 512 * 1_024,
      }),
    ).resolves.toMatchObject({
      type: "workspace.file_read",
      path: "surface_check.py",
    });
    expect(fixture.readWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: active.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
  });

  it("removes an aborted Tool binding admission waiter without consuming capacity", async () => {
    const fixture = providerFixture();
    const manager = testBroker({ provider: fixture.provider, maximumActiveSandboxes: 1 });
    await manager.create(createRequest);
    const abort = new AbortController();
    const waiting = manager
      .create(nextBindingRequest("other"), abort.signal)
      .catch((error) => error);
    await vi.waitFor(() => expect(manager.admissionWaitingCount).toBe(1));
    abort.abort();
    expect(await waiting).toMatchObject({ code: "tool_binding_admission_cancelled" });
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    expect(fixture.createCount).toBe(1);
    await manager.close();
  });

  it("reuses one Workspace runtime across fenced attempts without reprovisioning", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const first = await manager.create(createRequest);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "10000000-0000-4000-8000-000000000019",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
    });

    const nextAssignment: ToolSandboxAssignment = {
      ...assignment,
      supervisorId: "supervisor-provider-test-next",
      bootId: "20000000-0000-4000-8000-000000000020",
      sandboxId: "20000000-0000-4000-8000-000000000021",
      runId: "command-provider-test-next",
      turnId: "turn-provider-test-next",
      executionReference: createExecutionReference(
        "10000000-0000-4000-8000-000000000020",
        "10000000-0000-4000-8000-000000000020",
        6,
      ),
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "10000000-0000-4000-8000-000000000021",
      assignment: nextAssignment,
    });
    expect(second.activationId).not.toBe(first.activationId);
    expect(second.continuity).toBe("warm_reuse");
    expect(second.continuityId).toBe(first.continuityId);
    expect(fixture.createCount).toBe(1);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: second.activationId,
      assignment: nextAssignment,
      disposition: "keep_warm",
    });
  });

  it("runs parent and child Tool bindings in one shared Workspace runtime", async () => {
    const fixture = providerFixture(),
      bindings = new InMemorySandboxBindings();
    const manager = testBroker({ provider: fixture.provider, bindings });
    const first = await manager.create(createRequest);
    const next = nextBindingRequest(assignment.workspaceId);
    const second = await manager.create(next);
    expect(bindings.rows.get(first.activationId)?.descriptor.target).toEqual(
      bindings.rows.get(second.activationId)?.descriptor.target,
    );
    expect(first.activationId).not.toBe(second.activationId);
    expect(fixture.createCount).toBe(1);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: first.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    expect(manager.reservedCount).toBe(1);
    expect(fixture.destroyed).toBe(false);
    await manager.close();
  });

  it("retires every binding of an orphaned shared Cube before a replacement is allocated", async () => {
    vi.useFakeTimers();
    const fixture = providerFixture();
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    const ids = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository: repository,
      idGenerator: () => ids.shift()!,
    });
    try {
      const initial = await manager.create(createRequest);
      await manager.release({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: crypto.randomUUID(),
        activationId: initial.activationId,
        assignment,
        disposition: "keep_warm",
      });
      const task = (id: string): ToolSandboxAssignment => ({
        ...assignment,
        runId: id,
        turnId: id,
        executionReference: createExecutionReference(crypto.randomUUID(), id, 6),
      });
      const parent = task(crypto.randomUUID()),
        child = task(crypto.randomUUID());
      const a = await manager.create({
        ...createRequest,
        requestId: crypto.randomUUID(),
        assignment: parent,
      });
      const b = await manager.create({
        ...createRequest,
        requestId: crypto.randomUUID(),
        assignment: child,
      });
      expect(a.activationId).not.toBe(initial.activationId);
      expect(b.activationId).not.toBe(initial.activationId);
      expect(manager.reservedCount).toBe(2);
      vi.spyOn(repository, "claimUnboundWorkspaceRuntimes").mockResolvedValueOnce([
        { activationId: ACTIVATION_ID, assignment },
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(manager.reservedCount).toBe(0);
      expect(manager.admittedCount).toBe(0);
      expect(manager.ownsToolBinding(a.activationId)).toBe(false);
      expect(manager.ownsToolBinding(b.activationId)).toBe(false);
      const nextRequestId = crypto.randomUUID();
      const next = await manager.create({
        ...createRequest,
        requestId: nextRequestId,
        assignment: task(crypto.randomUUID()),
      });
      expect(next.activationId).toBe(nextRequestId);
      expect(next.continuity).toBe("cold_restore");
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });

  it("expires every elastic warm runtime at the deployment TTL", async () => {
    const fixture = providerFixture();
    let now = 1_000;
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      warmTtlMs: 1_000,
      clock: () => now,
    });
    const first = await manager.create(createRequest);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "71000000-0000-4000-8000-000000000002",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
    });

    now += 60_000;
    await manager.reapWarm();
    expect(manager.warmCount).toBe(0);
    expect(fixture.destroyed).toBe(true);
  });

  it("releases local compute quota only after an unused runtime is confirmed destroyed", async () => {
    const fixture = providerFixture(),
      repository = new InMemoryWorkspaceRuntimeStateRepository();
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository: repository,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.create(createRequest);
    const claim = vi
      .spyOn(repository, "claimUnboundWorkspaceRuntimes")
      .mockResolvedValue([{ activationId: ACTIVATION_ID, assignment }]);
    const state = vi.spyOn(repository, "setWorkspaceRuntimeState");
    const destroy = vi
      .spyOn(fixture.provider, "destroy")
      .mockRejectedValueOnce(new Error("Cube still alive"));
    await manager.reapWorkspaceRuntimes();
    expect(manager.admittedCount).toBe(1);
    expect(state).toHaveBeenLastCalledWith(ACTIVATION_ID, "unknown", expect.anything());
    destroy.mockResolvedValue(undefined);
    await manager.reapWorkspaceRuntimes();
    expect(manager.admittedCount).toBe(0);
    expect(state).toHaveBeenLastCalledWith(ACTIVATION_ID, "released");
    claim.mockResolvedValue([]);
    await manager.close();
  });

  it("reaps a retained runtime after its Workspace is deleted", async () => {
    class RetiredStateRepository extends InMemoryWorkspaceRuntimeStateRepository {
      retired = false;

      override async listRetiredWarmWorkspaceRuntimeIds(): Promise<readonly string[]> {
        return this.retired ? [ACTIVATION_ID] : [];
      }
    }
    const fixture = providerFixture();
    const stateRepository = new RetiredStateRepository();
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository,
      idGenerator: () => ACTIVATION_ID,
    });
    const created = await manager.create(createRequest);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "72000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
    });

    stateRepository.retired = true;
    await manager.reapRetiredWarm();
    expect(manager.warmCount).toBe(0);
    expect(manager.admittedCount).toBe(0);
    expect(fixture.destroyed).toBe(true);
  });

  it("reuses a warm Workspace runtime from another Session", async () => {
    class TrackingStateRepository extends InMemoryWorkspaceRuntimeStateRepository {
      readonly released: string[] = [];

      override async setWorkspaceRuntimeState(
        activationId: string,
        state: Parameters<InMemoryWorkspaceRuntimeStateRepository["setWorkspaceRuntimeState"]>[1],
      ): Promise<void> {
        if (state === "released") this.released.push(activationId);
      }
    }
    const fixture = providerFixture();
    const stateRepository = new TrackingStateRepository();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository,
      idGenerator: () => activationIds.shift()!,
    });
    const first = await manager.create(createRequest);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "73500000-0000-4000-8000-000000000002",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
    });

    const nextAssignment = {
      ...assignment,
      sessionId: "session-provider-test-conversation-child",
      runId: "command-provider-test-conversation-child",
      turnId: "turn-provider-test-conversation-child",
      executionReference: createExecutionReference(
        "73500000-0000-4000-8000-000000000003",
        "73500000-0000-4000-8000-000000000003",
        6,
      ),
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "73500000-0000-4000-8000-000000000004",
      assignment: nextAssignment,
    });

    expect(stateRepository.released).not.toContain(first.activationId);
    expect(second.activationId).toBe("73500000-0000-4000-8000-000000000004");
    expect(second.continuity).toBe("warm_reuse");
    expect(fixture.createCount).toBe(1);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: second.activationId,
      assignment: nextAssignment,
      disposition: "keep_warm",
    });
    await manager.close();
  });

  it("bounds every warm process world with one shared LRU limit", async () => {
    const fixture = providerFixture();
    const activationIds = [
      ACTIVATION_ID,
      SECOND_ACTIVATION_ID,
      "30000000-0000-4000-8000-000000000030",
      "30000000-0000-4000-8000-000000000031",
    ];
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      maximumActiveSandboxes: 2,
      maximumWarmWorkspaceRuntimes: 1,
    });
    const persistent = await manager.create(createRequest);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "74000000-0000-4000-8000-000000000002",
      activationId: persistent.activationId,
      assignment,
      disposition: "keep_warm",
    });

    const ordinaryAssignment: ToolSandboxAssignment = {
      ...assignment,
      workspaceId: "workspace-provider-test-ordinary",
      sessionId: "session-provider-test-ordinary",
      runId: "command-provider-test-ordinary",
      turnId: "turn-provider-test-ordinary",
      executionReference: createExecutionReference(
        "74000000-0000-4000-8000-000000000003",
        "74000000-0000-4000-8000-000000000003",
        6,
      ),
    };
    const ordinary = await manager.create({
      ...createRequest,
      requestId: "74000000-0000-4000-8000-000000000004",
      assignment: ordinaryAssignment,
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "74000000-0000-4000-8000-000000000006",
      activationId: ordinary.activationId,
      assignment: ordinaryAssignment,
      disposition: "keep_warm",
    });
    expect(manager.warmCount).toBe(1);

    const demandAssignment: ToolSandboxAssignment = {
      ...ordinaryAssignment,
      workspaceId: "workspace-provider-test-new-demand",
      sessionId: "session-provider-test-new-demand",
      runId: "command-provider-test-new-demand",
      turnId: "turn-provider-test-new-demand",
      executionReference: createExecutionReference(
        "74000000-0000-4000-8000-000000000007",
        "74000000-0000-4000-8000-000000000007",
        7,
      ),
    };
    const demand = await manager.create({
      ...createRequest,
      requestId: "74000000-0000-4000-8000-000000000008",
      assignment: demandAssignment,
    });
    expect(manager.warmCount).toBe(1);

    const persistentNextAssignment: ToolSandboxAssignment = {
      ...assignment,
      runId: "command-provider-test-persistent-after-pressure",
      turnId: "turn-provider-test-persistent-after-pressure",
      executionReference: createExecutionReference(
        "74000000-0000-4000-8000-000000000010",
        "74000000-0000-4000-8000-000000000010",
        8,
      ),
    };
    const persistentAgain = await manager.create({
      ...createRequest,
      requestId: "74000000-0000-4000-8000-000000000011",
      assignment: persistentNextAssignment,
    });
    expect(persistentAgain.continuity).toBe("cold_restore");
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: persistentAgain.activationId,
      assignment: persistentNextAssignment,
      disposition: "keep_warm",
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: demand.activationId,
      assignment: demandAssignment,
      disposition: "keep_warm",
    });
  });

  it("runs two Session Tool bindings through one physical Workspace runtime", async () => {
    const fixture = providerFixture(),
      bindings = new InMemorySandboxBindings();
    const stop = vi.spyOn(bindings, "closeBinding");
    const manager = testBroker({ provider: fixture.provider, bindings });
    const first = await manager.create(createRequest),
      next = nextBindingRequest(assignment.workspaceId);
    await manager.create(next);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: first.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    expect(stop).toHaveBeenCalledWith(first.activationId, assignment, false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(bindings.rows.size).toBe(1);
    expect(fixture.destroyed).toBe(false);
    expect(manager.admittedCount).toBe(1);
    await manager.close();
  });

  it.each([false, true])(
    "fails every shared binding even when quarantine publication fails (%s)",
    async (publicationFails) => {
      const fixture = providerFixture();
      const bindings = new InMemorySandboxBindings();
      if (publicationFails)
        vi.spyOn(bindings, "confirmPhysicalClosure").mockRejectedValue(
          new Error("publication unavailable"),
        );
      const observe = vi.spyOn(fixture.provider, "observeRuntime").mockResolvedValue({
        runtimeName: "test",
        nodeId: "node-test",
        presence: "present",
        state: "stopped",
      });
      const manager = testBroker({ provider: fixture.provider, bindings });
      await manager.create(createRequest);
      await manager.create(nextBindingRequest(assignment.workspaceId));
      await manager.observeRuntimeHealth();
      expect([...bindings.rows.values()].map((r) => r.dispatchClosed)).toEqual([true, true]);
      expect(observe).toHaveBeenCalledOnce();
      await expect(
        manager.create(nextBindingRequest(assignment.workspaceId)),
      ).rejects.toMatchObject({
        code: "execution_stop_unconfirmed",
      });
      expect(manager.admittedCount).toBe(1);
      expect(fixture.destroyed).toBe(false);
      await manager.close();
    },
  );

  it("does not race binding cancellation with a second physical Cube destroy", async () => {
    const fixture = providerFixture();
    const manager = testBroker({ provider: fixture.provider });
    const first = await manager.create(createRequest);
    const next = nextBindingRequest(assignment.workspaceId);
    await manager.create(next);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: first.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: first.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    expect(fixture.destroyed).toBe(false);
    expect(manager.reservedCount).toBe(1);
    await manager.close();
  });

  it("evicts the least-recently-used warm runtime when new demand reaches admission capacity", async () => {
    const fixture = providerFixture();
    const manager = testBroker({ provider: fixture.provider, maximumActiveSandboxes: 1 });
    const first = await manager.create(createRequest);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: randomUUID(),
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
    });
    await manager.create(nextBindingRequest("other"));
    expect(fixture.destroyed).toBe(true);
    expect(fixture.createCount).toBe(2);
    expect(manager.admittedCount).toBe(1);
    await manager.close();
  });

  it("keeps a Broker-owned warm process world out of expired Supervisor inventory", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const created = await manager.create(createRequest);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "41000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
    });

    await expect(manager.listAssignments(assignment.sandboxId)).resolves.toEqual([]);
    expect(manager.warmCount).toBe(1);
    await manager.close();
  });

  it("waits for routing revocation and preserves binding/quota if publication fails", async () => {
    const fixture = providerFixture(),
      bindings = new InMemorySandboxBindings();
    const manager = testBroker({ provider: fixture.provider, bindings });
    const first = await manager.create(createRequest);
    const wait = Promise.withResolvers<void>();
    bindings.onClose = () => wait.promise;
    const closing = manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: first.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    await vi.waitFor(() =>
      expect(bindings.rows.get(first.activationId)?.dispatchClosed).toBe(true),
    );
    expect(manager.warmCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    wait.reject(new Error("routing revocation unconfirmed"));
    await expect(closing).rejects.toThrow("unconfirmed");
    expect(bindings.rows.has(first.activationId)).toBe(true);
    expect(manager.admittedCount).toBe(1);
    expect(fixture.destroyed).toBe(false);
    bindings.onClose = async () => {};
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: crypto.randomUUID(),
      activationId: first.activationId,
      assignment: assignment,
      disposition: "keep_warm",
    });
    expect(bindings.rows.has(first.activationId)).toBe(false);
    await manager.close();
  });

  it.each([0o600, 0o440])("loads CubeSandbox deployment secrets with mode %i", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-manager-config-"));
    const tokenPath = join(directory, "manager-token");
    try {
      await writeFile(tokenPath, `${"t".repeat(48)}\n`, { mode: 0o600 });
      await chmod(tokenPath, 0o600);
      const terminalTokenPath = join(directory, "terminal-token");
      await writeFile(terminalTokenPath, `${"w".repeat(48)}\n`, { mode: 0o600 });
      await chmod(terminalTokenPath, 0o600);
      const cubeKeyPath = join(directory, "cube-api-key");
      await writeFile(cubeKeyPath, `${"k".repeat(48)}\n`, { mode: 0o600 });
      await chmod(cubeKeyPath, 0o600);
      const workspaceVolumeGatewayTokenPath = join(directory, "workspace-volume-gateway-token");
      await writeFile(workspaceVolumeGatewayTokenPath, `${"m".repeat(48)}\n`, { mode: 0o600 });
      await chmod(workspaceVolumeGatewayTokenPath, 0o600);
      const persistentStateKeyPath = join(directory, "cube-persistent-state-key");
      await writeFile(persistentStateKeyPath, `${Buffer.alloc(32, 7).toString("base64url")}\n`, {
        mode: 0o600,
      });
      await chmod(persistentStateKeyPath, 0o600);
      const databaseUrlPath = join(directory, "database-url");
      await writeFile(databaseUrlPath, "postgresql://pi-cloud:secret@postgres:5432/pi-cloud\n", {
        mode: 0o600,
      });
      await chmod(databaseUrlPath, 0o600);
      for (const path of [
        tokenPath,
        terminalTokenPath,
        cubeKeyPath,
        workspaceVolumeGatewayTokenPath,
        persistentStateKeyPath,
        databaseUrlPath,
      ])
        await chmod(path, mode);
      await expect(
        loadSandboxControlConfig({
          DATABASE_URL_FILE: databaseUrlPath,
          PI_CLOUD_KAFKA_BROKERS: "kafka:9092",
          PI_CLOUD_SANDBOX_DOMAIN_ID: "sandbox-domain-0001",
          PI_CLOUD_SANDBOX_CONTROL_ADVERTISED_URL: "http://sandbox-control-0:4300",
          PI_CLOUD_SANDBOX_CONTROL_TOKEN_FILE: tokenPath,
          PI_CLOUD_CONTROL_PLANE_URL: "http://control-plane:3000",
          PI_CLOUD_WORKSPACE_TERMINAL_TOKEN_FILE: terminalTokenPath,
          PI_CLOUD_CUBE_PERSISTENT_STATE_KEY_FILE: persistentStateKeyPath,
          PI_CLOUD_IMAGE_REVISION: "development",
          PI_CLOUD_CUBESANDBOX_API_URL: "https://cube-api.internal",
          PI_CLOUD_CUBESANDBOX_API_KEY_FILE: cubeKeyPath,
          PI_CLOUD_CUBESANDBOX_TEMPLATE_ID: "pi-cloud-tool-v1",
          PI_CLOUD_CUBESANDBOX_DEVELOPMENT_TEMPLATE_IDS: JSON.stringify({
            starter: "tpl-starter00000000000000000",
            standard: "tpl-standard0000000000000000",
            performance: "tpl-performance0000000000000",
          }),
          PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP: "10.20.30.40",
          PI_CLOUD_CUBESANDBOX_PROXY_SCHEME: "https",
          PI_CLOUD_CUBESANDBOX_DIRECT_PRIVATE_CIDRS:
            "192.168.31.183/24,10.20.0.0/24,192.168.31.0/24",
          PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL: "http://workspace-volume-gateway:4500",
          PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: workspaceVolumeGatewayTokenPath,
        }),
      ).resolves.toMatchObject({
        databaseUrl: "postgresql://pi-cloud:secret@postgres:5432/pi-cloud",
        maximumActiveCommands: 32,
        kafkaBrokers: ["kafka:9092"],
        sandboxDomainId: "sandbox-domain-0001",
        advertisedBaseUrl: "http://sandbox-control-0:4300/",
        maximumActiveSandboxes: null,
        maximumWarmWorkspaceRuntimes: 4,
        cubeSandbox: {
          apiUrl: "https://cube-api.internal",
          apiKey: "k".repeat(48),
          templateId: "pi-cloud-tool-v1",
          proxyNodeIp: "10.20.30.40",
          proxyPort: 443,
          proxyScheme: "https",
          directPrivateCidrs: ["192.168.31.0/24", "10.20.0.0/24"],
          sandboxDomain: "cube.app",
          workspaceVolumeGatewayUrl: "http://workspace-volume-gateway:4500",
          workspaceVolumeGatewayToken: "m".repeat(48),
        },
      });
      await expect(
        loadSandboxControlConfig({
          DATABASE_URL_FILE: databaseUrlPath,
          PI_CLOUD_SANDBOX_DOMAIN_ID: "sandbox-domain-0001",
          PI_CLOUD_SANDBOX_CONTROL_ADVERTISED_URL: "http://sandbox-control-0:4300",
          PI_CLOUD_SANDBOX_CONTROL_OWNERSHIP_LEASE_MS: "10000",
          PI_CLOUD_SANDBOX_CONTROL_OWNERSHIP_HEARTBEAT_MS: "5000",
          PI_CLOUD_SANDBOX_CONTROL_TOKEN_FILE: tokenPath,
          PI_CLOUD_WORKSPACE_TERMINAL_TOKEN_FILE: terminalTokenPath,
          PI_CLOUD_IMAGE_REVISION: "development",
          PI_CLOUD_CUBESANDBOX_API_URL: "https://cube-api.internal",
          PI_CLOUD_CUBESANDBOX_API_KEY_FILE: cubeKeyPath,
          PI_CLOUD_CUBESANDBOX_TEMPLATE_ID: "pi-cloud-tool-v1",
          PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP: "10.20.30.40",
          PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL: "http://workspace-volume-gateway:4500",
          PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: workspaceVolumeGatewayTokenPath,
        }),
      ).rejects.toThrow("heartbeat must leave lease failure margin");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function nextBindingRequest(workspaceId: string): ToolSandboxCreateRequest {
  const runId = randomUUID();
  return {
    ...createRequest,
    requestId: randomUUID(),
    assignment: {
      ...assignment,
      workspaceId,
      runId,
      sessionId: randomUUID(),
      turnId: randomUUID(),
      executionReference: createExecutionReference(randomUUID(), runId, 6),
    },
  };
}
