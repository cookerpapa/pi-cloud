import {
  canonicalEnvironmentRecipeJson,
  createExecutionLease,
  parseExecutionLease,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type ToolSandboxAssignment,
  type ToolSandboxOperationRequest,
} from "@pi-cloud/protocol";
import {
  createWorkspaceSnapshot,
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
  parsePersistentVolumeReference,
} from "@pi-cloud/workspace-runtime";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CubeSandboxProvider,
  ToolBroker,
  type CubeSandboxCreateInput,
  type CubeSandboxGuestCommandRequest,
  type CubeSandboxInstance,
  type CubeSandboxRuntimeClient,
} from "../src/index.ts";
import type { WorkspaceVolumeGateway } from "../src/workspace-volume-gateway.ts";

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
  executionLease: createExecutionLease(
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
    prepare: vi.fn(async ({ volumeId }) => {
      const attached = volumes.has(volumeId);
      volumes.add(volumeId);
      return { attached };
    }),
    snapshot: vi.fn(async () => ({
      volumeRevision: "a".repeat(64),
      files: [
        {
          path: "result.txt",
          executable: false,
          sizeBytes: 5,
          sha256: createHash("sha256").update("cube\n").digest("hex"),
        },
      ],
    })),
    fork: vi.fn(async () => ({
      sourceRevision: "a".repeat(64),
      volumeRevision: "c".repeat(64),
      files: [
        {
          path: "result.txt",
          executable: false,
          sizeBytes: 5,
          sha256: createHash("sha256").update("cube\n").digest("hex"),
        },
      ],
    })),
    materialize: vi.fn(async () => {
      const bytes = Buffer.from("cube\n");
      return {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
    delete: vi.fn(async ({ volumeId }) => ({ deleted: volumes.delete(volumeId) })),
    close: vi.fn(async () => undefined),
  };
}

class FakeCubeRuntimeClient implements CubeSandboxRuntimeClient {
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

  async connect(sandboxId: string): Promise<CubeSandboxInstance> {
    const instance = this.instances.get(sandboxId);
    if (instance === undefined) throw new Error("sandbox unavailable");
    const resumed = { ...instance, state: "running" };
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

  async writeGuestFile(
    _instance: CubeSandboxInstance,
    path: string,
    data: Uint8Array,
  ): Promise<void> {
    this.guestFiles.set(path, Buffer.from(data));
  }

  async removeGuestFile(_instance: CubeSandboxInstance, path: string): Promise<void> {
    this.guestFiles.delete(path);
  }

  async runCommand(
    instance: CubeSandboxInstance,
    input: CubeSandboxGuestCommandRequest,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    this.requests.push({ sandboxId: instance.sandboxId, input, guestRequest: request });
    if (input.command.includes("envd-preview-proxy.mjs")) {
      if (request.mode !== "preview_http") throw new Error("unexpected preview request");
      return this.#result({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from("<html>private-preview-ok</html>").toString("base64"),
      });
    }
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
      if (request.mode === "freeze") return this.#result({ processes: [] });
      if (request.mode === "thaw") return this.#result({ resumed: 0 });
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
        workspaceAttach?: { recipeCommands: typeof toolchain.recipeCommands };
      };
      if (request.mode === "initialize") {
        return this.#result({
          toolWorkerProtocolVersion: 1,
          type: "worker.ready",
          activationId: initialization.activationId,
          environment: {
            ...toolchain,
            profileKey: initialization.environment.profileKey,
            profileVersion: initialization.environment.profileVersion,
            imageRevision: initialization.environment.imageRevision,
            specSha256: initialization.environment.specSha256,
            recipeSha256: initialization.environment.recipeSha256,
            recipeCommands: initialization.workspaceAttach?.recipeCommands ?? [],
          },
        });
      }
      const operation = request.operation as ToolSandboxOperationRequest;
      if (operation.operation !== "bash.exec") throw new Error("unexpected operation");
      return this.#result({
        toolWorkerProtocolVersion: 1,
        type: "worker.operation_result",
        response: {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: operation.activationId,
          operationId: operation.operationId,
          operation: "bash.exec",
          exitCode: 0,
          outputChunks: [
            { seq: 1, stream: "stdout", data: Buffer.from("inside cube\n").toString("base64") },
          ],
          outputSha256: createHash("sha256").update("inside cube\n").digest("hex"),
        },
      });
    }
    throw new Error("unexpected guest command");
  }

  #result(value: unknown): { stdout: string; stderr: string; exitCode: number } {
    return { stdout: `${JSON.stringify(value)}\n`, stderr: "", exitCode: 0 };
  }

  requestForCommand(input: CubeSandboxGuestCommandRequest): Record<string, unknown> {
    const path = input.command.match(/(\/tmp\/pi-cloud-envd-[0-9a-f-]{36}\.json)$/u)?.[1];
    const bytes = path === undefined ? undefined : this.guestFiles.get(path);
    if (bytes === undefined) throw new Error("guest request unavailable");
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
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

function operation(activationId: string): ToolSandboxOperationRequest {
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId,
    operationId: "10000000-0000-4000-8000-000000000020",
    turnContextSha256: STEP_CONTEXT_SHA256,
    attemptContextSha256: STEP_CONTEXT_SHA256,
    stepContextSequence: 1,
    stepContextSha256: STEP_CONTEXT_SHA256,
    toolName: "bash",
    operation: "bash.exec",
    command: "printf 'inside cube\\n'",
    cwd: "/workspace",
    timeoutMs: 1_000,
  };
}

