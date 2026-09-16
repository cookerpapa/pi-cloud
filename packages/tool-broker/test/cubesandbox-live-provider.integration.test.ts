import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  createExecutionReference,
  parseExecutionReference,
  type ToolSandboxAssignment,
  type ToolSandboxCreateRequest,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { connect } from "node:net";
import { release as hostKernelRelease } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  CubeSandboxProvider,
  HttpWorkspaceVolumeGateway,
  InMemoryWorkspaceRuntimeStateRepository,
  OfficialCubeSandboxRuntimeClient,
  ToolBroker,
  type OfficialCubeSandboxRuntimeClientOptions,
  type ToolBrokerOptions,
} from "../src/index.ts";
import { workspaceVolumeId } from "../src/workspace-volume-gateway-contract.ts";

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

const enabled = process.env.PI_CLOUD_CUBESANDBOX_TEST === "1";
const STEP_CONTEXT_SHA256 = "a".repeat(64);
const WARM_IDLE_PROOF_MS = 500;

type LiveConfiguration = Readonly<{
  templateId: string;
  imageRevision: string;
  publicHttpsUrl: string;
  runtime: OfficialCubeSandboxRuntimeClientOptions;
  webProxy: Readonly<{ host: string; port: number }>;
  forbiddenEndpoints: readonly Readonly<{ host: string; port: number }>[];
}>;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length < 1) {
    throw new Error(`${name} is required by the CubeSandbox live gate`);
  }
  return value;
}

function port(value: string | undefined, fallback: number): number {
  const candidate = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 65_535) {
    throw new Error("CubeSandbox live-gate port was invalid");
  }
  return candidate;
}

async function readPrivateKey(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o037) !== 0 || metadata.size > 4_096) {
      throw new Error("CubeSandbox live-gate API key must be a private regular file");
    }
    const key = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (key.length < 32 || key.length > 4_096 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error("CubeSandbox live-gate API key was invalid");
    }
    return key;
  } finally {
    await handle.close();
  }
}

function parseForbiddenEndpoints(
  value: string,
): readonly Readonly<{ host: string; port: number }>[] {
  const endpoints = value.split(",").map((item) => item.trim());
  if (endpoints.length < 2) {
    throw new Error(
      "PI_CLOUD_CUBESANDBOX_FORBIDDEN_ENDPOINTS must name at least two real platform endpoints",
    );
  }
  return endpoints.map((endpoint) => {
    const match = endpoint.match(/^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\d{1,5})$/);
    if (match === null) {
      throw new Error(`Forbidden endpoint ${endpoint} was invalid`);
    }
    return Object.freeze({ host: match[1]!, port: port(match[2], 1) });
  });
}

async function configuration(): Promise<LiveConfiguration> {
  const apiUrl = new URL(required("PI_CLOUD_CUBESANDBOX_API_URL"));
  if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
    throw new Error("PI_CLOUD_CUBESANDBOX_API_URL must use HTTP or HTTPS");
  }
  const publicHttpsUrl = new URL(
    process.env.PI_CLOUD_CUBESANDBOX_PUBLIC_HTTPS_URL ?? "https://example.com/",
  );
  if (
    publicHttpsUrl.protocol !== "https:" ||
    publicHttpsUrl.username !== "" ||
    publicHttpsUrl.password !== "" ||
    publicHttpsUrl.hash !== ""
  ) {
    throw new Error("PI_CLOUD_CUBESANDBOX_PUBLIC_HTTPS_URL must be a credential-free HTTPS URL");
  }
  const proxyScheme = process.env.PI_CLOUD_CUBESANDBOX_PROXY_SCHEME ?? "http";
  if (proxyScheme !== "http" && proxyScheme !== "https") {
    throw new Error("PI_CLOUD_CUBESANDBOX_PROXY_SCHEME was invalid");
  }
  const configured = parseForbiddenEndpoints(required("PI_CLOUD_CUBESANDBOX_FORBIDDEN_ENDPOINTS"));
  const apiEndpoint = Object.freeze({
    host: apiUrl.hostname,
    port: port(
      apiUrl.port === "" ? undefined : apiUrl.port,
      apiUrl.protocol === "https:" ? 443 : 80,
    ),
  });
  const egressProxyIp = process.env.PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254";
  const egressProxyPort = port(process.env.PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_PORT, 3_128);
  return {
    templateId: required("PI_CLOUD_CUBESANDBOX_TEMPLATE_ID"),
    imageRevision: required("PI_CLOUD_IMAGE_REVISION"),
    publicHttpsUrl: publicHttpsUrl.toString(),
    runtime: {
      apiUrl: apiUrl.toString(),
      apiKey: await readPrivateKey(required("PI_CLOUD_CUBESANDBOX_API_KEY_FILE")),
      proxyNodeIp: required("PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP"),
      proxyPort: port(
        process.env.PI_CLOUD_CUBESANDBOX_PROXY_PORT,
        proxyScheme === "https" ? 443 : 80,
      ),
      proxyScheme,
      sandboxDomain: process.env.PI_CLOUD_CUBESANDBOX_DOMAIN ?? "cube.app",
      egressProxyIp,
      requestTimeoutMs: 30_000,
    },
    webProxy: { host: egressProxyIp, port: egressProxyPort },
    forbiddenEndpoints: [apiEndpoint, ...configured],
  };
}

