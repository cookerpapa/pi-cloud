import type {
  SupervisorRuntimeAssignment,
  ToolSandboxAssignment,
  ToolSandboxCreateRequest,
  ToolSandboxOperationRequest,
} from "@pi-cloud/protocol";
import {
  createExecutionLease,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  parseExecutionLease,
} from "@pi-cloud/protocol";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ToolBrokerError,
  CUBESANDBOX_TOOL_POLICY,
  InMemoryWorkspaceRuntimeStateRepository,
  ToolBroker,
  loadToolBrokerConfig,
  type ToolBrokerOptions,
  type SandboxCreateSpec,
  type SandboxProvider,
} from "../src/index.ts";

type TestToolBrokerDefaults = "stateRepository" | "ownerBaseUrl" | "imageRevision";
type TestToolBrokerOptions = Omit<ToolBrokerOptions, TestToolBrokerDefaults> &
  Partial<Pick<ToolBrokerOptions, TestToolBrokerDefaults>>;

function testBroker(options: TestToolBrokerOptions): ToolBroker {
  return new ToolBroker({
    stateRepository: new InMemoryWorkspaceRuntimeStateRepository(),
    ownerBaseUrl: "http://tool-broker.test",
    imageRevision: "development",
    ...options,
  });
}

const ACTIVATION_ID = "10000000-0000-4000-8000-000000000010";
const SECOND_ACTIVATION_ID = "20000000-0000-4000-8000-000000000020";
const STEP_CONTEXT_SHA256 = "a".repeat(64);
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
  executionLease: createExecutionLease(
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
  attemptContextSha256: ATTEMPT_CONTEXT_SHA256,
  allowedTools: ["read", "write", "edit", "bash"],
  executionMode: "elastic",
  environment,
  workspaceSeed: { kind: "sample_java" },
};

