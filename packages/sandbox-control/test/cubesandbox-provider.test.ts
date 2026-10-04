import { InMemorySandboxBindings } from "./helpers/in-memory-sandbox-bindings.ts";
import { InMemoryWorkspaceRuntimeStateRepository } from "./helpers/in-memory-workspace-runtime-state-repository.ts";
import {
  canonicalEnvironmentRecipeJson,
  createExecutionReference,
  parseExecutionReference,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type ToolSandboxAssignment,
  type ToolSandboxOperationRequest,
} from "@pi-cloud/protocol";
import { createWorkspaceSeed, encodeWorkspaceBlob } from "@pi-cloud/workspace-runtime";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CubeSandboxProvider,
  SandboxController,
  type CubeSandboxCreateInput,
  type CubeSandboxGuestCommandRequest,
  type CubeSandboxInstance,
  type CubeSandboxProviderOptions,
  type CubeSandboxRuntimeClient,
  type SandboxControllerOptions,
} from "../src/index.ts";
import type { WorkspaceVolumeGateway } from "../src/workspace-volume-gateway.ts";
import { CubePersistentCapsuleCodec } from "../src/cube-persistent-capsule.ts";

const DEVELOPMENT_TEMPLATE_IDS = Object.freeze({
  starter: "tpl-starter00000000000000000",
  standard: "tpl-standard0000000000000000",
  performance: "tpl-performance0000000000000",
});

type TestCubeProviderOptions = Omit<CubeSandboxProviderOptions, "developmentTemplateIds"> &
  Partial<Pick<CubeSandboxProviderOptions, "developmentTemplateIds">>;

function testCubeProvider(options: TestCubeProviderOptions): CubeSandboxProvider {
  return new CubeSandboxProvider({
    developmentTemplateIds: DEVELOPMENT_TEMPLATE_IDS,
    persistentStateKey: Buffer.alloc(32, 7),
    ...options,
  });
}

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
const STEP_CONTEXT_SHA256 = "a".repeat(64);
const WEB_PROXY = Object.freeze({ host: "10.255.255.254", port: 3_128 });
const assignment: ToolSandboxAssignment = {
  tenantId: "tenant-cube-test",
  projectId: "project-cube-test",
  workspaceId: "workspace-cube-test",
  supervisorId: "supervisor-cube-test",
  bootId: "10000000-0000-4000-8000-000000000001",
  sandboxId: "10000000-0000-4000-8000-000000000002",
  runId: "command-cube-test",
  sessionId: "session-cube-test",
  turnId: "turn-cube-test",
  executionReference: createExecutionReference(
    "10000000-0000-4000-8000-000000000004",
    "10000000-0000-4000-8000-000000000003",
    7,
  ),
};

const environment = {
  environmentVersionId: "10000000-0000-4000-8000-000000000005",
  versionNumber: 1,
  profileKey: "pi-cloud-fullstack" as const,
  profileVersion: "1" as const,
  imageRevision: "development",
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const,
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};

const toolchain = {
  profileKey: environment.profileKey,
  profileVersion: environment.profileVersion,
  imageRevision: environment.imageRevision,
  specSha256: environment.specSha256,
  recipeSha256: environment.recipeSha256,
  tools: [
    { name: "node" as const, version: "v24.18.0" },
    { name: "java" as const, version: 'openjdk version "17.0.19"' },
    { name: "python" as const, version: "Python 3.11.2" },
    { name: "git" as const, version: "git version 2.39.5" },
  ],
  recipeCommands: [],
};

function fakeWorkspaceVolumeGateway(): WorkspaceVolumeGateway {
  const volumes = new Set<string>();
  return {
    checkHealth: vi.fn(async () => undefined),
    verify: vi.fn(async ({ volumeId }) => {
      volumes.add(volumeId);
      return { verified: true as const };
    }),
    listDirectory: vi.fn(async () => ({
      entries: [
        {
          name: "result.txt",
          path: "result.txt",
          kind: "file" as const,
          sizeBytes: 5,
          executable: false,
        },
      ],
      truncated: false,
    })),
    readFile: vi.fn(async () => {
      const bytes = Buffer.from("cube\n");
      return {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executable: false,
      };
    }),
    prepareDelete: vi.fn(async ({ volumeId }) => ({ prepared: volumes.has(volumeId) })),
    finalizeDelete: vi.fn(async ({ volumeId }) => ({ deleted: volumes.delete(volumeId) })),
    close: vi.fn(async () => undefined),
  };
}

class FakeCubeRuntimeClient implements CubeSandboxRuntimeClient {
  readonly cancelTool = vi.fn<CubeSandboxRuntimeClient["cancelTool"]>(async () => {});
  readonly submitProbe = vi.fn<CubeSandboxRuntimeClient["submitProbe"]>(async () => {});
  async probeExecution(
    target: Awaited<ReturnType<CubeSandboxRuntimeClient["executionTarget"]>>,
    probeId: string,
  ) {
    const current = await this.executionTarget(target.sandboxId, target.nodeId);
    if (
      current.bootId !== target.bootId ||
      this.instances.get(target.sandboxId)?.state !== "running"
    )
      throw new Error("Guest execution unavailable");
    return { type: "worker.probe_result" as const, probeId, guestBootId: this.guestBootId };
  }
  readonly submitTool = vi.fn<CubeSandboxRuntimeClient["submitTool"]>(async () => {});

  async executionTarget(sandboxId: string, nodeId: string) {
    return {
      apiUrl: "http://cube.test",
      sandboxId,
      nodeId,
      bootId: "aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa",
    };
  }
  readonly creates: CubeSandboxCreateInput[] = [];
  readonly requests: {
    sandboxId: string;
    input: CubeSandboxGuestCommandRequest;
    guestRequest: Record<string, unknown>;
  }[] = [];
  readonly guestFiles = new Map<string, Uint8Array>();
  readonly destroyed: string[] = [];
  readonly instances = new Map<string, CubeSandboxInstance>();
  healthChecks = 0;
  guestBootId = "10000000-0000-4000-8000-000000000001";
  closed = false;
  readonly terminalAdmins: boolean[] = [];