function assignment(testRun: string, index: number): ToolSandboxAssignment {
  return {
    tenantId: `cube-live-${testRun}-tenant-${String(index)}`,
    projectId: `cube-live-${testRun}-project-${String(index)}`,
    workspaceId: `cube-live-${testRun}-workspace-${String(index)}`,
    supervisorId: `cube-live-${testRun}-supervisor`,
    bootId: randomUUID(),
    sandboxId: randomUUID(),
    runId: `cube-live-${testRun}-command-${String(index)}`,
    sessionId: `cube-live-${testRun}-session-${String(index)}`,
    turnId: `cube-live-${testRun}-turn-${String(index)}`,
    executionReference: createExecutionReference(randomUUID(), randomUUID(), index),
  };
}

function createRequest(
  assigned: ToolSandboxAssignment,
  imageRevision: string,
): ToolSandboxCreateRequest {
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.create",
    requestId: randomUUID(),
    sandboxProfileKey: "standard",
    toolRoot: "/workspace",
    assignment: assigned,
    turnContextSha256: STEP_CONTEXT_SHA256,
    attemptContextSha256: STEP_CONTEXT_SHA256,
    allowedTools: ["read", "write", "edit", "bash"],
    executionMode: "elastic",
    environment: {
      environmentVersionId: randomUUID(),
      versionNumber: 1,
      profileKey: "pi-cloud-fullstack",
      profileVersion: "1",
      imageRevision,
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    },
    workspaceSeed: { kind: "sample_java" },
  };
}

function operation(
  activationId: string,
  command: string,
  timeoutMs = 10_000,
): ToolSandboxOperationRequest {
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId,
    operationId: randomUUID(),
    turnContextSha256: STEP_CONTEXT_SHA256,
    attemptContextSha256: STEP_CONTEXT_SHA256,
    stepContextSequence: 1,
    stepContextSha256: STEP_CONTEXT_SHA256,
    toolName: "bash",
    operation: "bash.exec",
    command,
    cwd: "/workspace",
    timeoutMs,
  };
}

function output(response: ToolSandboxOperationResponse): string {
  if (
    response.type !== "tool_sandbox.operation_result" ||
    response.operation !== "bash.exec" ||
    response.exitCode !== 0
  ) {
    const diagnostic =
      response.type === "tool_sandbox.operation_result" && response.operation === "bash.exec"
        ? {
            type: response.type,
            operation: response.operation,
            exitCode: response.exitCode,
            output: Buffer.concat(
              response.outputChunks.map((chunk) => Buffer.from(chunk.data, "base64")),
            )
              .toString("utf8")
              .slice(0, 2_048),
          }
        : response.type === "tool_sandbox.operation_result"
          ? {
              type: response.type,
              operation: response.operation,
            }
          : {
              type: response.type,
              code: response.code,
              message: response.message,
              retryable: response.retryable,
            };
    throw new Error(`CubeSandbox live command did not succeed: ${JSON.stringify(diagnostic)}`);
  }
  const bytes = Buffer.concat(
    response.outputChunks.map((chunk) => Buffer.from(chunk.data, "base64")),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== response.outputSha256) {
    throw new Error("CubeSandbox live command output digest did not match");
  }
  return bytes.toString("utf8");
}