function providerFixture() {
  let createSpec: SandboxCreateSpec | undefined;
  let createCount = 0;
  let stopped = false;
  let destroyed = false;
  let runtimeState: "running" | "paused" = "running";
  const terminalInput = vi.fn(async () => undefined);
  const terminalResize = vi.fn(async () => undefined);
  const exec = vi.fn<SandboxProvider["exec"]>(async (_handle, request) => ({
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation_result",
    activationId: request.activationId,
    operationId: request.operationId,
    operation: "bash.exec",
    exitCode: 0,
    outputChunks: [{ seq: 1, stream: "stdout", data: Buffer.from("ok\n").toString("base64") }],
    outputSha256: createHash("sha256").update("ok\n").digest("hex"),
  }));
  const discoverHttpServices = vi.fn<NonNullable<SandboxProvider["discoverHttpServices"]>>(
    async () => ({ listeningPorts: [], httpServices: [] }),
  );
  const settle = vi.fn<SandboxProvider["settle"]>(async (handle, requestId, binding) => {
    const bytes = Buffer.from("workspace", "utf8");
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.captured",
      requestId,
      activationId: binding?.activationId ?? handle.activationId,
      settlement: {
        encoding: "base64",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        data: bytes.toString("base64"),
      },
      environment: environmentValidation,
    };
  });
  const forkWorkspace = vi.fn<NonNullable<SandboxProvider["forkWorkspace"]>>(async (handle) => ({
    sourceHandle: handle,
    sourceSettlementRevision: "a".repeat(64),
    targetSettlementRevision: "b".repeat(64),
  }));
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
  const adoptPersistentCapsule = vi.fn<NonNullable<SandboxProvider["adoptPersistentCapsule"]>>(
    async () => {
      throw new Error("Provider fixture has no detached machine to adopt");
    },
  );
  const detachPersistent = vi.fn<NonNullable<SandboxProvider["detachPersistent"]>>(
    async () => undefined,
  );
  const previewHttp = vi.fn<NonNullable<SandboxProvider["previewHttp"]>>(async () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from("<html><body>preview-ok</body></html>"),
  }));
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
    defaultPolicy: CUBESANDBOX_TOOL_POLICY,
    async checkHealth() {},
    async create(spec) {
      createCount += 1;
      createSpec = spec;
      return {
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
    exec,
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
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
    previewHttp,
    listDirectory,
    createDirectory,
    pause,
    resume,
    persistentCapsule,
    adoptPersistentCapsule,
    detachPersistent,
    settle,
    forkWorkspace,
    listWorkspaceDirectory,
    readWorkspaceFile,
    async stop() {
      stopped = true;
    },
    async destroy() {
      destroyed = true;
    },
    async inspect(handle) {
      return {
        providerApiVersion: 1,
        providerId: "cubesandbox",
        state: runtimeState === "running" ? "running" : "stopped",
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
    async destroyRuntime() {},
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {},
    async confirmAbsent() {},
    async close() {},
  };
  return {
    provider,
    exec,
    discoverHttpServices,
    settle,
    forkWorkspace,
    listWorkspaceDirectory,
    readWorkspaceFile,
    terminalInput,
    terminalResize,
    pause,
    resume,
    persistentCapsule,
    detachPersistent,
    previewHttp,
    listDirectory,
    createDirectory,
    get createSpec() {
      return createSpec;
    },
    get createCount() {
      return createCount;
    },
    get stopped() {
      return stopped;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

function operation(
  operationId: string,
): Extract<ToolSandboxOperationRequest, { operation: "bash.exec" }> {
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId: ACTIVATION_ID,
    operationId,
    turnContextSha256: TURN_CONTEXT_SHA256,
    attemptContextSha256: ATTEMPT_CONTEXT_SHA256,
    stepContextSequence: 1,
    stepContextSha256: STEP_CONTEXT_SHA256,
    toolName: "bash",
    operation: "bash.exec",
    command: "pwd",
    cwd: "/workspace",
    timeoutMs: 1_000,
  };
}

describe("provider-backed Tool Tool Broker", () => {
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
      activationId: ACTIVATION_ID,
    });
    expect(retired).not.toHaveBeenCalled();
    expect(orphaned).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();

    await manager.stop(ACTIVATION_ID, assignment);
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
      executionLease: createExecutionLease(
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

    await expect(firstReservation).resolves.toMatchObject({ activationId: ACTIVATION_ID });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(secondResolved).toBe(true);
    const second = await secondReservation;
    expect(second.activationId).toBe(
      parseExecutionLease(siblingAssignment.executionLease).attemptId,
    );
    await manager.stop(ACTIVATION_ID, assignment);
    await manager.stop(second.activationId, siblingAssignment);
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
    expect(agent.activationId).toBe(ACTIVATION_ID);
    expect(agent).toMatchObject({
      continuity: "warm_reuse",
      continuityId: "66666666-6666-4666-8666-666666666666",
    });
    await expect(
      manager.execute(assignment.executionLease, operation("21111111-1111-4111-8111-111111111111")),
    ).resolves.toMatchObject({ exitCode: 0 });
    await manager.capture(agent.activationId, assignment, "21111111-1111-4111-8111-111111111112");
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
    expect(fixture.settle).toHaveBeenCalledTimes(1);
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
      executionLease: createExecutionLease(
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
    await manager.execute(secondAssignment.executionLease, {
      ...operation("21111111-1111-4111-8111-111111111118"),
      activationId: secondAgent.activationId,
    });
    await manager.capture(
      secondAgent.activationId,
      secondAssignment,
      "21111111-1111-4111-8111-111111111119",
    );
    await manager.stop(secondAgent.activationId, secondAssignment);
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

  it("gives concurrent parent and Child Runs independent bindings to one development KVM", async () => {
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
    const parent = await manager.create({
      ...createRequest,
      executionMode: "development_environment",
    });
    const childAssignment: ToolSandboxAssignment = {
      ...assignment,
      sessionId: "session-provider-test-child",
      runId: "command-provider-test-child",
      turnId: "turn-provider-test-child",
      executionLease: createExecutionLease(
        "21600000-0000-4000-8000-000000000002",
        "21600000-0000-4000-8000-000000000003",
        1,
      ),
    };
    const child = await manager.create({
      ...createRequest,
      requestId: "21600000-0000-4000-8000-000000000004",
      assignment: childAssignment,
      executionMode: "development_environment",
    });
    expect(parent.activationId).toBe(ACTIVATION_ID);
    expect(child.activationId).toBe(parseExecutionLease(childAssignment.executionLease).attemptId);
    expect(child.continuityId).toBe(parent.continuityId);
    expect(fixture.listDirectory).not.toHaveBeenCalled();
    await manager.execute(assignment.executionLease, {
      ...operation("21600000-0000-4000-8000-000000000005"),
      activationId: parent.activationId,
    });
    await manager.execute(childAssignment.executionLease, {
      ...operation("21600000-0000-4000-8000-000000000006"),
      activationId: child.activationId,
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "21600000-0000-4000-8000-000000000007",
      activationId: child.activationId,
      assignment: childAssignment,
      disposition: "detach",
    });
    expect(fixture.stopped).toBe(false);
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "21600000-0000-4000-8000-000000000008",
      activationId: parent.activationId,
      assignment,
      disposition: "detach",
    });
    expect(fixture.createCount).toBe(1);
    expect(fixture.stopped).toBe(false);
    await manager.close();
  });

  it("releases a database-owned development environment after its in-memory handle is lost", async () => {
    const fixture = providerFixture();
    const destroyRuntime = vi.fn(async () => undefined);
    fixture.provider.destroyRuntime = destroyRuntime;
    const stateRepository = new InMemoryWorkspaceRuntimeStateRepository();
    const environmentId = "21111111-1111-4111-8111-111111111121";
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

  it("leaves a running development KVM online while its Tool Broker shuts down", async () => {
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
    await manager.execute(
      assignment.executionLease,
      operation("62111111-1111-4111-8111-111111111112"),
    );

    await manager.close();

    expect(borrowed.activationId).toBe(ACTIVATION_ID);
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
      new ToolBrokerError(
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
    expect(binding.activationId).toBe(ACTIVATION_ID);
    expect(fixture.listDirectory).not.toHaveBeenCalled();
    expect(fixture.settle).not.toHaveBeenCalled();
    expect(fixture.stopped).toBe(false);
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
    expect(agent.activationId).toBe(ACTIVATION_ID);
    await manager.execute(
      assignment.executionLease,
      operation("21500000-0000-4000-8000-000000000001"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "21500000-0000-4000-8000-000000000002",
      activationId: agent.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "1".repeat(64),
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
          executionLease: createExecutionLease(
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
    const created = await manager.create({ ...createRequest, workspaceRevision: "1".repeat(64) });
    await manager.execute(
      assignment.executionLease,
      operation("31000000-0000-4000-8000-000000000001"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "31000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "1".repeat(64),
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
    expect(fixture.stopped).toBe(false);

    const terminalRunAssignment = {
      ...assignment,
      runId: "command-provider-test-terminal-shared",
      turnId: "turn-provider-test-terminal-shared",
      executionLease: createExecutionLease(
        "31000000-0000-4000-8000-000000000003",
        "31000000-0000-4000-8000-000000000003",
        7,
      ),
    };
    const terminalRun = await manager.create({
      ...createRequest,
      requestId: "31000000-0000-4000-8000-000000000004",
      assignment: terminalRunAssignment,
      workspaceRevision: "1".repeat(64),
    });
    await manager.execute(terminalRunAssignment.executionLease, {
      ...operation("31000000-0000-4000-8000-000000000005"),
      activationId: terminalRun.activationId,
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "31000000-0000-4000-8000-000000000006",
      activationId: terminalRun.activationId,
      assignment: terminalRunAssignment,
      disposition: "keep_warm",
      workspaceRevision: "2".repeat(64),
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
    const created = await manager.create({ ...createRequest, workspaceRevision: "1".repeat(64) });
    await manager.execute(
      assignment.executionLease,
      operation("32000000-0000-4000-8000-000000000001"),
    );
    await expect(
      manager.release({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: "32000000-0000-4000-8000-000000000002",
        activationId: created.activationId,
        assignment,
        disposition: "keep_warm",
        workspaceRevision: "1".repeat(64),
      }),
    ).resolves.toMatchObject({ retained: true });
    expect(fixture.stopped).toBe(false);
    await manager.close();
  });

  it("proxies a tenant-authorized port through a retained private-ingress Cube", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const created = await manager.create({ ...createRequest, workspaceRevision: "1".repeat(64) });
    await manager.execute(
      assignment.executionLease,
      operation("32000000-0000-4000-8000-000000000001"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "32000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "1".repeat(64),
    });

    const response = await manager.preview({
      sandboxPreviewProtocolVersion: 1,
      type: "sandbox_preview.request",
      requestId: "32000000-0000-4000-8000-000000000003",
      tenantId: assignment.tenantId,
      userId: "user-provider-test",
      target: { kind: "conversation", sessionId: assignment.sessionId },
      port: 8000,
      method: "GET",
      path: "/",
      headers: { accept: "text/html" },
    });
    expect(response).toMatchObject({
      type: "sandbox_preview.response",
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    expect(
      Buffer.from(
        response.type === "sandbox_preview.response" ? response.body : "",
        "base64",
      ).toString(),
    ).toContain("preview-ok");
    expect(fixture.previewHttp).toHaveBeenCalledWith(
      expect.objectContaining({ activationId: ACTIVATION_ID }),
      expect.objectContaining({ port: 8000, method: "GET", path: "/" }),
    );
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
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });

    const created = await manager.create(createRequest);
    expect(created).toMatchObject({
      activationId: ACTIVATION_ID,
      executionLease: assignment.executionLease,
      continuity: "cold_restore",
    });
    expect(fixture.createSpec).toBeUndefined();
    await expect(
      manager.capture(ACTIVATION_ID, assignment, "10000000-0000-4000-8000-000000000017"),
    ).resolves.toMatchObject({ type: "tool_sandbox.unused" });

    await expect(
      manager.execute(assignment.executionLease, {
        ...operation("10000000-0000-4000-8000-000000000011"),
        turnContextSha256: "d".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "turn_context_mismatch" });
    await expect(
      manager.execute(assignment.executionLease, {
        ...operation("10000000-0000-4000-8000-000000000021"),
        attemptContextSha256: "d".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "attempt_context_mismatch" });
    expect(fixture.createSpec).toBeUndefined();

    await expect(
      manager.execute(
        createExecutionLease(
          "90000000-0000-4000-8000-000000000001",
          "90000000-0000-4000-8000-000000000002",
          99,
        ),
        operation("10000000-0000-4000-8000-000000000012"),
      ),
    ).rejects.toMatchObject({ code: "stale_session_lease" });
    const request = operation("10000000-0000-4000-8000-000000000013");
    await expect(manager.execute(assignment.executionLease, request)).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(fixture.createSpec).toMatchObject({
      activationId: ACTIVATION_ID,
      assignment: {
        tenantId: assignment.tenantId,
        sessionId: assignment.sessionId,
        turnId: assignment.turnId,
        executionLease: assignment.executionLease,
      },
      policy: { network: { mode: "public_web_proxy_private_denied" } },
    });
    expect(fixture.createSpec).not.toHaveProperty("capability");
    await expect(manager.execute(assignment.executionLease, request)).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      manager.execute(assignment.executionLease, { ...request, command: "whoami" }),
    ).rejects.toMatchObject({ code: "tool_operation_identity_conflict" });
    expect(fixture.exec).toHaveBeenCalledTimes(1);

    const secondStep = {
      ...operation("10000000-0000-4000-8000-000000000018"),
      stepContextSequence: 2,
      stepContextSha256: "b".repeat(64),
    };
    await expect(manager.execute(assignment.executionLease, secondStep)).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(manager.execute(assignment.executionLease, request)).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      manager.execute(assignment.executionLease, operation("10000000-0000-4000-8000-000000000019")),
    ).rejects.toMatchObject({ code: "step_context_mismatch" });
    await expect(
      manager.execute(assignment.executionLease, {
        ...secondStep,
        operationId: "10000000-0000-4000-8000-000000000020",
        stepContextSha256: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "step_context_mismatch" });
    expect(fixture.exec).toHaveBeenCalledTimes(2);

    await expect(manager.inspect(ACTIVATION_ID, assignment)).resolves.toMatchObject({
      state: "running",
      handle: {
        assignment: {
          tenantId: assignment.tenantId,
          executionLease: assignment.executionLease,
        },
      },
    });
    await manager.stop(ACTIVATION_ID, assignment);
    expect(fixture.stopped).toBe(true);
    expect(manager.activeCount).toBe(0);
    await expect(
      manager.execute(assignment.executionLease, operation("10000000-0000-4000-8000-000000000014")),
    ).rejects.toMatchObject({ code: "stale_session_lease" });
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
    await manager.execute(
      assignment.executionLease,
      operation("10000000-0000-4000-8000-000000000031"),
    );
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
    await manager.stop(created.activationId, assignment);
    await manager.close();
  });

  it("enforces the Run Tool snapshot independently of model visibility", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.create({ ...createRequest, allowedTools: ["read"] });

    await expect(
      manager.execute(assignment.executionLease, operation("10000000-0000-4000-8000-000000000041")),
    ).rejects.toMatchObject({ code: "tool_not_granted" });
    await expect(
      manager.execute(assignment.executionLease, {
        ...operation("10000000-0000-4000-8000-000000000042"),
        toolName: "read",
      }),
    ).rejects.toMatchObject({ code: "tool_operation_not_granted" });
    expect(fixture.createCount).toBe(0);
    expect(fixture.exec).not.toHaveBeenCalled();
  });

  it("queues materialization behind the global active Sandbox admission limit", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      maximumActiveSandboxes: 1,
    });
    const secondAssignment = {
      ...assignment,
      runId: "command-provider-test-second",
      workspaceId: "workspace-provider-test-second",
      sessionId: "session-provider-test-second",
      turnId: "turn-provider-test-second",
      executionLease: createExecutionLease(
        "20000000-0000-4000-8000-000000000003",
        "20000000-0000-4000-8000-000000000003",
        6,
      ),
    };
    const first = await manager.create(createRequest);
    const second = await manager.create({
      ...createRequest,
      requestId: "20000000-0000-4000-8000-000000000011",
      assignment: secondAssignment,
    });
    await manager.execute(
      assignment.executionLease,
      operation("20000000-0000-4000-8000-000000000012"),
    );
    const waiting = manager.execute(secondAssignment.executionLease, {
      ...operation("20000000-0000-4000-8000-000000000013"),
      activationId: second.activationId,
    });
    await vi.waitFor(() => expect(manager.admissionWaitingCount).toBe(1));
    expect(manager.admittedCount).toBe(1);
    expect(fixture.createCount).toBe(1);

    await manager.stop(first.activationId, assignment);
    await expect(waiting).resolves.toMatchObject({ exitCode: 0 });
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    expect(fixture.createCount).toBe(2);
    await manager.stop(second.activationId, secondAssignment);
    expect(manager.admittedCount).toBe(0);
  });

  it("reads current Workspace files without consuming Cube admission capacity", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
      maximumActiveSandboxes: 1,
    });
    const active = await manager.create(createRequest);
    await manager.execute(
      assignment.executionLease,
      operation("20000000-0000-4000-8000-000000000050"),
    );
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
    await manager.stop(active.activationId, assignment);
  });

  it("removes an aborted Tool binding admission waiter without consuming capacity", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      maximumActiveSandboxes: 1,
    });
    const secondAssignment = {
      ...assignment,
      runId: "command-provider-test-aborted",
      workspaceId: "workspace-provider-test-aborted",
      sessionId: "session-provider-test-aborted",
      turnId: "turn-provider-test-aborted",
      executionLease: createExecutionLease(
        "30000000-0000-4000-8000-000000000003",
        "30000000-0000-4000-8000-000000000003",
        7,
      ),
    };
    const first = await manager.create(createRequest);
    const second = await manager.create({
      ...createRequest,
      requestId: "30000000-0000-4000-8000-000000000011",
      assignment: secondAssignment,
    });
    await manager.execute(
      assignment.executionLease,
      operation("30000000-0000-4000-8000-000000000012"),
    );
    const controller = new AbortController();
    const waiting = manager.execute(
      second.executionLease,
      {
        ...operation("30000000-0000-4000-8000-000000000013"),
        activationId: second.activationId,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(manager.admissionWaitingCount).toBe(1));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "tool_binding_admission_cancelled" });
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    expect(fixture.createCount).toBe(1);
    await manager.stop(second.activationId, secondAssignment);
    await manager.stop(first.activationId, assignment);
    expect(manager.admittedCount).toBe(0);
  });

  it("reuses one Workspace runtime across fenced attempts without reprovisioning", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const first = await manager.create(createRequest);
    await manager.execute(
      assignment.executionLease,
      operation("10000000-0000-4000-8000-000000000018"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "10000000-0000-4000-8000-000000000019",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "a".repeat(64),
    });

    const nextAssignment: ToolSandboxAssignment = {
      ...assignment,
      supervisorId: "supervisor-provider-test-next",
      bootId: "20000000-0000-4000-8000-000000000020",
      sandboxId: "20000000-0000-4000-8000-000000000021",
      runId: "command-provider-test-next",
      turnId: "turn-provider-test-next",
      executionLease: createExecutionLease(
        "10000000-0000-4000-8000-000000000020",
        "10000000-0000-4000-8000-000000000020",
        6,
      ),
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "10000000-0000-4000-8000-000000000021",
      assignment: nextAssignment,
      workspaceRevision: "a".repeat(64),
    });
    expect(second.activationId).not.toBe(first.activationId);
    expect(second.continuity).toBe("warm_reuse");
    await manager.execute(nextAssignment.executionLease, {
      ...operation("10000000-0000-4000-8000-000000000022"),
      activationId: second.activationId,
    });
    expect(fixture.createCount).toBe(1);
    expect(fixture.exec).toHaveBeenCalledTimes(2);
    await manager.stop(second.activationId, nextAssignment);
  });

  it("runs parent and child Tool bindings in one shared Workspace runtime", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      stateRepository: new InMemoryWorkspaceRuntimeStateRepository(),
      idGenerator: () => ACTIVATION_ID,
    });
    const parent = await manager.create(createRequest);
    await manager.execute(
      assignment.executionLease,
      operation("73300000-0000-4000-8000-000000000001"),
    );
    const childAssignment = {
      ...assignment,
      sessionId: "session-provider-test-subagent",
      runId: "command-provider-test-subagent",
      turnId: "turn-provider-test-subagent",
      executionLease: createExecutionLease(
        "73300000-0000-4000-8000-000000000002",
        "73300000-0000-4000-8000-000000000002",
        8,
      ),
    };
    const child = await manager.create({
      ...createRequest,
      requestId: "73300000-0000-4000-8000-000000000003",
      assignment: childAssignment,
      workspaceRevision: "1".repeat(64),
    });
    expect(child).toMatchObject({ continuity: "warm_reuse" });
    expect(child.activationId).not.toBe(parent.activationId);
    await Promise.all([
      manager.execute(assignment.executionLease, operation("73300000-0000-4000-8000-000000000004")),
      manager.execute(childAssignment.executionLease, {
        ...operation("73300000-0000-4000-8000-000000000005"),
        activationId: child.activationId,
      }),
    ]);
    await manager.capture(
      child.activationId,
      childAssignment,
      "73300000-0000-4000-8000-000000000008",
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "73300000-0000-4000-8000-000000000006",
      activationId: child.activationId,
      assignment: childAssignment,
      disposition: "keep_warm",
      workspaceRevision: "2".repeat(64),
    });
    await expect(
      manager.execute(assignment.executionLease, operation("73300000-0000-4000-8000-000000000007")),
    ).resolves.toMatchObject({ operation: "bash.exec" });
    expect(fixture.createCount).toBe(1);
    expect(fixture.settle).toHaveBeenCalledTimes(1);
    await manager.stop(parent.activationId, assignment);
  });

  it("creates an isolated Workspace fork without revoking the parent lease", async () => {
    const fixture = providerFixture();
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const parent = await manager.create(createRequest);
    await manager.execute(
      assignment.executionLease,
      operation("73400000-0000-4000-8000-000000000001"),
    );
    const forked = await manager.forkWorkspace({
      toolBrokerProtocolVersion: 1,
      type: "workspace.fork",
      requestId: "73400000-0000-4000-8000-000000000002",
      sourceActivationId: parent.activationId,
      sourceAssignment: assignment,
      target: {
        tenantId: assignment.tenantId,
        projectId: assignment.projectId,
        workspaceId: "73400000-0000-4000-8000-000000000003",
        sessionId: "73400000-0000-4000-8000-000000000004",
      },
    });
    expect(forked).toMatchObject({
      type: "workspace.forked",
      sourceSettlementRevision: "a".repeat(64),
      targetSettlementRevision: "b".repeat(64),
    });
    await expect(
      manager.execute(assignment.executionLease, operation("73400000-0000-4000-8000-000000000005")),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(fixture.forkWorkspace).toHaveBeenCalledTimes(1);
    await manager.stop(parent.activationId, assignment);
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
    await manager.execute(
      assignment.executionLease,
      operation("71000000-0000-4000-8000-000000000001"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "71000000-0000-4000-8000-000000000002",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "e".repeat(64),
    });

    now += 60_000;
    await manager.reapWarm();
    expect(manager.warmCount).toBe(0);
    expect(fixture.stopped).toBe(true);
  });

  it("reaps a retained runtime after its conversation is archived", async () => {
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
    await manager.execute(
      assignment.executionLease,
      operation("72000000-0000-4000-8000-000000000001"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "72000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "f".repeat(64),
    });

    stateRepository.retired = true;
    await manager.reapRetiredWarm();
    expect(manager.warmCount).toBe(0);
    expect(manager.admittedCount).toBe(0);
    expect(fixture.stopped).toBe(true);
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
    await manager.execute(
      assignment.executionLease,
      operation("73500000-0000-4000-8000-000000000001"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "73500000-0000-4000-8000-000000000002",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "1".repeat(64),
    });

    const nextAssignment = {
      ...assignment,
      sessionId: "session-provider-test-conversation-child",
      runId: "command-provider-test-conversation-child",
      turnId: "turn-provider-test-conversation-child",
      executionLease: createExecutionLease(
        "73500000-0000-4000-8000-000000000003",
        "73500000-0000-4000-8000-000000000003",
        6,
      ),
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "73500000-0000-4000-8000-000000000004",
      assignment: nextAssignment,
      workspaceRevision: "1".repeat(64),
    });

    expect(fixture.stopped).toBe(false);
    expect(stateRepository.released).not.toContain(first.activationId);
    expect(second.activationId).toBe(parseExecutionLease(nextAssignment.executionLease).attemptId);
    expect(second.continuity).toBe("warm_reuse");
    expect(fixture.createCount).toBe(1);
    await manager.stop(second.activationId, nextAssignment);
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
    await manager.execute(
      assignment.executionLease,
      operation("74000000-0000-4000-8000-000000000001"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "74000000-0000-4000-8000-000000000002",
      activationId: persistent.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "2".repeat(64),
    });

    const ordinaryAssignment: ToolSandboxAssignment = {
      ...assignment,
      workspaceId: "workspace-provider-test-ordinary",
      sessionId: "session-provider-test-ordinary",
      runId: "command-provider-test-ordinary",
      turnId: "turn-provider-test-ordinary",
      executionLease: createExecutionLease(
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
    await manager.execute(ordinaryAssignment.executionLease, {
      ...operation("74000000-0000-4000-8000-000000000005"),
      activationId: ordinary.activationId,
    });
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "74000000-0000-4000-8000-000000000006",
      activationId: ordinary.activationId,
      assignment: ordinaryAssignment,
      disposition: "keep_warm",
      workspaceRevision: "3".repeat(64),
    });
    expect(manager.warmCount).toBe(1);

    const demandAssignment: ToolSandboxAssignment = {
      ...ordinaryAssignment,
      workspaceId: "workspace-provider-test-new-demand",
      sessionId: "session-provider-test-new-demand",
      runId: "command-provider-test-new-demand",
      turnId: "turn-provider-test-new-demand",
      executionLease: createExecutionLease(
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
    await manager.execute(demandAssignment.executionLease, {
      ...operation("74000000-0000-4000-8000-000000000009"),
      activationId: demand.activationId,
    });
    expect(manager.warmCount).toBe(1);

    const persistentNextAssignment: ToolSandboxAssignment = {
      ...assignment,
      runId: "command-provider-test-persistent-after-pressure",
      turnId: "turn-provider-test-persistent-after-pressure",
      executionLease: createExecutionLease(
        "74000000-0000-4000-8000-000000000010",
        "74000000-0000-4000-8000-000000000010",
        8,
      ),
    };
    const persistentAgain = await manager.create({
      ...createRequest,
      requestId: "74000000-0000-4000-8000-000000000011",
      assignment: persistentNextAssignment,
      workspaceRevision: "2".repeat(64),
    });
    expect(persistentAgain.continuity).toBe("cold_restore");
    await manager.stop(persistentAgain.activationId, persistentNextAssignment);
    await manager.stop(demand.activationId, demandAssignment);
  });

  it("runs two Session Tool bindings through one physical Workspace runtime", async () => {
    const fixture = providerFixture();
    const execute = fixture.provider.exec.bind(fixture.provider);
    let concurrentExecutions = 0;
    let maximumConcurrentExecutions = 0;
    fixture.provider.exec = async (...arguments_) => {
      concurrentExecutions += 1;
      maximumConcurrentExecutions = Math.max(maximumConcurrentExecutions, concurrentExecutions);
      try {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
        return await execute(...arguments_);
      } finally {
        concurrentExecutions -= 1;
      }
    };
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      maximumActiveSandboxes: 2,
    });
    const first = await manager.create(createRequest);
    const siblingAssignment = {
      ...assignment,
      runId: "command-provider-test-concurrent-sibling",
      sessionId: "session-provider-test-concurrent-sibling",
      turnId: "turn-provider-test-concurrent-sibling",
      executionLease: createExecutionLease(
        "61000000-0000-4000-8000-000000000001",
        "61000000-0000-4000-8000-000000000001",
        6,
      ),
    };
    let secondResolved = false;
    const secondPromise = manager
      .create({
        ...createRequest,
        requestId: "61000000-0000-4000-8000-000000000002",
        assignment: siblingAssignment,
      })
      .then((created) => {
        secondResolved = true;
        return created;
      });
    expect(first.activationId).toBe(ACTIVATION_ID);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 75));
    expect(secondResolved).toBe(true);
    const second = await secondPromise;
    expect(second.activationId).toBe(
      parseExecutionLease(siblingAssignment.executionLease).attemptId,
    );
    await Promise.all([
      manager.execute(assignment.executionLease, operation("61000000-0000-4000-8000-000000000003")),
      manager.execute(siblingAssignment.executionLease, {
        ...operation("61000000-0000-4000-8000-000000000004"),
        activationId: second.activationId,
      }),
    ]);
    expect(fixture.createCount).toBe(1);
    expect(maximumConcurrentExecutions).toBe(2);
    await manager.stop(first.activationId, assignment);
    await manager.stop(second.activationId, siblingAssignment);
    await manager.close();
  });

  it("fails every binding when the shared physical Workspace runtime is lost", async () => {
    const fixture = providerFixture();
    fixture.provider.exec = async () => {
      throw new ToolBrokerError("cubesandbox_tool_result_unknown", "Physical Cube was lost", false);
    };
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const first = await manager.create(createRequest);
    const siblingAssignment = {
      ...assignment,
      runId: "command-provider-test-runtime-loss",
      sessionId: "session-provider-test-runtime-loss",
      turnId: "turn-provider-test-runtime-loss",
      executionLease: createExecutionLease(
        "62000000-0000-4000-8000-000000000001",
        "62000000-0000-4000-8000-000000000001",
        6,
      ),
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "62000000-0000-4000-8000-000000000002",
      assignment: siblingAssignment,
    });

    await expect(
      manager.execute(assignment.executionLease, operation("62000000-0000-4000-8000-000000000003")),
    ).rejects.toMatchObject({ code: "cubesandbox_tool_result_unknown" });
    await expect(
      manager.execute(siblingAssignment.executionLease, {
        ...operation("62000000-0000-4000-8000-000000000004"),
        activationId: second.activationId,
      }),
    ).rejects.toMatchObject({ code: "cubesandbox_tool_result_unknown" });
    expect(fixture.createCount).toBe(1);
    await manager.stop(first.activationId, assignment);
    await manager.stop(second.activationId, siblingAssignment);
    await manager.close();
  });

  it("does not race binding cancellation with a second physical Cube destroy", async () => {
    const fixture = providerFixture();
    let started!: () => void;
    const operationStarted = new Promise<void>((resolvePromise) => {
      started = resolvePromise;
    });
    fixture.provider.exec = async (_handle, _request, signal) => {
      started();
      return new Promise((_, rejectPromise) => {
        signal?.addEventListener(
          "abort",
          () =>
            rejectPromise(
              new ToolBrokerError("tool_cancelled", "Tool command was cancelled", true),
            ),
          { once: true },
        );
      });
    };
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const created = await manager.create(createRequest);
    const controller = new AbortController();
    const executing = manager.execute(
      assignment.executionLease,
      operation("63000000-0000-4000-8000-000000000001"),
      controller.signal,
    );
    await operationStarted;
    await expect(manager.stop(created.activationId, assignment)).resolves.toBeUndefined();
    expect(fixture.stopped).toBe(false);
    await expect(executing).rejects.toMatchObject({ code: "tool_cancelled" });
    expect(manager.admittedCount).toBe(0);
    await manager.close();
  });

  it("evicts the least-recently-used warm runtime when new demand reaches admission capacity", async () => {
    const fixture = providerFixture();
    const activationIds = [ACTIVATION_ID, SECOND_ACTIVATION_ID];
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => activationIds.shift()!,
      maximumActiveSandboxes: 1,
      maximumWarmWorkspaceRuntimes: 4,
    });
    const first = await manager.create(createRequest);
    await manager.execute(
      assignment.executionLease,
      operation("50000000-0000-4000-8000-000000000012"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "50000000-0000-4000-8000-000000000013",
      activationId: first.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "c".repeat(64),
    });
    expect(manager.warmCount).toBe(1);
    expect(manager.admittedCount).toBe(1);

    const nextAssignment: ToolSandboxAssignment = {
      ...assignment,
      runId: "command-provider-test-capacity-eviction",
      workspaceId: "workspace-provider-test-capacity-eviction",
      sessionId: "session-provider-test-capacity-eviction",
      turnId: "turn-provider-test-capacity-eviction",
      executionLease: createExecutionLease(
        "50000000-0000-4000-8000-000000000014",
        "50000000-0000-4000-8000-000000000014",
        6,
      ),
    };
    const second = await manager.create({
      ...createRequest,
      requestId: "50000000-0000-4000-8000-000000000015",
      assignment: nextAssignment,
    });
    await expect(
      manager.execute(nextAssignment.executionLease, {
        ...operation("50000000-0000-4000-8000-000000000016"),
        activationId: second.activationId,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(fixture.stopped).toBe(true);
    expect(fixture.createCount).toBe(2);
    expect(manager.warmCount).toBe(0);
    expect(manager.admissionWaitingCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    await manager.stop(second.activationId, nextAssignment);
  });

  it("keeps a Broker-owned warm process world out of expired Supervisor inventory", async () => {
    const fixture = providerFixture();
    const runtimeAssignment: SupervisorRuntimeAssignment = {
      containerId: "66666666-6666-4666-8666-666666666666",
      containerName: `pi-cloud-tool-${ACTIVATION_ID}`.slice(0, 63),
      supervisorId: assignment.supervisorId,
      bootId: assignment.bootId,
      sandboxId: assignment.sandboxId,
      runId: assignment.runId,
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
      turnId: assignment.turnId,
      executionLease: assignment.executionLease,
    };
    fixture.provider.listAssignments = async () => [runtimeAssignment];
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    const created = await manager.create(createRequest);
    await manager.execute(
      assignment.executionLease,
      operation("41000000-0000-4000-8000-000000000001"),
    );
    await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "41000000-0000-4000-8000-000000000002",
      activationId: created.activationId,
      assignment,
      disposition: "keep_warm",
      workspaceRevision: "b".repeat(64),
    });

    await expect(manager.listAssignments(assignment.sandboxId)).resolves.toEqual([]);
    expect(manager.warmCount).toBe(1);
    await manager.close();
  });

  it("revokes the Session lease before a provider stop failure escapes", async () => {
    const fixture = providerFixture();
    fixture.provider.stop = async () => {
      throw new ToolBrokerError("cleanup_failed", "cleanup failed", true);
    };
    const manager = testBroker({
      provider: fixture.provider,
      idGenerator: () => ACTIVATION_ID,
    });
    await manager.create(createRequest);
    await manager.execute(
      assignment.executionLease,
      operation("10000000-0000-4000-8000-000000000016"),
    );
    await expect(manager.stop(ACTIVATION_ID, assignment)).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(manager.activeCount).toBe(0);
    expect(manager.admittedCount).toBe(1);
    await expect(
      manager.execute(assignment.executionLease, operation("10000000-0000-4000-8000-000000000015")),
    ).rejects.toMatchObject({ code: "stale_session_lease" });
    fixture.provider.destroyRuntime = async () => {};
    await manager.stop(ACTIVATION_ID, assignment);
    expect(manager.admittedCount).toBe(0);
  });

  it("loads only the CubeSandbox deployment configuration", async () => {
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
      await expect(
        loadToolBrokerConfig({
          DATABASE_URL_FILE: databaseUrlPath,
          PI_CLOUD_SANDBOX_DOMAIN_ID: "sandbox-domain-0001",
          PI_CLOUD_TOOL_BROKER_ADVERTISED_URL: "http://tool-broker-0:4300",
          PI_CLOUD_TOOL_BROKER_TOKEN_FILE: tokenPath,
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
        sandboxDomainId: "sandbox-domain-0001",
        advertisedBaseUrl: "http://tool-broker-0:4300/",
        maximumActiveSandboxes: 3,
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
        loadToolBrokerConfig({
          DATABASE_URL_FILE: databaseUrlPath,
          PI_CLOUD_SANDBOX_DOMAIN_ID: "sandbox-domain-0001",
          PI_CLOUD_TOOL_BROKER_ADVERTISED_URL: "http://tool-broker-0:4300",
          PI_CLOUD_TOOL_BROKER_OWNERSHIP_LEASE_MS: "10000",
          PI_CLOUD_TOOL_BROKER_OWNERSHIP_HEARTBEAT_MS: "5000",
          PI_CLOUD_TOOL_BROKER_TOKEN_FILE: tokenPath,
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