describe("CubeSandbox Provider contract", () => {
  it("attests a real-template probe with full-public egress and private ingress", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = new CubeSandboxProvider({
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
    const provider = new CubeSandboxProvider({
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
    const provider = new CubeSandboxProvider({
      templateId: "pi-cloud-tool-v1",
      developmentTemplateIds: {
        starter: "tpl-starter00000000000000000",
        standard: "tpl-standard0000000000000000",
        performance: "tpl-performance00000000000000",
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
        kind: "snapshot",
        snapshot: encodeWorkspaceSnapshotBlob(createWorkspaceSnapshot([])),
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
    await expect(
      provider.previewHttp(handle, { port: 5_173, method: "GET", path: "/", headers: {} }),
    ).resolves.toMatchObject({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<html>private-preview-ok</html>"),
    });
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
    await provider.detachPersistent(handle);
    const replacement = new CubeSandboxProvider({
      templateId: "pi-cloud-tool-v2",
      developmentTemplateIds: {
        starter: "tpl-starter00000000000000000",
        standard: "tpl-standard0000000000000000",
        performance: "tpl-performance00000000000000",
      },
      // A deployment may advance its default template while a user-owned
      // machine keeps running its original, internally-consistent guest image.
      imageRevision: "next-development-release",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      persistentStateKey,
    });
    const adopted = await replacement.adoptPersistentCapsule(persisted.capsule);
    await expect(replacement.resume(adopted)).resolves.toMatchObject({
      activationId: ACTIVATION_ID,
      runtimeId: handle.runtimeId,
    });
    await replacement.destroy(adopted);
    await provider.close();
    await replacement.close();
  });

  it("preserves Session lease identity, assignment inventory and content checkpoints", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const workspaceVolumeGateway = fakeWorkspaceVolumeGateway();
    const provider = new CubeSandboxProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway,
    });
    const manager = new ToolBroker({
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
      attemptContextSha256: STEP_CONTEXT_SHA256,
      allowedTools: ["read", "write", "edit", "bash"],
      executionMode: "elastic",
      environment,
      workspaceSeed: { kind: "sample_java" },
    });
    expect(runtime.creates).toHaveLength(0);
    const response = await manager.execute(
      assignment.executionLease,
      operation(reserved.activationId),
    );
    expect(response).toMatchObject({ operation: "bash.exec", exitCode: 0 });
    expect(runtime.creates[0]?.timeoutSeconds).toBe(-1);
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.creates[0]?.metadata).not.toHaveProperty("host-mount");
    const activeAssignments = await manager.listAssignments(assignment.sandboxId);
    expect(activeAssignments).toEqual([
      expect.objectContaining({
        containerName: "cube-sandbox-1",
        supervisorId: assignment.supervisorId,
        executionLease: assignment.executionLease,
      }),
    ]);
    const captured = await manager.capture(
      reserved.activationId,
      assignment,
      "10000000-0000-4000-8000-000000000021",
    );
    expect(captured).toMatchObject({
      type: "tool_sandbox.captured",
      environment: {
        isolationBoundary: "microvm",
        runtime: "cubesandbox-kvm",
        readOnlyRootFilesystem: false,
      },
    });
    if (captured.type !== "tool_sandbox.captured") {
      throw new Error("CubeSandbox capture response was missing");
    }
    const checkpoint = parsePersistentVolumeReference(
      decodeWorkspaceSnapshotBlob(captured.workspace),
    );
    expect(checkpoint).toMatchObject({
      providerId: "cubesandbox",
      volumeRevision: "a".repeat(64),
      activationId: reserved.activationId,
      tenantId: assignment.tenantId,
      workspaceId: assignment.workspaceId,
      sourceSessionId: assignment.sessionId,
      fencingToken: parseExecutionLease(assignment.executionLease).fencingToken,
      imageRevision: environment.imageRevision,
      environmentSpecSha256: environment.specSha256,
      totalSizeBytes: 5,
      files: [
        {
          path: "result.txt",
          executable: false,
          sizeBytes: 5,
          sha256: createHash("sha256").update("cube\n").digest("hex"),
        },
      ],
    });
    expect(Buffer.from(captured.workspace.data, "base64").toString("utf8")).not.toContain("pcch_");
    const materialized = await manager.materializeFile({
      toolBrokerProtocolVersion: 1,
      type: "workspace.materialize_file",
      requestId: "10000000-0000-4000-8000-000000000023",
      tenantId: assignment.tenantId,
      workspaceId: assignment.workspaceId,
      snapshot: captured.workspace,
      path: "result.txt",
    });
    expect(materialized).toMatchObject({
      type: "workspace.file_materialized",
      path: "result.txt",
      content: Buffer.from("cube\n").toString("base64"),
    });
    const upgradedBroker = new ToolBroker({
      provider: new CubeSandboxProvider({
        templateId: "pi-cloud-tool-v2",
        imageRevision: "next-deployment",
        webProxy: WEB_PROXY,
        runtimeClient: new FakeCubeRuntimeClient(),
        workspaceVolumeGateway: fakeWorkspaceVolumeGateway(),
      }),
      imageRevision: "next-deployment",
    });
    await expect(
      upgradedBroker.materializeFile({
        toolBrokerProtocolVersion: 1,
        type: "workspace.materialize_file",
        requestId: "10000000-0000-4000-8000-000000000024",
        tenantId: assignment.tenantId,
        workspaceId: assignment.workspaceId,
        snapshot: captured.workspace,
        path: "result.txt",
      }),
    ).resolves.toMatchObject({
      type: "workspace.file_materialized",
      path: "result.txt",
      content: Buffer.from("cube\n").toString("base64"),
    });
    await upgradedBroker.close();
    expect(workspaceVolumeGateway.materialize).toHaveBeenCalledWith(
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
      workspaceRevision: "a".repeat(64),
    });
    expect(released.retained).toBe(true);
    expect(runtime.destroyed).toEqual([]);
    expect(manager.warmCount).toBe(1);
    expect(runtime.instances.get("cube-sandbox-1")?.state).toBe("running");
    await expect(manager.terminateAndConfirmAbsent(activeAssignments[0]!)).rejects.toMatchObject({
      code: "cubesandbox_assignment_identity_mismatch",
    });
    expect(runtime.destroyed).toEqual([]);

    const idleAssignment: ToolSandboxAssignment = {
      ...assignment,
      runId: "command-cube-test-idle",
      turnId: "turn-cube-test-idle",
      executionLease: createExecutionLease(
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
      attemptContextSha256: STEP_CONTEXT_SHA256,
      allowedTools: ["read", "write", "edit", "bash"],
      executionMode: "elastic",
      environment,
      workspaceSeed: { kind: "sample_java" },
      workspaceRevision: "a".repeat(64),
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
        workspaceRevision: "a".repeat(64),
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
      executionLease: createExecutionLease(
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
      attemptContextSha256: STEP_CONTEXT_SHA256,
      allowedTools: ["read", "write", "edit", "bash"],
      executionMode: "elastic",
      environment,
      workspaceSeed: { kind: "sample_java" },
      workspaceRevision: "a".repeat(64),
    });
    expect(next.activationId).toBe(reserved.activationId);
    expect(next.continuity).toBe("warm_reuse");
    await manager.execute(nextAssignment.executionLease, {
      ...operation(next.activationId),
      operationId: "10000000-0000-4000-8000-000000000033",
    });
    expect(runtime.creates).toHaveLength(1);
    expect(runtime.instances.get("cube-sandbox-1")?.state).toBe("running");
    expect(await manager.listAssignments(nextAssignment.sandboxId)).toEqual([
      expect.objectContaining({
        runId: nextAssignment.runId,
        executionLease: nextAssignment.executionLease,
      }),
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

  it("cold-restores a shared Workspace checkpoint into another Session with an independent fence", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const workspaceVolumeGateway = fakeWorkspaceVolumeGateway();
    const provider = new CubeSandboxProvider({
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
    const captured = await provider.snapshot(first, "10000000-0000-4000-8000-000000000040");
    expect(captured.type).toBe("tool_sandbox.captured");
    if (captured.type !== "tool_sandbox.captured") {
      throw new Error("CubeSandbox capture response was missing");
    }
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
      executionLease: createExecutionLease(
        "20000000-0000-4000-8000-000000000045",
        "20000000-0000-4000-8000-000000000044",
        parseExecutionLease(assignment.executionLease).fencingToken,
      ),
    };
    const restored = await provider.create({
      activationId: nextActivationId,
      assignment: nextAssignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      workspaceRestore: captured.workspace,
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
          key.startsWith("picloud.assignment.v3.") && value.includes(nextActivationId),
      ),
    ).toBe(true);
    await expect(provider.inspect(restored)).resolves.toMatchObject({ state: "running" });
    expect(workspaceVolumeGateway.prepare).toHaveBeenLastCalledWith(
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

  it("rotates Cube authority across a parent and child Session without comparing Session fences", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = new CubeSandboxProvider({
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
        executionLease: createExecutionLease(
          "20000000-0000-4000-8000-000000000050",
          parseExecutionLease(assignment.executionLease).attemptId,
          41,
        ),
      },
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    await provider.snapshot(parent, "10000000-0000-4000-8000-000000000051");

    const childAssignment: ToolSandboxAssignment = {
      ...assignment,
      sessionId: "session-cube-subagent",
      runId: "command-cube-subagent",
      turnId: "turn-cube-subagent",
      executionLease: createExecutionLease(
        "20000000-0000-4000-8000-000000000053",
        "20000000-0000-4000-8000-000000000052",
        1,
      ),
    };
    const child = await provider.rebind(parent, childAssignment);
    await expect(provider.exec(child, operation(ACTIVATION_ID))).resolves.toMatchObject({
      type: "tool_sandbox.operation_result",
      exitCode: 0,
    });
    await provider.snapshot(child, "10000000-0000-4000-8000-000000000054");

    const restored = await provider.rebind(child, {
      ...assignment,
      executionLease: createExecutionLease(
        "20000000-0000-4000-8000-000000000050",
        parseExecutionLease(assignment.executionLease).attemptId,
        41,
      ),
    });
    await expect(provider.inspect(restored)).resolves.toMatchObject({ state: "running" });
    expect(restored.assignment.sessionId).toBe(assignment.sessionId);
    await provider.destroy(restored);
    await provider.close();
  });

  it("forks an isolated persistent Volume while keeping the parent Cube usable", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const gateway = fakeWorkspaceVolumeGateway();
    const provider = new CubeSandboxProvider({
      templateId: "pi-cloud-tool-v1",
      imageRevision: "development",
      webProxy: WEB_PROXY,
      runtimeClient: runtime,
      workspaceVolumeGateway: gateway,
    });
    const parent = await provider.create({
      activationId: ACTIVATION_ID,
      assignment,
      environment,
      workspaceSeed: { kind: "sample_java" },
      policy: provider.defaultPolicy,
    });
    const targetWorkspaceId = "20000000-0000-4000-8000-000000000060";
    const forked = await provider.forkWorkspace(parent, {
      toolBrokerProtocolVersion: 1,
      type: "workspace.fork",
      requestId: "20000000-0000-4000-8000-000000000061",
      sourceActivationId: ACTIVATION_ID,
      sourceAssignment: assignment,
      target: {
        tenantId: assignment.tenantId,
        projectId: assignment.projectId,
        workspaceId: targetWorkspaceId,
        sessionId: "20000000-0000-4000-8000-000000000062",
      },
    });
    expect(forked).toMatchObject({
      sourceRevision: "a".repeat(64),
      targetRevision: "c".repeat(64),
    });
    expect(gateway.fork).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceWorkspaceId: assignment.workspaceId,
        targetWorkspaceId,
      }),
    );
    await expect(
      provider.exec(forked.sourceHandle, operation(ACTIVATION_ID)),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(runtime.creates).toHaveLength(1);
    await provider.destroy(forked.sourceHandle);
    await provider.close();
  });

  it("captures a lightweight persistent Volume reference for a Cube Workspace", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = new CubeSandboxProvider({
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
    const captured = await provider.snapshot(handle, "10000000-0000-4000-8000-000000000049");
    expect(captured.type).toBe("tool_sandbox.captured");
    if (captured.type !== "tool_sandbox.captured") {
      throw new Error("CubeSandbox capture response was missing");
    }
    expect(
      parsePersistentVolumeReference(decodeWorkspaceSnapshotBlob(captured.workspace)),
    ).toMatchObject({
      volumeRevision: "a".repeat(64),
      tenantId: assignment.tenantId,
      workspaceId: assignment.workspaceId,
      sourceSessionId: assignment.sessionId,
    });
    await provider.destroy(handle);
    await provider.close();
  });

  it("rejects a persistent Volume reference when tenant or fence is stale", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const provider = new CubeSandboxProvider({
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
    const captured = await provider.snapshot(handle, "10000000-0000-4000-8000-000000000046");
    expect(captured.type).toBe("tool_sandbox.captured");
    if (captured.type !== "tool_sandbox.captured") {
      throw new Error("CubeSandbox capture response was missing");
    }
    await expect(
      provider.create({
        activationId: "20000000-0000-4000-8000-000000000047",
        assignment: {
          ...assignment,
          tenantId: "another-tenant",
          executionLease: createExecutionLease(
            "20000000-0000-4000-8000-000000000060",
            parseExecutionLease(assignment.executionLease).attemptId,
            parseExecutionLease(assignment.executionLease).fencingToken + 1,
          ),
        },
        environment,
        workspaceSeed: { kind: "sample_java" },
        workspaceRestore: captured.workspace,
        policy: provider.defaultPolicy,
      }),
    ).rejects.toMatchObject({ code: "cubesandbox_volume_reference_invalid" });
    await expect(
      provider.create({
        activationId: "20000000-0000-4000-8000-000000000048",
        assignment,
        environment,
        workspaceSeed: { kind: "sample_java" },
        workspaceRestore: captured.workspace,
        policy: provider.defaultPolicy,
      }),
    ).rejects.toMatchObject({ code: "cubesandbox_volume_reference_invalid" });
    expect(runtime.creates).toHaveLength(1);
    await provider.destroy(handle);
    await provider.close();
  });

  it("reattaches the persistent Workspace Volume after the Tool image is upgraded", async () => {
    const originalProvider = new CubeSandboxProvider({
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
    const captured = await originalProvider.snapshot(
      originalHandle,
      "10000000-0000-4000-8000-000000000049",
    );
    if (captured.type !== "tool_sandbox.captured") {
      throw new Error("CubeSandbox capture response was missing");
    }
    await originalProvider.destroy(originalHandle);
    await originalProvider.close();

    const upgradedRuntime = new FakeCubeRuntimeClient("next-deployment");
    const upgradedDataMover = fakeWorkspaceVolumeGateway();
    const upgradedProvider = new CubeSandboxProvider({
      templateId: "pi-cloud-tool-v2",
      imageRevision: "next-deployment",
      webProxy: WEB_PROXY,
      runtimeClient: upgradedRuntime,
      workspaceVolumeGateway: upgradedDataMover,
    });
    const upgradedAssignment = {
      ...assignment,
      executionLease: createExecutionLease(
        "20000000-0000-4000-8000-000000000061",
        parseExecutionLease(assignment.executionLease).attemptId,
        parseExecutionLease(assignment.executionLease).fencingToken + 1,
      ),
    };
    const upgradedHandle = await upgradedProvider.create({
      activationId: "20000000-0000-4000-8000-000000000050",
      assignment: upgradedAssignment,
      environment: { ...environment, imageRevision: "next-deployment" },
      workspaceSeed: { kind: "sample_java" },
      workspaceRestore: captured.workspace,
      policy: upgradedProvider.defaultPolicy,
    });
    expect(upgradedDataMover.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: assignment.tenantId,
        workspaceId: assignment.workspaceId,
      }),
    );
    expect(upgradedRuntime.creates).toHaveLength(1);
    await upgradedProvider.destroy(upgradedHandle);
    await upgradedProvider.close();
  });

  it("destroys an uncertain VM without replaying a disconnected Tool command", async () => {
    const runtime = new FakeCubeRuntimeClient();
    const originalRunCommand = runtime.runCommand.bind(runtime);
    let operationRequests = 0;
    runtime.runCommand = async (instance, input) => {
      if (runtime.requestForCommand(input).mode === "operation") {
        operationRequests += 1;
        throw new Error("connection lost");
      }
      return originalRunCommand(instance, input);
    };
    const provider = new CubeSandboxProvider({
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
    await expect(provider.exec(handle, operation(ACTIVATION_ID))).rejects.toMatchObject({
      code: "cubesandbox_tool_result_unknown",
    });
    expect(operationRequests).toBe(1);
    expect(runtime.destroyed).toEqual(["cube-sandbox-1"]);
    await expect(provider.inspect(handle)).resolves.toMatchObject({ state: "absent" });
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
    const provider = new CubeSandboxProvider({
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
    expect(initialization).not.toHaveProperty("workspaceRestore");
    await provider.destroy(handle);
    await provider.close();
  });
});