async function assertReachableFromTrustedHost(
  endpoint: Readonly<{ host: string; port: number }>,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = connect(endpoint.port, endpoint.host);
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(
        new Error(
          `Trusted host could not reach forbidden endpoint ${endpoint.host}:${String(endpoint.port)}`,
        ),
      );
    }, 3_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

function denyProbeCommand(endpoints: readonly Readonly<{ host: string; port: number }>[]): string {
  const encoded = Buffer.from(JSON.stringify(endpoints), "utf8").toString("base64");
  const program =
    `const net=require('node:net');` +
    `const targets=JSON.parse(Buffer.from('${encoded}','base64'));` +
    `const probe=({host,port})=>new Promise(r=>{` +
    `const s=net.createConnection({host,port});` +
    `const done=v=>{s.destroy();r(v)};` +
    `s.setTimeout(2000,()=>done(false));` +
    `s.once('connect',()=>done(true));` +
    `s.once('error',()=>done(false));` +
    `});` +
    `Promise.all(targets.map(probe)).then(results=>{` +
    `const open=targets.filter((_,i)=>results[i]);` +
    `if(open.length){console.error(JSON.stringify(open));process.exit(91)}` +
    `process.stdout.write('all-forbidden-endpoints-blocked')` +
    `});`;
  return `node -e ${JSON.stringify(program)}`;
}

function publicHttpsProbeCommand(url: string): string {
  // Exercise the guest's configured HTTP(S) proxy, not a different host NAT path.
  const quoted = "'" + url.replaceAll("'", "'\\''") + "'";
  return `curl --fail --silent --show-error --location --max-time 10 --output /dev/null ${quoted} && printf public-egress-ok`;
}

async function waitForNoManagedInstances(
  config: LiveConfiguration,
  assignments: readonly ToolSandboxAssignment[],
): Promise<void> {
  const client = new OfficialCubeSandboxRuntimeClient(config.runtime);
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const remaining = (await client.list()).filter((instance) =>
        assignments.some(
          (owned) =>
            instance.metadata["picloud.tenant_id"] === owned.tenantId &&
            instance.metadata["picloud.workspace_id"] === owned.workspaceId,
        ),
      );
      if (remaining.length === 0) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error("CubeSandbox live gate found orphaned PiCloud microVMs");
  } finally {
    await client.close();
  }
}