  constructor(readonly imageRevision = "development") {}

  async checkHealth(): Promise<void> {
    this.healthChecks += 1;
  }

  async ensureVolume(volumeId: string): Promise<{ volumeId: string; name: string }> {
    return { volumeId, name: volumeId };
  }

  async deleteVolume(_volumeId: string): Promise<void> {}

  async create(input: CubeSandboxCreateInput): Promise<CubeSandboxInstance> {
    this.creates.push(input);
    const sandboxId = `cube-sandbox-${String(this.creates.length)}`;
    const instance: CubeSandboxInstance = {
      sandboxId,
      templateId: input.templateId,
      nodeId: "node-test",
      state: "running",
      domain: "cube.internal",
      metadata: Object.freeze({ ...input.metadata }),
      trafficAccessToken: `private-traffic-token-${String(this.creates.length)}`,
      envdAccessToken: `envd-access-token-${String(this.creates.length)}`,
      cpuCount: 1,
      memoryMB: 768,
    };
    this.instances.set(sandboxId, instance);
    return instance;
  }

  async read(sandboxId: string): Promise<CubeSandboxInstance | undefined> {
    return this.instances.get(sandboxId);
  }

  async pause(sandboxId: string): Promise<void> {
    const instance = this.instances.get(sandboxId);
    if (instance !== undefined) this.instances.set(sandboxId, { ...instance, state: "paused" });
  }

  async observe(sandboxId: string, nodeId: string) {
    const instance = this.instances.get(sandboxId);
    return {
      runtimeName: sandboxId,
      nodeId,
      presence: instance ? ("present" as const) : ("absent" as const),
      state: instance?.state ?? ("unknown" as const),
    };
  }

  async connect(sandboxId: string): Promise<CubeSandboxInstance> {
    const instance = this.instances.get(sandboxId);
    if (instance === undefined) throw new Error("sandbox unavailable");
    const resumed = { ...instance, state: "running" as const };
    this.instances.set(sandboxId, resumed);
    return resumed;
  }

  async list(): Promise<readonly CubeSandboxInstance[]> {
    return [...this.instances.values()];
  }

  async destroy(sandboxId: string): Promise<void> {
    this.destroyed.push(sandboxId);
    this.instances.delete(sandboxId);
  }

  async writeGuestFileStream(
    _instance: CubeSandboxInstance,
    path: string,
    chunks: AsyncIterable<Uint8Array>,
  ) {
    const buffers: Buffer[] = [];
    for await (const chunk of chunks) buffers.push(Buffer.from(chunk));
    this.guestFiles.set(path, Buffer.concat(buffers));
  }

  async writeGuestFile(
    _instance: CubeSandboxInstance,
    path: string,
    data: Uint8Array,
  ): Promise<void> {
    this.guestFiles.set(path, Buffer.from(data));
  }

  async runCommand(
    instance: CubeSandboxInstance,
    input: CubeSandboxGuestCommandRequest,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cleanup =
      /^\/bin\/rm -f -- (\/tmp\/(?:pi-cloud-envd-[0-9a-f-]{36}\.json|pi-cloud-upload-[0-9a-f-]{36}))$/u.exec(
        input.command,
      );
    if (cleanup) {
      this.requests.push({
        sandboxId: instance.sandboxId,
        input,
        guestRequest: { mode: "remove_input", path: cleanup[1] },
      });
      this.guestFiles.delete(cleanup[1]!);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (input.command.includes("eval(Buffer.from('") && input.command.includes("base64")) {
      this.requests.push({
        sandboxId: instance.sandboxId,
        input,
        guestRequest: { mode: "service_discovery" },
      });
      return {
        stdout: JSON.stringify({
          listeningPorts: [3_000],
          httpServices: [{ port: 3_000, protocol: "http" }],
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    const request = this.requestForCommand(input);
    const cleanedPath = /trap '\/bin\/rm -f -- ([^']+)' EXIT/u.exec(input.command)?.[1];
    if (cleanedPath !== undefined) this.guestFiles.delete(cleanedPath);
    this.requests.push({ sandboxId: instance.sandboxId, input, guestRequest: request });
    if (input.command.includes("envd-guest-control.mjs")) {
      if (request.mode === "evidence") {
        return this.#result({
          evidence: {
            controlProtocolVersion: 2,
            imageRevision: this.imageRevision,
            kernelRelease: "6.12.0-cube.guest",
            ipAddress: "169.254.68.4",
            cpuCount: 1,
            memoryBytes: 740 * 1_024 * 1_024,
            uid: 1_000,
            gid: 1_000,
            hypervisorFlag: true,
            noNewPrivileges: true,
            effectiveCapabilities: "0000000000000000",
            readOnlyRootFilesystem: false,
            supervisorUid: 0,
            supervisorGid: 0,
          },
        });
      }
      if (request.mode === "prepare_exclusive_machine") {
        return this.#result({ home: "/home/user" });
      }
      if (request.mode === "list_directory") {
        return this.#result({
          path: request.path,
          entries: [
            {
              name: "project",
              path: `${String(request.path).replace(/\/$/u, "")}/project`,
              kind: "directory",
              sizeBytes: 4_096,
            },
          ],
        });
      }
      if (request.mode === "create_directory") {
        return this.#result({
          path: request.path,
          entries: [
            {
              name: request.name,
              path: `${String(request.path).replace(/\/$/u, "")}/${String(request.name)}`,
              kind: "directory",
              sizeBytes: 4_096,
            },
          ],
        });
      }
    }
    if (input.command.includes("envd-tool-exec.mjs")) {
      const initialization = (request.initialization ?? {}) as {
        activationId: string;
        environment: typeof environment;
      };
      if (request.mode === "initialize") {
        return this.#result({
          toolWorkerProtocolVersion: 3,
          type: "worker.ready",
          activationId: initialization.activationId,
          environment: {
            ...toolchain,
            profileKey: initialization.environment.profileKey,
            profileVersion: initialization.environment.profileVersion,
            imageRevision: initialization.environment.imageRevision,
            specSha256: initialization.environment.specSha256,
            recipeSha256: initialization.environment.recipeSha256,
            recipeCommands: [],
          },
        });
      }
      const operation = request.operation as ToolSandboxOperationRequest;
      if (operation.operation !== "tool.execute") throw new Error("unexpected operation");
      const result = this.#result({
        toolWorkerProtocolVersion: 3,
        type: "worker.operation_result",
        scopeStopRequired: false,
        response: {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: operation.activationId,
          operationId: operation.operationId,
          operation: "tool.execute",
          event: {
            type: "tool_execution_end",
            toolCallId: operation.toolCallId,
            toolName: operation.toolName,
            isError: false,
            result: { content: [{ type: "text", text: "inside cube\n" }], details: undefined },
          },
        },
      });
      await input.onStdout?.(Buffer.from(result.stdout));
      return input.onStdout ? { ...result, stdout: "" } : result;
    }
    throw new Error("unexpected guest command");
  }

  #result(value: unknown): { stdout: string; stderr: string; exitCode: number } {
    return { stdout: `${JSON.stringify(value)}\n`, stderr: "", exitCode: 0 };
  }

  requestForCommand(input: CubeSandboxGuestCommandRequest): Record<string, unknown> {
    const path = input.command.match(
      /(\/tmp\/(?:pi-cloud-envd-[0-9a-f-]{36}\.json|pi-cloud-upload-[0-9a-f-]{36}))$/u,
    )?.[1];
    const bytes = path === undefined ? undefined : this.guestFiles.get(path);
    if (bytes === undefined) throw new Error("guest request unavailable");
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  }

  async openTcp(_instance: CubeSandboxInstance, _port: number) {
    return new PassThrough();
  }

  async openTerminal(
    _instance: CubeSandboxInstance,
    input: Readonly<{ admin: boolean }>,
  ): Promise<{
    pid: number;
    output: AsyncIterable<Uint8Array>;
    sendInput(data: Uint8Array): Promise<void>;
    resize(size: Readonly<{ rows: number; cols: number }>): Promise<void>;
    kill(): Promise<void>;
    disconnect(): void;
  }> {
    this.terminalAdmins.push(input.admin);
    return {
      pid: 41,
      output: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("terminal ready\n");
        },
      },
      async sendInput() {},
      async resize() {},
      async kill() {},
      disconnect() {},
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("CubeSandbox Provider contract", () => {
  it("keeps large uploaded image normalization on the bounded guest management port", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    const data = Buffer.alloc(6 * 1024 * 1024, 42).toString("base64");
    vi.spyOn(runtime, "runCommand").mockResolvedValue({
      stdout: JSON.stringify({ ok: true, result: { data, mimeType: "image/png", hints: [] } }),
      stderr: "",
      exitCode: 0,
    });
    expect(
      await provider.prepareInputImage(handle, {
        chunks: (async function* () {
          yield Buffer.from("input");
        })(),
        byteLength: 5,
        mimeType: "image/png",
      }),
    ).toEqual({
      data,
      mimeType: "image/png",
      hints: [],
    });
    await provider.destroy(handle);
    await provider.close();
  });

  it("preserves elastic VM ownership metadata when the control plane shuts down", async () => {
    const runtime = new FakeCubeRuntimeClient(),
      volume = fakeWorkspaceVolumeGateway();
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    const setState = vi.spyOn(repository, "setWorkspaceRuntimeState");
    const closeRepository = vi.spyOn(repository, "close");
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: volume,
    });
    const broker = testBroker({ provider, stateRepository: repository });
    await broker.create({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: crypto.randomUUID(),
      assignment,
      environment,
      sandboxProfileKey: "standard",
      toolRoot: "/workspace",
      workspaceSeed: { kind: "sample_java" },
      allowedTools: ["bash"],
      executionMode: "elastic",
      turnContextSha256: STEP_CONTEXT_SHA256,
      executionContextSha256: STEP_CONTEXT_SHA256,
    });
    setState.mockClear();
    const failure = new Error("Cube deletion was not confirmed");
    vi.spyOn(runtime, "destroy").mockRejectedValue(failure);
    await expect(broker.close()).resolves.toBeUndefined();
    expect(runtime.destroyed).toEqual([]);
    expect.soft(setState.mock.calls.some(([, state]) => state === "released")).toBe(false);
    expect.soft(closeRepository).toHaveBeenCalledOnce();
    expect.soft(runtime.closed).toBe(true);
    expect.soft(volume.close).toHaveBeenCalledOnce();
    expect(runtime.instances.size).toBe(1);
  });

  it("closes both transports without destroying elastic VMs during shutdown", async () => {
    const runtime = new FakeCubeRuntimeClient(),
      volume = fakeWorkspaceVolumeGateway();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: volume,
    });
    for (let index = 0; index < 2; index++)
      await provider.create({
        activationId: crypto.randomUUID(),
        assignment: { ...assignment, workspaceId: `close-${index}` },
        environment,
        workspaceSeed: { kind: "sample_java" },
        policy: provider.defaultPolicy,
      });
    const destroyFailure = new Error("destroy failed"),
      closeFailure = new Error("transport close failed");
    const destroy = vi.spyOn(runtime, "destroy").mockRejectedValueOnce(destroyFailure);
    vi.spyOn(runtime, "close").mockRejectedValueOnce(closeFailure);
    await expect(provider.close()).rejects.toMatchObject({
      errors: [closeFailure],
    });
    expect(destroy).not.toHaveBeenCalled();
    expect(volume.close).toHaveBeenCalledOnce();
  });

  it("mounts a machine's home Volume in temporary child compute without cloning or deleting storage", async () => {
    const runtime = new FakeCubeRuntimeClient(),
      volume = fakeWorkspaceVolumeGateway();
    const deleteVolume = vi.spyOn(runtime, "deleteVolume");
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: volume,
    });
    const parent = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
      lifetime: "development_environment",
      toolRoot: "/home/user/project",
    });
    const child = await provider.create({
      activationId: "10000000-0000-4000-8000-000000000011",
      assignment: { ...assignment, sessionId: "child-session" },
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
      volumeMountPath: "/home/user",
      toolRoot: "/home/user/worktrees/feature-a",
    });
    expect(child.runtimeId).not.toBe(parent.runtimeId);
    expect(runtime.creates[0]?.volumeMounts).toEqual(runtime.creates[1]?.volumeMounts);
    expect(runtime.creates[1]?.volumeMounts?.[0]?.path).toBe("/home/user");
    expect(runtime.creates[1]).not.toHaveProperty("lifecycle");
    expect(
      runtime.requests.some(
        ({ sandboxId, guestRequest }) =>
          sandboxId === child.runtimeName &&
          (guestRequest.initialization as { toolRoot?: string } | undefined)?.toolRoot ===
            "/home/user/worktrees/feature-a",
      ),
    ).toBe(true);
    await provider.destroy(child);
    expect(runtime.destroyed).not.toContain(parent.runtimeName);
    expect(deleteVolume).not.toHaveBeenCalled();
    expect(volume.prepareDelete).not.toHaveBeenCalled();
    await provider.destroy(parent);
    await provider.close();
  });
  it("describes a verified warm runtime without a control-plane GET", async () => {
    const runtime = new FakeCubeRuntimeClient(),
      volume = fakeWorkspaceVolumeGateway();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: volume,
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    const inspect = vi
      .spyOn(runtime, "read")
      .mockRejectedValue(new Error("control plane unavailable"));
    await expect(
      provider.describeExecution(handle, ACTIVATION_ID, "/workspace"),
    ).resolves.toMatchObject({
      target: { apiUrl: "http://cube.test", sandboxId: handle.runtimeName, nodeId: "node-test" },
      initialization: { activationId: ACTIVATION_ID, toolRoot: "/workspace" },
    });
    expect(inspect).not.toHaveBeenCalled();
    // Lifecycle identity validation remains authoritative when explicitly inspecting.
    await expect(provider.inspect(handle)).rejects.toThrow("control plane unavailable");
    inspect.mockRestore();
    await provider.destroy(handle);
    await provider.close();
  });
  it.each(["paused", "pausing", "stopped", "error", "unknown"] as const)(
    "preserves observed %s without probing the guest or deciding to destroy its VM",
    async (state) => {
      const runtime = new FakeCubeRuntimeClient();
      const provider = testCubeProvider({
        templateId: "pi-cloud-tool-v1",
        imageRevision: "development",
        webProxy: WEB_PROXY,
        runtimeClient: runtime,
        workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      });
      const handle = await provider.create({
        activationId: ACTIVATION_ID,
        assignment,
        environment,
        workspaceSeed: { kind: "sample_java" },
        policy: provider.defaultPolicy,
      });
      const instance = runtime.instances.get(handle.runtimeName)!;
      runtime.instances.set(handle.runtimeName, { ...instance, state });
      const probe = vi.spyOn(runtime, "runCommand"),
        destroy = vi.spyOn(runtime, "destroy");
      try {
        expect((await provider.inspect(handle)).state).toBe(state);
        expect(probe).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        await provider.destroy(handle);
        await provider.close();
      }
    },
  );

  it("keeps destruction unconfirmed when Cube acknowledges DELETE but still lists the VM", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    const destroy = vi.spyOn(runtime, "destroy").mockResolvedValue(undefined);
    await expect(provider.destroy(handle)).rejects.toMatchObject({
      code: "cubesandbox_assignment_still_alive",
    });
    expect((await provider.inspect(handle)).state).toBe("running");
    destroy.mockRestore();
    await provider.destroy(handle);
    expect(runtime.instances.size).toBe(0);
    await provider.close();
  });

  it("attests a real-template probe with full-public egress and private ingress", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    await provider.checkHealth();
    expect(runtime.healthChecks).toBe(1);
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.creates[0]).toMatchObject({
      templateId: "pi-cloud-tool-v1",
      allowInternetAccess: true,
      allowPublicTraffic: false,
      metadata: {
        "picloud.managed": "true",
        "picloud.provider": "cubesandbox",
        "picloud.workload": "runtime-probe",
      },
    });
    expect(runtime.destroyed).toEqual(["cube-sandbox-1"]);
    await provider.close();
  });

  it("rejects callers that try to replace the deployment-owned Cube network policy", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    await expect(
      provider.create({
        activationId: ACTIVATION_ID,
        assignment,
        environment,
        workspaceSeed: { kind: "sample_java" },
        policy: {
          ...provider.defaultPolicy,
          network: { mode: "deny_all" } as never,
        },
      }),
    ).rejects.toMatchObject({
      code: "cubesandbox_policy_unsupported",
      retryable: false,
    });
    expect(runtime.creates).toHaveLength(0);
    await provider.close();
  });

  it("uses Cube never-timeout lifecycle and preserves identity across development pause/resume", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const persistentStateKey = Buffer.alloc(32, 9);
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      developmentTemplateIds: {
        starter: "tpl-starter00000000000000000",
        standard: "tpl-standard0000000000000000",
        performance: "tpl-performance0000000000000",
      },
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      persistentStateKey,
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: {
        kind: "bundle",
        bundle: encodeWorkspaceBlob(createWorkspaceSeed([])),
      },
      policy: provider.defaultPolicy,
      lifetime: "development_environment",
      sandboxProfileKey: "standard",
    });
    const terminal = await provider.openTerminal(handle, { rows: 24, cols: 100 });
    expect(runtime.terminalAdmins).toEqual([true]);
    await terminal.kill();
    await expect(provider.listDirectory(handle, "/home/user")).resolves.toMatchObject({
      path: "/home/user",
      entries: [{ name: "project", path: "/home/user/project", kind: "directory" }],
    });
    await expect(
      provider.createDirectory(handle, "/home/user", "new-project"),
    ).resolves.toMatchObject({
      path: "/home/user",
      entries: [{ name: "new-project", path: "/home/user/new-project", kind: "directory" }],
    });
    for (const name of ["x".repeat(255), "目".repeat(85)]) {
      await expect(provider.createDirectory(handle, "/home/user", name)).resolves.toMatchObject({
        entries: [{ name }],
      });
    }
    await expect(
      provider.createDirectory(handle, "/home/user", "目".repeat(86)),
    ).rejects.toMatchObject({
      code: "development_environment_directory_invalid",
    });
    const preview = await provider.openPreviewConnection(handle, 5173);
    expect(preview).toBeInstanceOf(PassThrough);
    preview.destroy();
    await expect(provider.discoverHttpServices(handle)).resolves.toEqual({
      listeningPorts: [3_000],
      httpServices: [{ port: 3_000, protocol: "http" }],
    });
    expect(runtime.guestFiles.size).toBe(0);
    expect(runtime.creates[0]).toMatchObject({
      templateId: "tpl-standard0000000000000000",
      timeoutSeconds: -1,
      lifecycle: { onTimeout: "pause", autoResume: true },
      volumeMounts: [
        {
          name: expect.stringMatching(/^pcw-[0-9a-f]{48}$/),
          path: "/home/user",
        },
      ],
    });
    expect(handle.workspaceRoot).toBe("/home/user");
    expect(
      runtime.requests.find((entry) => entry.guestRequest.mode === "initialize")?.guestRequest,
    ).toMatchObject({ initialization: { toolRoot: "/home/user" } });
    expect(
      runtime.requests.findIndex(
        (entry) => entry.guestRequest.mode === "prepare_exclusive_machine",
      ),
    ).toBeLessThan(runtime.requests.findIndex((entry) => entry.guestRequest.mode === "initialize"));
    expect(
      runtime.requests.some((entry) => entry.guestRequest.mode === "prepare_exclusive_machine"),
    ).toBe(true);
    await provider.pause(handle);
    const persisted = await provider.persistentCapsule(handle);
    expect(persisted.capsule).not.toContain(handle.runtimeName);
    // Physical adoption must not parse/re-authorize the retired creation Run.
    // Current Tool effects still require a fresh Broker-validated execution.
    const codec = new CubePersistentCapsuleCodec(persistentStateKey);
    const saved = codec.open(persisted.capsule) as { handle: typeof handle };
    const retiredBootstrap = "retired-bootstrap-label";
    expect(() => parseExecutionReference(retiredBootstrap)).toThrow();
    const physicalCapsule = codec.seal({
      ...saved,
      handle: {
        ...saved.handle,
        assignment: { ...saved.handle.assignment, executionReference: retiredBootstrap },
      },
    });
    await provider.detachPersistent(handle);
    const replacement = testCubeProvider({
      templateId: "pi-cloud-tool-v2",
      developmentTemplateIds: {
        starter: "tpl-starter00000000000000000",
        standard: "tpl-standard0000000000000000",
        performance: "tpl-performance0000000000000",
      },
      // A deployment may advance its default template while a user-owned
      // machine keeps running its original, internally-consistent guest image.
      imageRevision: "next-development-release",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      persistentStateKey,
    });
    const adopted = await replacement.adoptPersistentCapsule(physicalCapsule);
    await expect(replacement.resume(adopted)).resolves.toMatchObject({
      activationId: ACTIVATION_ID,
      runtimeId: handle.runtimeId,
    });
    await replacement.destroy(adopted);
    await provider.close();
    await replacement.close();
  });

  it("keeps the Workspace runtime outside Supervisor assignment inventory", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const workspaceVolumeGateway = fakeWorkspaceVolumeGateway();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway,
    });
    const manager = testBroker({
      provider,
      imageRevision: "development",
      idGenerator: () => ACTIVATION_ID,
    });
    const reserved = await manager.create({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: "10000000-0000-4000-8000-000000000011",
      sandboxProfileKey: "standard",
      toolRoot: "/workspace",
      assignment,
      turnContextSha256: STEP_CONTEXT_SHA256,
      executionContextSha256: STEP_CONTEXT_SHA256,
      allowedTools: ["read", "write", "edit", "bash"],
      executionMode: "elastic",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.creates[0]?.timeoutSeconds).toBe(-1);
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.creates[0]?.metadata).not.toHaveProperty("host-mount");
    const activeAssignments = await manager.listAssignments(assignment.sandboxId);
    expect(activeAssignments).toMatchObject([
      { containerId: reserved.activationId, runId: assignment.runId },
    ]);
    const materialized = await manager.readWorkspaceFile({
      toolBrokerProtocolVersion: 1,
      type: "workspace.read_file",
      requestId: "10000000-0000-4000-8000-000000000023",
      tenantId: assignment.tenantId,
      workspaceId: assignment.workspaceId,
      sessionId: assignment.sessionId,
      rootPath: "",
      path: "result.txt",
      maximumBytes: 512 * 1_024,
    });
    expect(materialized).toMatchObject({
      type: "workspace.file_read",
      path: "result.txt",
      content: Buffer.from("cube\n").toString("base64"),
    });
    const upgradedBroker = testBroker({
      provider: testCubeProvider({
        templateId: "pi-cloud-tool-v2",
        imageRevision: "next-deployment",
        webProxy: WEB_PROXY,
        runtimeClient: new FakeCubeRuntimeClient(),
        workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      }),
      imageRevision: "next-deployment",
    });
    await expect(
      upgradedBroker.readWorkspaceFile({
        toolBrokerProtocolVersion: 1,
        type: "workspace.read_file",
        requestId: "10000000-0000-4000-8000-000000000024",
        tenantId: assignment.tenantId,
        workspaceId: assignment.workspaceId,
        sessionId: assignment.sessionId,
        rootPath: "",
        path: "result.txt",
        maximumBytes: 512 * 1_024,
      }),
    ).resolves.toMatchObject({
      type: "workspace.file_read",
      path: "result.txt",
      content: Buffer.from("cube\n").toString("base64"),
    });
    await upgradedBroker.close();
    expect(workspaceVolumeGateway.readFile).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: assignment.sessionId,
        path: "result.txt",
      }),
    );
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.destroyed).toEqual([]);
    expect(manager.admittedCount).toBe(1);
    const released = await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "10000000-0000-4000-8000-000000000022",
      activationId: reserved.activationId,
      assignment,
      disposition: "keep_warm",
    });
    expect(released.retained).toBe(true);
    expect(runtime.destroyed).toEqual([]);
    expect(manager.warmCount).toBe(1);
    expect(runtime.instances.get("cube-sandbox-1")?.state).toBe("running");
    expect(runtime.destroyed).toEqual([]);

    const idleAssignment: ToolSandboxAssignment = {
      ...assignment,
      runId: "command-cube-test-idle",
      turnId: "turn-cube-test-idle",
      executionReference: createExecutionReference(
        "10000000-0000-4000-8000-000000000029",
        "10000000-0000-4000-8000-000000000028",
        9,
      ),
    };
    const idle = await manager.create({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: "10000000-0000-4000-8000-000000000027",
      sandboxProfileKey: "standard",
      toolRoot: "/workspace",
      assignment: idleAssignment,
      turnContextSha256: STEP_CONTEXT_SHA256,
      executionContextSha256: STEP_CONTEXT_SHA256,
      allowedTools: ["read", "write", "edit", "bash"],
      executionMode: "elastic",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    expect(idle.continuity).toBe("warm_reuse");
    await expect(
      manager.release({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.release",
        requestId: "10000000-0000-4000-8000-000000000026",
        activationId: idle.activationId,
        assignment: idleAssignment,
        disposition: "keep_warm",
      }),
    ).resolves.toMatchObject({ retained: true });
    expect(runtime.creates).toHaveLength(1);

    const nextAssignment: ToolSandboxAssignment = {
      ...assignment,
      supervisorId: "supervisor-cube-test-next",
      bootId: "20000000-0000-4000-8000-000000000030",
      sandboxId: "20000000-0000-4000-8000-000000000031",
      runId: "command-cube-test-2",
      turnId: "turn-cube-test-2",
      executionReference: createExecutionReference(
        "10000000-0000-4000-8000-000000000031",
        "10000000-0000-4000-8000-000000000030",
        11,
      ),
    };
    const next = await manager.create({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.create",
      requestId: "10000000-0000-4000-8000-000000000032",
      sandboxProfileKey: "standard",
      toolRoot: "/workspace",
      assignment: nextAssignment,
      turnContextSha256: STEP_CONTEXT_SHA256,
      executionContextSha256: STEP_CONTEXT_SHA256,
      allowedTools: ["read", "write", "edit", "bash"],
      executionMode: "elastic",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    expect(next.activationId).toBe(
      parseExecutionReference(nextAssignment.executionReference).runId,
    );
    expect(next.activationId).not.toBe(reserved.activationId);
    expect(next.continuity).toBe("warm_reuse");
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.instances.get("cube-sandbox-1")?.state).toBe("running");
    expect(await manager.listAssignments(nextAssignment.sandboxId)).toMatchObject([
      { containerId: next.activationId },
    ]);
    const destroyed = await manager.release({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId: "10000000-0000-4000-8000-000000000034",
      activationId: next.activationId,
      assignment: nextAssignment,
      disposition: "destroy",
    });
    expect(destroyed.retained).toBe(false);
    expect(runtime.destroyed).toEqual(["cube-sandbox-1"]);
    expect(manager.warmCount).toBe(0);
    await manager.close();
  });

  it("reattaches a persistent Workspace Volume to another Session with an independent fence", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const workspaceVolumeGateway = fakeWorkspaceVolumeGateway();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway,
    });
    const first = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    await provider.destroy(first);

    const nextActivationId = "20000000-0000-4000-8000-000000000041";
    const nextAssignment: ToolSandboxAssignment = {
      ...assignment,
      sessionId: "session-cube-shared-workspace",
      supervisorId: "supervisor-cube-restore",
      bootId: "20000000-0000-4000-8000-000000000042",
      sandboxId: "20000000-0000-4000-8000-000000000043",
      runId: "command-cube-restore",
      turnId: "turn-cube-restore",
      // Fencing tokens are monotonic within a Session. Another Session in the
      // same Workspace has an independent fence sequence and may legitimately
      // begin at the same value as the checkpoint's source Session.
      executionReference: createExecutionReference(
        "20000000-0000-4000-8000-000000000045",
        "20000000-0000-4000-8000-000000000044",
        parseExecutionReference(assignment.executionReference).fencingToken,
      ),
    };
    const restored = await provider.create({
      activationId: nextActivationId,
      assignment: nextAssignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    expect(runtime.creates).toHaveLength(2);
    expect(runtime.creates[1]).toMatchObject({
      templateId: "pi-cloud-tool-v1",
      allowInternetAccess: true,
      allowPublicTraffic: false,
      volumeMounts: [
        {
          name: expect.stringMatching(/^pcw-[0-9a-f]{48}$/),
          path: "/workspace",
        },
      ],
    });
    expect(
      Object.entries(runtime.creates[1]!.metadata).some(
        ([key, value]) =>
          key.startsWith("picloud.workspace-runtime.v1.") && value.includes(nextActivationId),
      ),
    ).toBe(true);
    await expect(provider.inspect(restored)).resolves.toMatchObject({ state: "running" });
    expect(workspaceVolumeGateway.verify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenantId: assignment.tenantId,
        workspaceId: assignment.workspaceId,
        sessionId: nextAssignment.sessionId,
      }),
    );
    const initialize = runtime.requests.find(
      ({ sandboxId, guestRequest }) =>
        sandboxId === "cube-sandbox-2" && guestRequest.mode === "initialize",
    );
    expect(
      (initialize?.guestRequest.initialization as { activationId?: string } | undefined)
        ?.activationId,
    ).toBe(nextActivationId);
    expect(restored.assignment).toEqual(nextAssignment);
    await provider.destroy(restored);
    await provider.close();
  });

  it("executes parent and child Tool bindings concurrently in one Workspace Cube", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    const parent = await provider.create({
      activationId: ACTIVATION_ID,
      assignment: {
        ...assignment,
        executionReference: createExecutionReference(
          "20000000-0000-4000-8000-000000000050",
          parseExecutionReference(assignment.executionReference).runId,
          41,
        ),
      },
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });

    const childBindingId = "20000000-0000-4000-8000-000000000054";
    const parentDescriptor = await provider.describeExecution(parent, ACTIVATION_ID, "/workspace");
    const childDescriptor = await provider.describeExecution(
      parent,
      childBindingId,
      "/workspace/child",
    );
    expect(parentDescriptor.target).toEqual(childDescriptor.target);
    expect(childDescriptor.initialization).toMatchObject({
      activationId: childBindingId,
      toolRoot: "/workspace/child",
    });
    await expect(provider.inspect(parent)).resolves.toMatchObject({ state: "running" });
    expect(runtime.creates).toHaveLength(1);
    await provider.destroy(parent);
    await provider.close();
  });

  it("reattaches the persistent Workspace Volume after the Tool image is upgraded", async () => {
    const originalProvider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: new FakeCubeRuntimeClient(),
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    const originalHandle = await originalProvider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: originalProvider.defaultPolicy,
    });
    await originalProvider.destroy(originalHandle);
    await originalProvider.close();

    const upgradedRuntime = new FakeCubeRuntimeClient("next-deployment");
    const upgradedVolumeGateway = fakeWorkspaceVolumeGateway();
    const upgradedProvider = testCubeProvider({
      templateId: "pi-cloud-tool-v2",
      imageRevision: "next-deployment",
      webProxy: WEB_PROXY,
      runtimeClient: upgradedRuntime,
      workspaceVolumeGateway: upgradedVolumeGateway,
    });
    const upgradedAssignment = {
      ...assignment,
      executionReference: createExecutionReference(
        "20000000-0000-4000-8000-000000000061",
        parseExecutionReference(assignment.executionReference).runId,
        parseExecutionReference(assignment.executionReference).fencingToken + 1,
      ),
    };
    const upgradedHandle = await upgradedProvider.create({
      activationId: "20000000-0000-4000-8000-000000000050",
      assignment: upgradedAssignment,
      environment: { ...environment, imageRevision: "next-deployment" },
      workspaceSeed: { kind: "sample_java" },
      policy: upgradedProvider.defaultPolicy,
    });
    expect(upgradedVolumeGateway.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: assignment.tenantId,
        workspaceId: assignment.workspaceId,
      }),
    );
    expect(upgradedRuntime.creates).toHaveLength(1);
    await upgradedProvider.destroy(upgradedHandle);
    await upgradedProvider.close();
  });

  it.each(["before_upload", "after_upload", "cleanup_failure", "cleanup_nonzero"] as const)(
    "cleans a cancelled image preparation before guest execution (%s)",
    async (phase) => {
      const runtime = new FakeCubeRuntimeClient();
      const provider = testCubeProvider({
        templateId: "pi-cloud-tool-v1",
        imageRevision: "development",
        webProxy: WEB_PROXY,
        runtimeClient: runtime,
        workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      });
      const handle = await provider.create({
        activationId: ACTIVATION_ID,
        assignment,
        environment,
        workspaceSeed: { kind: "sample_java" },
        policy: provider.defaultPolicy,
        lifetime: "development_environment",
      });
      const abort = new AbortController();
      const reason = new Error("Task cancelled before guest dispatch");
      const originalWrite = runtime.writeGuestFileStream.bind(runtime);
      const writes = vi
        .spyOn(runtime, "writeGuestFileStream")
        .mockImplementation(async (...args) => {
          await originalWrite(...args);
          abort.abort(reason);
        });
      const cleanupError = new Error("Guest cleanup channel is unavailable");
      const originalRun = runtime.runCommand.bind(runtime);
      const calls = vi.spyOn(runtime, "runCommand").mockImplementation(async (instance, input) => {
        if (phase === "cleanup_failure") throw cleanupError;
        if (phase === "cleanup_nonzero") return { stdout: "", stderr: "denied", exitCode: 7 };
        return originalRun(instance, input);
      });
      if (phase === "before_upload") abort.abort(reason);
      try {
        const result = await provider
          .prepareInputImage(
            handle,
            {
              chunks: (async function* () {
                yield Buffer.from("image");
              })(),
              byteLength: 5,
              mimeType: "image/png",
            },
            abort.signal,
          )
          .catch((error) => error);
        if (phase === "cleanup_failure" || phase === "cleanup_nonzero") {
          expect(result).toBeInstanceOf(AggregateError);
          expect(result.errors[0]).toBe(reason);
          if (phase === "cleanup_failure") expect(result.errors[1]).toBe(cleanupError);
          else expect(result.errors[1].message).toContain("code 7");
          expect(runtime.guestFiles.size).toBe(1);
        } else {
          expect(result).toBe(reason);
          expect(runtime.guestFiles.size).toBe(0);
        }
        expect(writes).toHaveBeenCalledTimes(phase === "before_upload" ? 0 : 1);
        expect(calls).toHaveBeenCalledTimes(phase === "before_upload" ? 0 : 1);
        for (const [, request] of calls.mock.calls) {
          expect(request.command).toMatch(/^\/bin\/rm -f -- \/tmp\/pi-cloud-upload-/);
          expect(request.signal).toBeUndefined();
        }
        expect(runtime.destroyed).toEqual([]);
      } finally {
        writes.mockRestore();
        calls.mockRestore();
        await provider.destroy(handle);
        await provider.close();
      }
    },
  );

  it("retains an initialization rejection without enabling creation retries", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const original = runtime.runCommand.bind(runtime);
    runtime.runCommand = async (instance, input) =>
      runtime.requestForCommand(input).mode === "initialize"
        ? {
            stdout: JSON.stringify({
              toolWorkerProtocolVersion: 3,
              type: "worker.failed",
              code: "workspace_attach_invalid",
              message: "Preserved workspace could not be attached",
              retryable: true,
            }),
            stderr: "",
            exitCode: 0,
          }
        : original(instance, input);
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    try {
      await expect(
        provider.create({
          activationId: ACTIVATION_ID,
          assignment,
          environment,
          workspaceSeed: { kind: "sample_java" },
          policy: provider.defaultPolicy,
        }),
      ).rejects.toMatchObject({
        code: "environment_preflight_mismatch",
        retryable: false,
        absenceConfirmed: true,
        cause: {
          cause: {
            code: "workspace_attach_invalid",
            message: "Preserved workspace could not be attached",
          },
        },
      });
      expect(runtime.destroyed).toEqual(["cube-sandbox-1"]);
    } finally {
      await provider.close();
    }
  });

  it("retains the readiness failure cause while releasing the probe VM", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const cause = new Error("Guest transport disconnected");
    vi.spyOn(runtime, "runCommand").mockRejectedValue(cause);
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      readyTimeoutMs: 30,
    });
    try {
      await expect(provider.checkHealth()).rejects.toMatchObject({
        code: "cubesandbox_data_plane_unavailable",
        cause,
      });
      expect(runtime.destroyed).toEqual(["cube-sandbox-1"]);
    } finally {
      await provider.close();
    }
  });

  it("retains guest continuity and observes a reboot after capsule adoption", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
      lifetime: "development_environment",
    });
    const before = await provider.probeExecution(handle);
    const capsule = await provider.persistentCapsule(handle);
    await provider.detachPersistent(handle);
    const adopted = await provider.adoptPersistentCapsule(capsule.capsule);
    expect(await provider.probeExecution(adopted)).toEqual(before);
    runtime.guestBootId = "20000000-0000-4000-8000-000000000002";
    expect(await provider.probeExecution(adopted)).not.toEqual(before);
    expect(runtime.destroyed).toEqual([]);
    await provider.destroy(adopted);
    await provider.close();
  });

  it("does not adopt a control-plane running VM whose Guest is unreachable", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      persistentStateKey: Buffer.alloc(32, 9),
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
      lifetime: "development_environment",
    });
    const capsule = await provider.persistentCapsule(handle);
    await provider.detachPersistent(handle);
    const original = runtime.probeExecution.bind(runtime);
    runtime.probeExecution = async () => {
      throw new Error("host unavailable");
    };
    await expect(provider.adoptPersistentCapsule(capsule.capsule)).rejects.toMatchObject({
      code: "cubesandbox_tool_unavailable",
    });
    expect(runtime.destroyed).toEqual([]);
    runtime.probeExecution = original;
    const recovered = await provider.adoptPersistentCapsule(capsule.capsule);
    expect(recovered.runtimeId).toBe(handle.runtimeId);
    // Even a provider shutdown without a successful explicit detach cannot
    // release a user's machine. The control plane retains its capsule.
    await provider.close();
    expect(runtime.destroyed).toEqual([]);
  });

  it("refuses executor boot replacement during adoption without deleting the VM", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
      lifetime: "development_environment",
    });
    const capsule = await provider.persistentCapsule(handle);
    await provider.detachPersistent(handle);
    vi.spyOn(runtime, "executionTarget").mockResolvedValue({
      apiUrl: "http://cube.test",
      sandboxId: handle.runtimeName,
      nodeId: "node-test",
      bootId: "22222222-2222-4222-8222-222222222222",
    });
    await expect(provider.adoptPersistentCapsule(capsule.capsule)).rejects.toMatchObject({
      code: "cubesandbox_tool_unavailable",
    });
    expect(runtime.destroyed).toEqual([]);
    await provider.destroyPersistentCapsule(capsule.capsule, ACTIVATION_ID, assignment);
    await provider.close();
  });

  it("runs dependency setup inside the same full-public Cube VM", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const dependencyRecipe = {
      schemaVersion: 1 as const,
      dependencyHosts: ["registry.npmjs.org"],
      setupCommands: [
        {
          id: "install",
          command: "npm install",
          cwd: ".",
          timeoutMs: 60_000,
          network: "dependency" as const,
        },
      ],
      verificationCommands: [
        {
          id: "verify",
          command: "npm test",
          cwd: ".",
          timeoutMs: 60_000,
          network: "none" as const,
        },
      ],
    };
    const dependencyEnvironment = {
      ...environment,
      recipe: dependencyRecipe,
      recipeSha256: createHash("sha256")
        .update(canonicalEnvironmentRecipeJson(dependencyRecipe))
        .digest("hex") as `${string}`,
    };
    const provider = testCubeProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
    });
    const handle = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment: dependencyEnvironment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.creates[0]).toMatchObject({
      allowInternetAccess: true,
      allowPublicTraffic: false,
    });
    const initialize = runtime.requests.find(
      ({ guestRequest }) => guestRequest.mode === "initialize",
    );
    const initialization = initialize?.guestRequest.initialization as
      Record<string, unknown> | undefined;
    expect(initialization).toMatchObject({
      webProxy: WEB_PROXY,
    });
    expect(initialization).not.toHaveProperty("environmentStage");
    expect(initialization).not.toHaveProperty("workspaceSettlement");
    await provider.destroy(handle);
    await provider.close();
  });
});