describe.skipIf(!enabled)("CubeSandbox KVM Provider live security gate", () => {
  it("does not claim cleanup when deletion of a real owned VM is unconfirmed", async () => {
    const config = await configuration();
    const assigned = assignment(randomUUID(), 1);
    const gatewayOptions = {
      baseUrl: required("PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL"),
      serviceToken: await readPrivateKey(required("PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE")),
    };
    const runtime = new OfficialCubeSandboxRuntimeClient(config.runtime);
    const repository = new InMemoryWorkspaceRuntimeStateRepository();
    const setState = vi.spyOn(repository, "setWorkspaceRuntimeState");
    const provider = new CubeSandboxProvider({
      templateId: config.templateId,
      developmentTemplateIds: {
        starter: config.templateId,
        standard: config.templateId,
        performance: config.templateId,
      },
      imageRevision: config.imageRevision,
      webProxy: config.webProxy,
      runtimeClient: runtime,
      workspaceVolumeGateway: new HttpWorkspaceVolumeGateway(gatewayOptions),
    });
    const broker = testBroker({
      provider,
      stateRepository: repository,
      imageRevision: config.imageRevision,
    });
    const errors: unknown[] = [];
    let closeAttempted = false;
    try {
      const binding = await broker.create(createRequest(assigned, config.imageRevision));
      expect(
        output(
          await broker.execute(
            binding.executionReference,
            operation(binding.activationId, "printf real-vm"),
          ),
        ),
      ).toBe("real-vm");
      const failure = new Error("Owned test VM DELETE did not reach Cube");
      vi.spyOn(runtime, "destroy").mockRejectedValueOnce(failure);
      setState.mockClear();
      closeAttempted = true;
      await expect(broker.close()).rejects.toMatchObject({ errors: [failure] });
      expect(setState.mock.calls.some(([, state]) => state === "released")).toBe(false);
      const inventory = new OfficialCubeSandboxRuntimeClient(config.runtime);
      try {
        const surviving = (await inventory.list()).filter(
          (instance) =>
            instance.metadata["picloud.tenant_id"] === assigned.tenantId &&
            instance.metadata["picloud.workspace_id"] === assigned.workspaceId,
        );
        expect(surviving).toHaveLength(1);
      } finally {
        await inventory.close();
      }
    } catch (error) {
      errors.push(error);
    } finally {
      if (!closeAttempted) await broker.close().catch((error) => errors.push(error));
      const cleanup = new OfficialCubeSandboxRuntimeClient(config.runtime);
      const gateway = new HttpWorkspaceVolumeGateway(gatewayOptions);
      try {
        for (const instance of await cleanup.list()) {
          if (
            instance.metadata["picloud.tenant_id"] === assigned.tenantId &&
            instance.metadata["picloud.workspace_id"] === assigned.workspaceId
          )
            await cleanup.destroy(instance.sandboxId);
        }
        await waitForNoManagedInstances(config, [assigned]);
        const identity = {
          tenantId: assigned.tenantId,
          workspaceId: assigned.workspaceId,
          volumeId: workspaceVolumeId(assigned),
        };
        await gateway.prepareDelete(identity);
        await cleanup.deleteVolume(identity.volumeId);
        await gateway.finalizeDelete(identity);
      } catch (error) {
        errors.push(error);
      } finally {
        for (const close of [() => cleanup.close(), () => gateway.close()])
          await close().catch((error) => errors.push(error));
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "Real Cube deletion-failure gate failed", {
        cause: errors[0],
      });
    process.stdout.write(
      JSON.stringify({
        cubeDeletionFailureGate: {
          closeRejected: true,
          nativeSurvivorConfirmed: true,
          releasedNotReported: true,
          cleanupConfirmed: true,
          scope: "real Cube; controlled DELETE failure; in-memory ownership fixture",
        },
      }) + "\n",
    );
  }, 120_000);

  it(
    "proves two-tenant isolation, full-public egress, private denial, cancellation and cleanup",
    async () => {
      const config = await configuration();
      await Promise.all(
        config.forbiddenEndpoints.map((endpoint) => assertReachableFromTrustedHost(endpoint)),
      );

      const testRun = randomUUID();
      const firstAssignment = assignment(testRun, 1);
      const secondAssignment = assignment(testRun, 2);
      const terminalAssignment = assignment(testRun, 3);
      const volumeGatewayOptions = {
        baseUrl: required("PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL"),
        serviceToken: await readPrivateKey(
          required("PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE"),
        ),
      };
      const provider = new CubeSandboxProvider({
        templateId: config.templateId,
        developmentTemplateIds: {
          starter: config.templateId,
          standard: config.templateId,
          performance: config.templateId,
        },
        imageRevision: config.imageRevision,
        webProxy: config.webProxy,
        runtime: config.runtime,
        workspaceVolumeGateway: new HttpWorkspaceVolumeGateway(volumeGatewayOptions),
      });
      const manager = testBroker({
        provider,
        imageRevision: config.imageRevision,
        warmTtlMs: 60_000,
      });
      let first: Awaited<ReturnType<ToolBroker["create"]>> | undefined;
      let second: Awaited<ReturnType<ToolBroker["create"]>> | undefined;
      let activeFirstAssignment = firstAssignment;
      let activeSecondAssignment = secondAssignment;
      const startedAt = performance.now();
      let firstToolMs = 0;
      let secondToolMs = 0;
      const failures: unknown[] = [];
      try {
        await provider.checkHealth();
        const terminalEnvironment = createRequest(
          terminalAssignment,
          config.imageRevision,
        ).environment;
        const terminal = await manager.openTerminal({
          tenantId: terminalAssignment.tenantId,
          userId: `cube-live-${testRun}-user-3`,
          projectId: terminalAssignment.projectId,
          workspaceId: terminalAssignment.workspaceId,
          sessionId: terminalAssignment.sessionId,
          environment: terminalEnvironment,
          workspaceSeed: { kind: "sample_java" },
          size: { rows: 24, cols: 100 },
        });
        try {
          const terminalOutput = (async (): Promise<string> => {
            const chunks: Buffer[] = [];
            for await (const chunk of terminal.output) {
              chunks.push(Buffer.from(chunk));
              if (chunks.reduce((sum, value) => sum + value.byteLength, 0) > 256 * 1_024) {
                throw new Error("CubeSandbox live PTY exceeded its output bound");
              }
            }
            return Buffer.concat(chunks).toString("utf8");
          })();
          await terminal.sendInput(
            Buffer.from("printf '__picloud_terminal_ok__\\n'; exit\n", "utf8"),
          );
          await expect(
            Promise.race([
              terminalOutput,
              new Promise<string>((_resolve, reject) =>
                setTimeout(
                  () => reject(new Error("CubeSandbox live PTY did not exit")),
                  15_000,
                ).unref(),
              ),
            ]),
          ).resolves.toContain("__picloud_terminal_ok__");
        } finally {
          await terminal.close();
        }
        const firstRequest = createRequest(firstAssignment, config.imageRevision);
        first = await manager.create(firstRequest);
        const secondRequest = createRequest(secondAssignment, config.imageRevision);
        second = await manager.create(secondRequest);

        const firstCanary = `tenant-a-${randomUUID()}`;
        const secondCanary = `tenant-b-${randomUUID()}`;
        const firstStartedAt = performance.now();
        expect(
          output(
            await manager.execute(
              first.executionReference,
              operation(first.activationId, `printf '%s' '${firstCanary}' > tenant-canary`),
            ),
          ),
        ).toBe("");
        firstToolMs = Math.round(performance.now() - firstStartedAt);

        const secondStartedAt = performance.now();
        expect(
          output(
            await manager.execute(
              second.executionReference,
              operation(second.activationId, `printf '%s' '${secondCanary}' > tenant-canary`),
            ),
          ),
        ).toBe("");
        secondToolMs = Math.round(performance.now() - secondStartedAt);

        expect(
          output(
            await manager.execute(
              first.executionReference,
              operation(first.activationId, "cat tenant-canary"),
            ),
          ),
        ).toBe(firstCanary);
        expect(
          output(
            await manager.execute(
              first.executionReference,
              operation(
                first.activationId,
                "node -e \"const fs=require('node:fs');fs.mkdirSync('large',{recursive:true});for(let i=0;i<600;i++)fs.writeFileSync('large/file-'+i,String(i))\"",
              ),
            ),
          ),
        ).toBe("");
        expect(
          output(
            await manager.execute(
              second.executionReference,
              operation(second.activationId, "cat tenant-canary"),
            ),
          ),
        ).toBe(secondCanary);

        const kernel = output(
          await manager.execute(
            first.executionReference,
            operation(first.activationId, "uname -r"),
          ),
        ).trim();
        expect(kernel).not.toBe(hostKernelRelease());
        await expect(manager.inspect(first.activationId, firstAssignment)).resolves.toMatchObject({
          state: "running",
          effectiveIsolation: {
            isolationBoundary: "microvm",
            runtime: "cubesandbox-kvm",
            user: "1000:1000",
            privileged: false,
            hasDockerSocket: false,
            networkMode: "public_web_proxy_private_denied",
            droppedCapabilities: ["ALL"],
            securityOptions: ["no-new-privileges"],
          },
        });

        expect(
          output(
            await manager.execute(
              first.executionReference,
              operation(
                first.activationId,
                "test ! -S /var/run/docker.sock; " +
                  "test ! -f /var/run/secrets/kubernetes.io/serviceaccount/token; " +
                  "if env | grep -Ei '(OPENAI|DEEPSEEK|DATABASE_URL|POSTGRES|KUBECONFIG|CUBE_API_KEY)'; then exit 92; fi",
              ),
            ),
          ),
        ).toBe("");
        expect(
          output(
            await manager.execute(
              first.executionReference,
              operation(
                first.activationId,
                denyProbeCommand([
                  ...config.forbiddenEndpoints,
                  { host: "169.254.169.254", port: 80 },
                ]),
                15_000,
              ),
            ),
          ),
        ).toBe("all-forbidden-endpoints-blocked");
        expect(
          output(
            await manager.execute(
              first.executionReference,
              operation(first.activationId, publicHttpsProbeCommand(config.publicHttpsUrl), 15_000),
            ),
          ),
        ).toBe("public-egress-ok");

        await expect(
          manager.listWorkspaceDirectory({
            toolBrokerProtocolVersion: 1,
            type: "workspace.list_directory",
            requestId: randomUUID(),
            tenantId: firstAssignment.tenantId,
            workspaceId: firstAssignment.workspaceId,
            sessionId: firstAssignment.sessionId,
            rootPath: "",
            path: "",
          }),
        ).resolves.toMatchObject({
          entries: expect.arrayContaining([
            expect.objectContaining({
              path: "tenant-canary",
              sizeBytes: Buffer.byteLength(firstCanary),
            }),
          ]),
        });
        await expect(
          manager.release({
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.release",
            requestId: randomUUID(),
            activationId: first.activationId,
            assignment: firstAssignment,
            disposition: "destroy",
          }),
        ).resolves.toMatchObject({ retained: false });
        const restoredFirstAssignment: ToolSandboxAssignment = {
          ...firstAssignment,
          supervisorId: `cube-live-${testRun}-supervisor-restored`,
          bootId: randomUUID(),
          sandboxId: randomUUID(),
          runId: `cube-live-${testRun}-command-restored`,
          turnId: `cube-live-${testRun}-turn-restored`,
          executionReference: createExecutionReference(
            randomUUID(),
            randomUUID(),
            parseExecutionReference(firstAssignment.executionReference).fencingToken + 10,
          ),
        };
        activeFirstAssignment = restoredFirstAssignment;
        first = await manager.create({
          ...firstRequest,
          requestId: randomUUID(),
          assignment: restoredFirstAssignment,
          workspaceSeed: { kind: "sample_java" },
        });
        expect(
          output(
            await manager.execute(
              first.executionReference,
              operation(first.activationId, "cat tenant-canary"),
            ),
          ),
        ).toBe(firstCanary);

        const secondRuntimeBefore = (await provider.listAssignments(secondAssignment.sandboxId))[0];
        expect(secondRuntimeBefore).toBeDefined();
        const backgroundProgram = [
          "const fs=require('node:fs')",
          "const http=require('node:http')",
          "fs.writeFileSync('background-state','started\\n')",
          "setInterval(()=>fs.appendFileSync('background-state','tick\\n'),200)",
          "http.createServer((_request,response)=>response.end('preview-alive')).listen(43123,'0.0.0.0')",
        ].join(";");
        expect(
          output(
            await manager.execute(
              second.executionReference,
              operation(
                second.activationId,
                `nohup node -e ${JSON.stringify(backgroundProgram)} >/tmp/picloud-preview.log 2>&1 & echo $! > background.pid; sleep 1; kill -0 "$(cat background.pid)"; node -e "fetch('http://127.0.0.1:43123').then(async r=>process.stdout.write(await r.text()))"`,
                15_000,
              ),
            ),
          ),
        ).toBe("preview-alive");
        const backgroundPid = output(
          await manager.execute(
            second.executionReference,
            operation(second.activationId, "cat background.pid"),
          ),
        ).trim();
        expect(backgroundPid).toMatch(/^[1-9][0-9]*$/);
        await expect(
          manager.release({
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.release",
            requestId: randomUUID(),
            activationId: second.activationId,
            assignment: secondAssignment,
            disposition: "keep_warm",
          }),
        ).resolves.toMatchObject({ retained: true });
        await expect(
          manager.execute(
            second.executionReference,
            operation(second.activationId, "printf stale-authority-must-not-run"),
          ),
        ).rejects.toMatchObject({ code: "stale_session_lease" });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, WARM_IDLE_PROOF_MS));
        await manager.reapWarm();
        expect(manager.warmCount).toBe(1);
        const reboundAssignment: ToolSandboxAssignment = {
          ...secondAssignment,
          supervisorId: `cube-live-${testRun}-supervisor-rebound`,
          bootId: randomUUID(),
          sandboxId: randomUUID(),
          runId: `cube-live-${testRun}-command-rebound`,
          turnId: `cube-live-${testRun}-turn-rebound`,
          executionReference: createExecutionReference(
            randomUUID(),
            randomUUID(),
            parseExecutionReference(secondAssignment.executionReference).fencingToken + 10,
          ),
        };
        activeSecondAssignment = reboundAssignment;
        second = await manager.create({
          ...secondRequest,
          requestId: randomUUID(),
          assignment: reboundAssignment,
        });
        expect(
          output(
            await manager.execute(
              second.executionReference,
              operation(
                second.activationId,
                `test "$(cat background.pid)" = "${backgroundPid}"; kill -0 "${backgroundPid}"; test "$(grep -c tick background-state)" -gt 0; node -e "fetch('http://127.0.0.1:43123').then(async r=>process.stdout.write(await r.text()))"`,
                15_000,
              ),
            ),
          ),
        ).toBe("preview-alive");
        expect(
          output(
            await manager.execute(
              second.executionReference,
              operation(second.activationId, "cat tenant-canary"),
            ),
          ),
        ).toBe(secondCanary);
        // Physical creation identity remains stable; only the Broker binding changes owner.
        const secondRuntimeAfter = (await provider.listAssignments(secondAssignment.sandboxId))[0];
        expect(secondRuntimeAfter?.containerId).toBe(secondRuntimeBefore?.containerId);
        expect(secondRuntimeAfter?.containerName).toBe(secondRuntimeBefore?.containerName);
        expect(second.executionReference).toBe(reboundAssignment.executionReference);

        const controller = new AbortController();
        const cancelled = manager.execute(
          first.executionReference,
          operation(first.activationId, "touch cancellation-started; sleep 120", 125_000),
          controller.signal,
        );
        void cancelled.catch(() => {});
        try {
          const deadline = Date.now() + 15_000;
          for (;;) {
            const directory = await manager.listWorkspaceDirectory({
              toolBrokerProtocolVersion: 1,
              type: "workspace.list_directory",
              requestId: randomUUID(),
              tenantId: firstAssignment.tenantId,
              workspaceId: firstAssignment.workspaceId,
              sessionId: firstAssignment.sessionId,
              rootPath: "",
              path: "",
            });
            if (directory.entries.some((entry) => entry.path === "cancellation-started")) break;
            if (Date.now() > deadline) throw new Error("Cancellation probe never started in Cube");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        } finally {
          controller.abort();
        }
        await expect(cancelled).rejects.toMatchObject({ code: "cubesandbox_tool_result_unknown" });
        await expect(
          manager.inspect(first.activationId, activeFirstAssignment),
        ).rejects.toMatchObject({ code: "cubesandbox_tool_result_unknown" });
        await manager.stop(first.activationId, activeFirstAssignment);
        expect(manager.ownsToolBinding(first.activationId)).toBe(false);
        await expect(
          manager.inspect(first.activationId, activeFirstAssignment),
        ).rejects.toMatchObject({ code: "tool_binding_identity_mismatch" });
      } catch (error) {
        failures.push(error);
      } finally {
        if (first !== undefined) {
          await manager.stop(first.activationId, activeFirstAssignment).catch((error) => {
            failures.push(error);
          });
        }
        if (second !== undefined) {
          await manager.stop(second.activationId, activeSecondAssignment).catch((error) => {
            failures.push(error);
          });
        }
        await manager.close().catch((error) => {
          failures.push(error);
        });
        const cleanupClient = new OfficialCubeSandboxRuntimeClient(config.runtime);
        const cleanupGateway = new HttpWorkspaceVolumeGateway(volumeGatewayOptions);
        try {
          await waitForNoManagedInstances(config, [
            firstAssignment,
            secondAssignment,
            terminalAssignment,
          ]);
          for (const owned of [firstAssignment, secondAssignment, terminalAssignment]) {
            const volumeId = workspaceVolumeId(owned);
            const identity = { tenantId: owned.tenantId, workspaceId: owned.workspaceId, volumeId };
            try {
              await cleanupGateway.prepareDelete(identity);
              await cleanupClient.deleteVolume(volumeId);
              await cleanupGateway.finalizeDelete(identity);
            } catch (error) {
              failures.push(error);
            }
          }
        } catch (error) {
          failures.push(error);
        } finally {
          for (const close of [() => cleanupClient.close(), () => cleanupGateway.close()]) {
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "Cube live acceptance or cleanup failed", {
          cause: failures[0],
        });
      process.stdout.write(
        `${JSON.stringify({
          cubeSandboxLiveGate: {
            upstream: "TencentCloud/CubeSandbox@v0.6.0",
            isolationValidated: true,
            tenantCount: 2,
            firstToolMs,
            secondToolMs,
            totalMs: Math.round(performance.now() - startedAt),
            guestKernelDistinctFromHost: true,
            forbiddenEndpointCount: config.forbiddenEndpoints.length,
            publicInternetReachable: true,
            privateAndPlatformEgressDenied: true,
            fencedPtyValidated: true,
            warmProcessSurvivedRunBoundaryWithinTtl: true,
            staleToolAuthorityRejected: true,
            explicitStopRetiredCancelledToolBinding: true,
            dispatchedCancellationRemainsUnknown: true,
            persistentVolumesRemoved: 3,
            orphanCount: 0,
          },
        })}\n`,
      );
    },
    10 * 60_000,
  );
});
