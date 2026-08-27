import {
  isExpectedDefaultToolchain,
  parseEnvironmentToolchainReport,
  createExecutionLease,
  parseExecutionLease,
  parseToolBrokerResponse,
  parseToolSandboxOperationResponse,
  parseToolWorkerOutput,
  type EnvironmentValidationReport,
  type EnvironmentToolchainReport,
  type ToolBrokerMaterializeFileRequest,
  type ToolBrokerMaterializeFileResponse,
  type ToolBrokerWorkspaceForkRequest,
  type SupervisorRuntimeAssignment,
  type ToolSandboxAssignment,
  type ToolSandboxCaptureResponse,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type ToolWorkerInput,
  type ToolWebProxyBootstrap,
  type DevelopmentEnvironmentProfileKey,
} from "@pi-cloud/protocol";
import { createHash, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import {
  createPersistentVolumeReference,
  decodeWorkspaceSnapshotBlob,
  encodeWorkspaceSnapshotBlob,
  parsePersistentVolumeReference,
} from "@pi-cloud/workspace-runtime";
import {
  CubeRuntimeClientError,
  OfficialCubeSandboxRuntimeClient,
  type CubeSandboxInstance,
  type CubeSandboxRuntimeClient,
  type OfficialCubeSandboxRuntimeClientOptions,
} from "./cubesandbox-runtime-client.ts";
import { workspaceVolumeId, type WorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
import {
  ToolBrokerError,
  type SandboxCreateSpec,
  type SandboxDirectoryListing,
  type SandboxEffectiveIsolation,
  type SandboxHandle,
  type SandboxHttpServiceDiscovery,
  type SandboxInspection,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxReadFileInput,
  type SandboxTerminalSession,
  type SandboxTerminalSize,
  type SandboxWriteFileInput,
} from "./sandbox-provider.ts";
import { CubePersistentCapsuleCodec } from "./cube-persistent-capsule.ts";

const READY_TIMEOUT_MS = 60_000;
const TOOL_RESPONSE_LIMIT_BYTES = 8 * 1_024 * 1_024;
const PREVIEW_RESPONSE_LIMIT_BYTES = 24 * 1_024 * 1_024;
const INTERNAL_STEP_CONTEXT_SHA256 = "0".repeat(64);
const HTTP_SERVICE_DISCOVERY_SCRIPT = Buffer.from(
  String.raw`
const fs = require("node:fs");
const http = require("node:http");
const reserved = new Set([49983, 49984, 50005]);
const ports = new Set();
for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  let table = "";
  try { table = fs.readFileSync(path, "utf8"); } catch {}
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== "0A") continue;
    const encoded = fields[1]?.split(":").at(-1);
    const port = encoded === undefined ? NaN : Number.parseInt(encoded, 16);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535 && !reserved.has(port)) ports.add(port);
  }
}
const listeningPorts = [...ports].sort((a, b) => a - b).slice(0, 128);
const probe = (port) => new Promise((resolve) => {
  let settled = false;
  const finish = (reachable) => { if (!settled) { settled = true; resolve({ port, reachable }); } };
  const request = http.request({ hostname: "127.0.0.1", port, method: "HEAD", path: "/", headers: { host: "127.0.0.1:" + port, connection: "close" } }, (response) => { response.resume(); finish(true); });
  request.setTimeout(750, () => { request.destroy(); finish(false); });
  request.once("error", () => finish(false));
  request.end();
});
Promise.all(listeningPorts.slice(0, 32).map(probe)).then((probes) => {
  process.stdout.write(JSON.stringify({ listeningPorts, httpServices: probes.filter((item) => item.reachable).map((item) => ({ port: item.port, protocol: "http" })) }));
});
`,
  "utf8",
).toString("base64");

export const CUBESANDBOX_PROVIDER_ID = "cubesandbox";
export const CUBESANDBOX_RUNTIME_NAME = "cubesandbox-kvm";

export const CUBESANDBOX_TOOL_POLICY: SandboxPolicy = Object.freeze({
  policyVersion: 1,
  network: Object.freeze({ mode: "public_web_proxy_private_denied" }),
  resources: Object.freeze({
    cpuNano: 1_000_000_000,
    memoryBytes: 768 * 1_024 * 1_024,
    pids: 128,
    openFiles: 1_024,
    // Cube v0.6 templates expose a bounded disposable CoW guest rootfs
    // instead of separate Kubernetes emptyDir volumes.
    temporaryBytes: 1 * 1_024 * 1_024 * 1_024,
    workspaceBytes: 1 * 1_024 * 1_024 * 1_024,
    maximumOutputBytes: 1 * 1_024 * 1_024,
    maximumCommandTimeoutMs: 300_000,
    turnWallClockTimeoutMs: 900_000,
  }),
  user: "1000:1000",
  readOnlyRootFilesystem: false,
  privileged: false,
  dropAllCapabilities: true,
  noNewPrivileges: true,
  allowHostMounts: false,
  allowDockerSocket: false,
});

const METADATA = Object.freeze({
  managed: "picloud.managed",
  provider: "picloud.provider",
  workload: "picloud.workload",
  activationId: "picloud.activation_id",
  tenantId: "picloud.tenant_id",
  projectId: "picloud.project_id",
  workspaceId: "picloud.workspace_id",
  supervisorId: "picloud.supervisor_id",
  bootId: "picloud.boot_id",
  sandboxId: "picloud.sandbox_id",
  commandId: "picloud.command_id",
  sessionId: "picloud.session_id",
  turnId: "picloud.turn_id",
  leaseId: "picloud.lease_id",
  attemptId: "picloud.attempt_id",
  fencingToken: "picloud.fencing_token",
  bindingSha256: "picloud.binding_sha256",
  imageRevision: "picloud.image_revision",
} as const);

const ASSIGNMENT_METADATA_PREFIX = "picloud.assignment.v3.";

function fencingToken(assignment: ToolSandboxAssignment): number {
  return parseExecutionLease(assignment.executionLease).fencingToken;
}

type CubeAssignmentMetadata = Readonly<{
  activationId: string;
  tenantId: string;
  projectId: string;
  workspaceId: string;
  supervisorId: string;
  bootId: string;
  sandboxId: string;
  commandId: string;
  sessionId: string;
  turnId: string;
  leaseId: string;
  attemptId: string;
  fencingToken: number;
  bindingSha256: string;
  imageRevision: string;
}>;

type CubeRuntimeEvidence = Readonly<{
  controlProtocolVersion: 2;
  imageRevision: string;
  kernelRelease: string;
  cpuCount: number;
  memoryBytes: number;
  uid: number;
  gid: number;
  hypervisorFlag: boolean;
  noNewPrivileges: boolean;
  effectiveCapabilities: string;
  readOnlyRootFilesystem: boolean;
  supervisorUid: number;
  supervisorGid: number;
  ipAddress: string;
}>;

type CubeActivation = {
  instance: CubeSandboxInstance;
  handle: SandboxHandle;
  evidence: CubeRuntimeEvidence;
  toolchain: EnvironmentToolchainReport;
  seenOperationIds: Set<string>;
  seenCaptureIds: Set<string>;
  bindingSha256: string;
  authorityEpoch: number;
  state: "running" | "quiesced" | "idle" | "paused";
  volumeId: string;
  lifetime: "agent_turn" | "development_environment";
  toolRoot: string;
};

export type CubeSandboxProviderOptions = Readonly<{
  templateId: string;
  developmentTemplateIds?: Readonly<Record<DevelopmentEnvironmentProfileKey, string>>;
  imageRevision: string;
  runtimeClient?: CubeSandboxRuntimeClient;
  runtime?: OfficialCubeSandboxRuntimeClientOptions;
  readyTimeoutMs?: number;
  webProxy: ToolWebProxyBootstrap;
  workspaceVolumeGateway: WorkspaceVolumeGateway;
  persistentStateKey?: Uint8Array;
}>;

function bounded(value: string, label: string, maximum = 1_024): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new TypeError("CubeSandbox Provider numeric configuration is invalid");
  }
  return candidate;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolBrokerError("cubesandbox_protocol_error", `${label} was invalid`, false);
  }
  return value as Record<string, unknown>;
}

function sandboxDirectoryListing(value: unknown): SandboxDirectoryListing {
  const raw = record(value, "Cube guest directory");
  if (
    typeof raw.path !== "string" ||
    !raw.path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(raw.path) ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > 1_000
  ) {
    throw new ToolBrokerError(
      "development_environment_directory_invalid",
      "Cube guest directory response was invalid",
      false,
    );
  }
  return {
    path: raw.path,
    entries: Object.freeze(
      raw.entries.map((entry) => {
        const candidate = record(entry, "Cube guest directory entry");
        if (
          typeof candidate.name !== "string" ||
          candidate.name.length < 1 ||
          candidate.name.includes("/") ||
          /[\u0000-\u001f\u007f]/u.test(candidate.name) ||
          typeof candidate.path !== "string" ||
          !candidate.path.startsWith("/") ||
          /[\u0000-\u001f\u007f]/u.test(candidate.path) ||
          !new Set(["directory", "file", "symlink", "other"]).has(String(candidate.kind)) ||
          (candidate.sizeBytes !== undefined &&
            (!Number.isSafeInteger(candidate.sizeBytes) || (candidate.sizeBytes as number) < 0))
        ) {
          throw new ToolBrokerError(
            "development_environment_directory_invalid",
            "Cube guest directory entry was invalid",
            false,
          );
        }
        return Object.freeze({
          name: candidate.name,
          path: candidate.path,
          kind: candidate.kind as "directory" | "file" | "symlink" | "other",
          ...(candidate.sizeBytes === undefined
            ? {}
            : { sizeBytes: candidate.sizeBytes as number }),
        });
      }),
    ),
  };
}

function sandboxPreviewResponse(
  value: unknown,
): import("./sandbox-provider.ts").SandboxPreviewHttpResponse {
  const raw = record(value, "Cube guest preview response");
  if (
    !Number.isSafeInteger(raw.status) ||
    (raw.status as number) < 100 ||
    (raw.status as number) > 599 ||
    typeof raw.body !== "string" ||
    raw.body.length > PREVIEW_RESPONSE_LIMIT_BYTES ||
    typeof raw.headers !== "object" ||
    raw.headers === null ||
    Array.isArray(raw.headers)
  ) {
    throw new ToolBrokerError(
      "sandbox_preview_response_invalid",
      "Cube guest preview response was invalid",
      false,
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(raw.headers)) {
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) ||
      typeof headerValue !== "string" ||
      headerValue.length > 8_192 ||
      /[\u0000-\u001f\u007f]/u.test(headerValue)
    ) {
      throw new ToolBrokerError(
        "sandbox_preview_response_invalid",
        "Cube guest preview response was invalid",
        false,
      );
    }
    headers[name] = headerValue;
  }
  const body = Buffer.from(raw.body, "base64");
  if (body.byteLength > 16 * 1_024 * 1_024) {
    throw new ToolBrokerError(
      "sandbox_preview_response_invalid",
      "Cube guest preview response exceeded its limit",
      false,
    );
  }
  return { status: raw.status as number, headers: Object.freeze(headers), body };
}

function stringField(value: Record<string, unknown>, name: string, maximum = 256): string {
  const field = value[name];
  if (
    typeof field !== "string" ||
    field.length < 1 ||
    field.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(field)
  ) {
    throw new ToolBrokerError(
      "cubesandbox_protocol_error",
      "CubeSandbox runtime evidence was invalid",
      false,
    );
  }
  return field;
}

function integerField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    throw new ToolBrokerError(
      "cubesandbox_protocol_error",
      "CubeSandbox runtime evidence was invalid",
      false,
    );
  }
  return field as number;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  const field = value[name];
  if (typeof field !== "boolean") {
    throw new ToolBrokerError(
      "cubesandbox_protocol_error",
      "CubeSandbox runtime evidence was invalid",
      false,
    );
  }
  return field;
}

function parseEvidence(value: unknown): CubeRuntimeEvidence {
  const candidate = record(value, "CubeSandbox runtime evidence");
  const controlProtocolVersion = integerField(candidate, "controlProtocolVersion");
  if (controlProtocolVersion !== 2) {
    throw new ToolBrokerError(
      "cubesandbox_protocol_error",
      "CubeSandbox control protocol evidence was invalid",
      false,
    );
  }
  const capabilities = stringField(candidate, "effectiveCapabilities", 64).toLowerCase();
  if (!/^[0-9a-f]+$/.test(capabilities)) {
    throw new ToolBrokerError(
      "cubesandbox_protocol_error",
      "CubeSandbox capability evidence was invalid",
      false,
    );
  }
  return Object.freeze({
    controlProtocolVersion: 2,
    imageRevision: stringField(candidate, "imageRevision", 128),
    kernelRelease: stringField(candidate, "kernelRelease", 256),
    cpuCount: integerField(candidate, "cpuCount"),
    memoryBytes: integerField(candidate, "memoryBytes"),
    uid: integerField(candidate, "uid"),
    gid: integerField(candidate, "gid"),
    hypervisorFlag: booleanField(candidate, "hypervisorFlag"),
    noNewPrivileges: booleanField(candidate, "noNewPrivileges"),
    effectiveCapabilities: capabilities,
    readOnlyRootFilesystem: booleanField(candidate, "readOnlyRootFilesystem"),
    supervisorUid: integerField(candidate, "supervisorUid"),
    supervisorGid: integerField(candidate, "supervisorGid"),
    ipAddress: stringField(candidate, "ipAddress", 45),
  });
}

function physicalBindingSha256(
  activationId: string,
  assignment: ToolSandboxAssignment,
  environment: SandboxCreateSpec["environment"],
): string {
  return createHash("sha256")
    .update("pi-cloud.cubesandbox-binding.v2\0")
    .update(
      JSON.stringify({
        activationId,
        tenantId: assignment.tenantId,
        projectId: assignment.projectId,
        workspaceId: assignment.workspaceId,
        environmentVersionId: environment.environmentVersionId,
        specSha256: environment.specSha256,
        recipeSha256: environment.recipeSha256,
        imageRevision: environment.imageRevision,
      }),
    )
    .digest("hex");
}

function assignmentMetadata(
  activationId: string,
  assignment: ToolSandboxAssignment,
  imageRevision: string,
  bindingSha256: string,
): Readonly<Record<string, string>> {
  const execution = parseExecutionLease(assignment.executionLease);
  const current: CubeAssignmentMetadata = {
    activationId,
    tenantId: assignment.tenantId,
    projectId: assignment.projectId,
    workspaceId: assignment.workspaceId,
    supervisorId: assignment.supervisorId,
    bootId: assignment.bootId,
    sandboxId: assignment.sandboxId,
    commandId: assignment.commandId,
    sessionId: assignment.sessionId,
    turnId: assignment.turnId,
    leaseId: execution.leaseId,
    attemptId: execution.attemptId,
    fencingToken: execution.fencingToken,
    bindingSha256,
    imageRevision,
  };
  return Object.freeze({
    [METADATA.managed]: "true",
    [METADATA.provider]: CUBESANDBOX_PROVIDER_ID,
    [METADATA.workload]: "tool-sandbox",
    [METADATA.activationId]: activationId,
    [METADATA.tenantId]: assignment.tenantId,
    [METADATA.projectId]: assignment.projectId,
    [METADATA.workspaceId]: assignment.workspaceId,
    [METADATA.supervisorId]: assignment.supervisorId,
    [METADATA.bootId]: assignment.bootId,
    [METADATA.sandboxId]: assignment.sandboxId,
    [METADATA.commandId]: assignment.commandId,
    [METADATA.sessionId]: assignment.sessionId,
    [METADATA.turnId]: assignment.turnId,
    [METADATA.leaseId]: execution.leaseId,
    [METADATA.attemptId]: execution.attemptId,
    [METADATA.fencingToken]: String(execution.fencingToken),
    [METADATA.bindingSha256]: bindingSha256,
    [METADATA.imageRevision]: imageRevision,
    // Keep a fence-qualified immutable create record for inventory and orphan
    // reconciliation. Later Run ownership lives only in PostgreSQL and the
    // Tool Broker activation; generic envd carries no PiCloud authority.
    [`${ASSIGNMENT_METADATA_PREFIX}${String(execution.fencingToken).padStart(16, "0")}`]:
      JSON.stringify(current),
  });
}

function sameAssignment(left: ToolSandboxAssignment, right: ToolSandboxAssignment): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.supervisorId === right.supervisorId &&
    left.bootId === right.bootId &&
    left.sandboxId === right.sandboxId &&
    left.commandId === right.commandId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.executionLease === right.executionLease
  );
}

function metadataMatchesPhysicalBinding(
  values: Readonly<Record<string, string>>,
  activationId: string,
  assignment: ToolSandboxAssignment,
  bindingSha256: string,
  imageRevision: string,
): boolean {
  const current = currentAssignmentMetadata(values);
  return (
    values[METADATA.managed] === "true" &&
    values[METADATA.provider] === CUBESANDBOX_PROVIDER_ID &&
    values[METADATA.workload] === "tool-sandbox" &&
    current?.activationId === activationId &&
    current.tenantId === assignment.tenantId &&
    current.projectId === assignment.projectId &&
    current.workspaceId === assignment.workspaceId &&
    current.bindingSha256 === bindingSha256 &&
    current.imageRevision === imageRevision
  );
}

function metadataMatchesOrphanIdentity(
  values: Readonly<Record<string, string>>,
  activationId: string,
  assignment: ToolSandboxAssignment,
): boolean {
  return (
    values[METADATA.managed] === "true" &&
    values[METADATA.provider] === CUBESANDBOX_PROVIDER_ID &&
    values[METADATA.workload] === "tool-sandbox" &&
    values[METADATA.activationId] === activationId &&
    values[METADATA.tenantId] === assignment.tenantId &&
    values[METADATA.projectId] === assignment.projectId &&
    values[METADATA.workspaceId] === assignment.workspaceId
  );
}

function currentAssignmentMetadata(
  values: Readonly<Record<string, string>>,
): CubeAssignmentMetadata | undefined {
  const candidates: CubeAssignmentMetadata[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!key.startsWith(ASSIGNMENT_METADATA_PREFIX)) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const fencingToken = parsed.fencingToken;
      const required = [
        "activationId",
        "tenantId",
        "projectId",
        "workspaceId",
        "supervisorId",
        "bootId",
        "sandboxId",
        "commandId",
        "sessionId",
        "turnId",
        "leaseId",
        "attemptId",
        "bindingSha256",
        "imageRevision",
      ] as const;
      if (
        required.some(
          (name) =>
            typeof parsed[name] !== "string" ||
            (parsed[name] as string).length < 1 ||
            (parsed[name] as string).length > 512,
        ) ||
        !Number.isSafeInteger(fencingToken) ||
        (fencingToken as number) < 1 ||
        key !== `${ASSIGNMENT_METADATA_PREFIX}${String(fencingToken as number).padStart(16, "0")}`
      ) {
        throw new Error("invalid assignment metadata");
      }
      candidates.push(parsed as unknown as CubeAssignmentMetadata);
    } catch {
      throw new ToolBrokerError(
        "cubesandbox_inventory_invalid",
        "CubeSandbox managed assignment metadata was invalid",
        false,
      );
    }
  }
  const topFencingToken = Number(values[METADATA.fencingToken]);
  const current = candidates.filter(
    (candidate) =>
      candidate.leaseId === values[METADATA.leaseId] &&
      candidate.attemptId === values[METADATA.attemptId] &&
      candidate.fencingToken === topFencingToken,
  );
  if (current.length !== 1) {
    throw new ToolBrokerError(
      "cubesandbox_inventory_ambiguous",
      "CubeSandbox current assignment metadata was missing or ambiguous",
      false,
    );
  }
  return current[0];
}

function assignmentFromMetadata(
  instance: CubeSandboxInstance,
): (ToolSandboxAssignment & { activationId: string }) | undefined {
  const values = instance.metadata;
  if (
    values[METADATA.managed] !== "true" ||
    values[METADATA.provider] !== CUBESANDBOX_PROVIDER_ID ||
    values[METADATA.workload] !== "tool-sandbox"
  ) {
    return undefined;
  }
  if (
    values[METADATA.leaseId] === undefined ||
    values[METADATA.attemptId] === undefined ||
    values[METADATA.fencingToken] === undefined
  ) {
    // Unmanaged or obsolete Cube metadata is never adopted as current authority.
    return undefined;
  }
  const current = currentAssignmentMetadata(values);
  if (current === undefined) {
    throw new ToolBrokerError(
      "cubesandbox_inventory_invalid",
      "CubeSandbox managed metadata was invalid",
      false,
    );
  }
  return {
    activationId: current.activationId,
    tenantId: current.tenantId,
    projectId: current.projectId,
    workspaceId: current.workspaceId,
    supervisorId: current.supervisorId,
    bootId: current.bootId,
    sandboxId: current.sandboxId,
    commandId: current.commandId,
    sessionId: current.sessionId,
    turnId: current.turnId,
    executionLease: createExecutionLease(current.leaseId, current.attemptId, current.fencingToken),
  };
}

function runtimeUuid(sandboxId: string): string {
  const bytes = createHash("sha256")
    .update(`picloud:cubesandbox:${sandboxId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function supervisorAssignment(
  instance: CubeSandboxInstance,
  assignment: ToolSandboxAssignment,
): SupervisorRuntimeAssignment {
  return {
    containerId: runtimeUuid(instance.sandboxId),
    containerName: bounded(instance.sandboxId, "CubeSandbox runtime name", 128),
    supervisorId: assignment.supervisorId,
    bootId: assignment.bootId,
    sandboxId: assignment.sandboxId,
    commandId: assignment.commandId,
    workspaceId: assignment.workspaceId,
    sessionId: assignment.sessionId,
    turnId: assignment.turnId,
    executionLease: assignment.executionLease,
  };
}

function sameRuntimeAssignment(
  instance: CubeSandboxInstance,
  assignment: ToolSandboxAssignment,
  expected: SupervisorRuntimeAssignment,
): boolean {
  const actual = supervisorAssignment(instance, assignment);
  return (
    actual.containerId === expected.containerId &&
    actual.containerName === expected.containerName &&
    actual.supervisorId === expected.supervisorId &&
    actual.bootId === expected.bootId &&
    actual.sandboxId === expected.sandboxId &&
    actual.commandId === expected.commandId &&
    actual.workspaceId === expected.workspaceId &&
    actual.sessionId === expected.sessionId &&
    actual.turnId === expected.turnId &&
    actual.executionLease === expected.executionLease
  );
}

function effectiveIsolation(
  evidence: CubeRuntimeEvidence,
  policy: SandboxPolicy,
): SandboxEffectiveIsolation {
  return {
    isolationBoundary: "microvm",
    runtime: CUBESANDBOX_RUNTIME_NAME,
    user: `${evidence.uid}:${evidence.gid}`,
    privileged: false,
    readOnlyRootFilesystem: evidence.readOnlyRootFilesystem,
    networkMode: "public_web_proxy_private_denied",
    mountCount: 0,
    hasDockerSocket: false,
    pidLimit: policy.resources.pids,
    processLimit: policy.resources.pids,
    memoryBytes: evidence.memoryBytes,
    cpuNano: evidence.cpuCount * 1_000_000_000,
    droppedCapabilities: evidence.effectiveCapabilities === "0000000000000000" ? ["ALL"] : [],
    securityOptions: evidence.noNewPrivileges ? ["no-new-privileges"] : [],
    sandboxKernelRelease: evidence.kernelRelease,
  };
}

export class CubeSandboxProvider implements SandboxProvider {
  readonly providerId = CUBESANDBOX_PROVIDER_ID;
  readonly defaultPolicy = CUBESANDBOX_TOOL_POLICY;
  readonly supportsWarmRebind = true;
  readonly #templateId: string;
  readonly #developmentTemplateIds: ReadonlyMap<DevelopmentEnvironmentProfileKey, string>;
  readonly #imageRevision: string;
  readonly #client: CubeSandboxRuntimeClient;
  readonly #readyTimeoutMs: number;
  readonly #webProxy: ToolWebProxyBootstrap;
  readonly #workspaceVolumeGateway: WorkspaceVolumeGateway;
  readonly #persistentCapsules: CubePersistentCapsuleCodec | undefined;
  readonly #activations = new Map<string, CubeActivation>();
  #runtimeProbe: Promise<void> | undefined;

  constructor(options: CubeSandboxProviderOptions) {
    this.#templateId = bounded(options.templateId, "CubeSandbox template ID", 256);
    this.#developmentTemplateIds = new Map(
      (["starter", "standard", "performance"] as const).map((key) => [
        key,
        bounded(
          options.developmentTemplateIds?.[key] ?? options.templateId,
          `CubeSandbox ${key} development template ID`,
          256,
        ),
      ]),
    );
    this.#imageRevision = bounded(options.imageRevision, "CubeSandbox image revision", 128);
    this.#readyTimeoutMs = positiveInteger(options.readyTimeoutMs, READY_TIMEOUT_MS, 300_000);
    this.#workspaceVolumeGateway = options.workspaceVolumeGateway;
    this.#persistentCapsules =
      options.persistentStateKey === undefined
        ? undefined
        : new CubePersistentCapsuleCodec(options.persistentStateKey);
    if (
      !isIPv4(options.webProxy.host) ||
      !Number.isSafeInteger(options.webProxy.port) ||
      options.webProxy.port < 1 ||
      options.webProxy.port > 65_535
    ) {
      throw new TypeError("CubeSandbox web proxy configuration is invalid");
    }
    this.#webProxy = Object.freeze({
      ...options.webProxy,
      ...(options.webProxy.directPrivateCidrs === undefined
        ? {}
        : { directPrivateCidrs: [...options.webProxy.directPrivateCidrs] }),
    });
    if (options.runtimeClient !== undefined) {
      this.#client = options.runtimeClient;
    } else {
      if (options.runtime === undefined) {
        throw new TypeError("CubeSandbox runtime configuration is missing");
      }
      this.#client = new OfficialCubeSandboxRuntimeClient(options.runtime);
    }
  }

  async #guestJson(
    instance: CubeSandboxInstance,
    input: unknown,
    options: Readonly<{
      program: "tool" | "control" | "preview";
      runAsToolUser: boolean;
      timeoutMs: number;
      maximumOutputBytes?: number;
      signal?: AbortSignal;
    }>,
  ): Promise<unknown> {
    const path = `/tmp/pi-cloud-envd-${randomUUID()}.json`;
    const bytes = Buffer.from(JSON.stringify(input), "utf8");
    if (bytes.byteLength < 2 || bytes.byteLength > 16 * 1_024 * 1_024) {
      throw new ToolBrokerError(
        "cubesandbox_guest_request_invalid",
        "CubeSandbox guest request exceeded its limit",
        false,
      );
    }
    await this.#client.writeGuestFile(instance, path, bytes);
    const program = {
      tool: "/opt/pi-cloud/bin/envd-tool-exec.mjs",
      control: "/opt/pi-cloud/bin/envd-guest-control.mjs",
      preview: "/opt/pi-cloud/bin/envd-preview-proxy.mjs",
    }[options.program];
    const maximumOutputBytes = options.maximumOutputBytes ?? TOOL_RESPONSE_LIMIT_BYTES;
    if (
      !Number.isSafeInteger(maximumOutputBytes) ||
      maximumOutputBytes < 1 ||
      maximumOutputBytes > PREVIEW_RESPONSE_LIMIT_BYTES
    ) {
      throw new ToolBrokerError(
        "cubesandbox_guest_request_invalid",
        "CubeSandbox guest response limit was invalid",
        false,
      );
    }
    const prefix = options.runAsToolUser
      ? "/usr/bin/setpriv --reuid 1000 --regid 1000 --clear-groups --no-new-privs "
      : "";
    const prepareInput = options.runAsToolUser
      ? `/bin/chown 1000:1000 ${path} && /bin/chmod 0400 ${path} && `
      : `/bin/chmod 0400 ${path} && `;
    try {
      const result = await this.#client.runCommand(instance, {
        command: `${prepareInput}${prefix}/usr/local/bin/node ${program} ${path}`,
        cwd: "/",
        user: "root",
        timeoutMs: options.timeoutMs,
        maximumOutputBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (result.exitCode !== 0) {
        throw new ToolBrokerError(
          "cubesandbox_guest_execution_failed",
          "CubeSandbox one-shot guest helper failed",
          false,
          new Error(
            `Guest helper exited with code ${String(result.exitCode)}: ${result.stderr.slice(-1_024)}`,
          ),
        );
      }
      const output = result.stdout.trim();
      if (output.length < 2 || output.length > maximumOutputBytes) {
        throw new ToolBrokerError(
          "cubesandbox_guest_response_invalid",
          "CubeSandbox guest response was invalid",
          false,
        );
      }
      try {
        return JSON.parse(output) as unknown;
      } catch {
        throw new ToolBrokerError(
          "cubesandbox_guest_response_invalid",
          "CubeSandbox guest response was invalid",
          false,
        );
      }
    } finally {
      await this.#client.removeGuestFile(instance, path).catch(() => undefined);
    }
  }

  #attachedInitialization(
    activation: CubeActivation,
  ): Extract<ToolWorkerInput, { type: "worker.initialize" }> {
    return {
      toolWorkerProtocolVersion: 1,
      type: "worker.initialize",
      activationId: activation.handle.activationId,
      toolRoot: activation.toolRoot,
      environment: activation.handle.environment,
      workspaceSeed: { kind: "sample_java" },
      workspaceAttach: { recipeCommands: activation.toolchain.recipeCommands },
      webProxy: this.#webProxy,
    };
  }

  async checkHealth(): Promise<void> {
    await Promise.all([this.#client.checkHealth(), this.#workspaceVolumeGateway.checkHealth()]);
    this.#runtimeProbe ??= this.#probeRuntime();
    try {
      await this.#runtimeProbe;
    } catch (error: unknown) {
      this.#runtimeProbe = undefined;
      throw error;
    }
  }

  async deleteWorkspaceVolume(volumeId: string): Promise<void> {
    await this.#client.deleteVolume(volumeId);
  }

  async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
    if (this.#activations.has(spec.activationId)) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_collision",
        "CubeSandbox activation identity collided",
        false,
      );
    }
    if (
      spec.policy.network.mode !== "public_web_proxy_private_denied" ||
      spec.policy.allowHostMounts ||
      spec.policy.allowDockerSocket ||
      spec.policy.privileged
    ) {
      throw new ToolBrokerError(
        "cubesandbox_policy_unsupported",
        "CubeSandbox Provider does not support the requested policy",
        false,
      );
    }
    const volumeReference =
      spec.workspaceRestore === undefined
        ? undefined
        : parsePersistentVolumeReference(decodeWorkspaceSnapshotBlob(spec.workspaceRestore));
    if (
      spec.workspaceRestore !== undefined &&
      (volumeReference === undefined ||
        volumeReference.tenantId !== spec.assignment.tenantId ||
        volumeReference.workspaceId !== spec.assignment.workspaceId ||
        volumeReference.volumeId !== workspaceVolumeId(spec.assignment) ||
        volumeReference.environmentSpecSha256 !== spec.environment.specSha256 ||
        (volumeReference.sourceSessionId === spec.assignment.sessionId &&
          fencingToken(spec.assignment) <= volumeReference.fencingToken))
    ) {
      throw new ToolBrokerError(
        "cubesandbox_volume_reference_invalid",
        "Persistent Workspace Volume reference did not match the requested Workspace, environment or Session fence",
        false,
      );
    }
    const exclusiveMachine = spec.lifetime === "development_environment";
    const toolRoot = spec.toolRoot ?? (exclusiveMachine ? "/home/user" : "/workspace");
    const bindingSha256 = physicalBindingSha256(
      spec.activationId,
      spec.assignment,
      spec.environment,
    );
    const volumeId = workspaceVolumeId(spec.assignment);
    await this.#client.ensureVolume(volumeId, "picloud-posix");
    const prepared = await this.#workspaceVolumeGateway.prepare({
      tenantId: spec.assignment.tenantId,
      workspaceId: spec.assignment.workspaceId,
      sessionId: spec.assignment.sessionId,
      volumeId,
    });
    let instance: CubeSandboxInstance;
    try {
      instance = await this.#client.create({
        templateId:
          spec.sandboxProfileKey !== undefined
            ? this.#developmentTemplateIds.get(spec.sandboxProfileKey)!
            : this.#templateId,
        timeoutSeconds:
          spec.lifetime === "development_environment"
            ? -1
            : Math.ceil(spec.policy.resources.turnWallClockTimeoutMs / 1_000),
        metadata: assignmentMetadata(
          spec.activationId,
          spec.assignment,
          this.#imageRevision,
          bindingSha256,
        ),
        allowInternetAccess: true,
        allowPublicTraffic: false,
        volumeMounts: [{ name: volumeId, path: exclusiveMachine ? "/home/user" : "/workspace" }],
        ...(spec.lifetime === "development_environment"
          ? { lifecycle: { onTimeout: "pause" as const, autoResume: true } }
          : {}),
      });
    } catch (error: unknown) {
      if (
        error instanceof CubeRuntimeClientError &&
        (error.statusCode === 409 || error.statusCode === 429)
      ) {
        throw new ToolBrokerError(
          "sandbox_compute_capacity_exhausted",
          "Selected Cube profile has no available compute capacity",
          true,
          error,
        );
      }
      throw error;
    }
    try {
      const evidence = await this.#waitForEvidence(instance);
      this.#assertEvidence(evidence, spec.policy);
      const ready = parseToolWorkerOutput(
        await this.#guestJson(
          instance,
          {
            mode: "initialize",
            initialization: {
              toolWorkerProtocolVersion: 1,
              type: "worker.initialize",
              activationId: spec.activationId,
              toolRoot: exclusiveMachine ? "/workspace" : toolRoot,
              environment: spec.environment,
              workspaceSeed: spec.workspaceSeed,
              ...(prepared.attached
                ? { workspaceAttach: { recipeCommands: volumeReference?.recipeCommands ?? [] } }
                : {}),
              webProxy: this.#webProxy,
            },
          },
          {
            program: "tool",
            runAsToolUser: true,
            timeoutMs: this.#readyTimeoutMs,
          },
        ),
      );
      if (ready.type !== "worker.ready" || ready.activationId !== spec.activationId) {
        throw new ToolBrokerError(
          "environment_preflight_mismatch",
          "CubeSandbox environment initialization did not settle",
          false,
        );
      }
      const toolchain = parseEnvironmentToolchainReport(ready.environment);
      if (
        !isExpectedDefaultToolchain(toolchain) ||
        toolchain.profileKey !== spec.environment.profileKey ||
        toolchain.profileVersion !== spec.environment.profileVersion ||
        toolchain.imageRevision !== spec.environment.imageRevision ||
        toolchain.specSha256 !== spec.environment.specSha256 ||
        toolchain.recipeSha256 !== spec.environment.recipeSha256
      ) {
        throw new ToolBrokerError(
          "environment_preflight_mismatch",
          "CubeSandbox environment did not match the accepted Run",
          false,
        );
      }
      if (exclusiveMachine) {
        const preparedMachine = record(
          await this.#guestJson(
            instance,
            { mode: "prepare_exclusive_machine" },
            { program: "control", runAsToolUser: false, timeoutMs: 15_000 },
          ),
          "Cube exclusive machine preparation",
        );
        if (
          preparedMachine.home !== "/home/user" ||
          preparedMachine.legacyWorkspaceRemoved !== true
        ) {
          throw new ToolBrokerError(
            "development_environment_home_invalid",
            "Exclusive machine home directory could not be prepared",
            false,
          );
        }
      }
      if (!prepared.attached) {
        await this.#workspaceVolumeGateway.initializeBaseline({
          tenantId: spec.assignment.tenantId,
          workspaceId: spec.assignment.workspaceId,
          sessionId: spec.assignment.sessionId,
          volumeId,
        });
      }
      const environmentValidation: EnvironmentValidationReport = {
        ...toolchain,
        isolationBoundary: "microvm",
        runtime: CUBESANDBOX_RUNTIME_NAME,
        networkMode: "public_web_proxy_private_denied",
        runAsUser: "1000:1000",
        readOnlyRootFilesystem: false,
      };
      const handle: SandboxHandle = Object.freeze({
        providerApiVersion: 1,
        providerId: this.providerId,
        activationId: spec.activationId,
        runtimeId: runtimeUuid(instance.sandboxId),
        runtimeName: bounded(instance.sandboxId, "CubeSandbox runtime name", 128),
        ipAddress: evidence.ipAddress,
        workspaceRoot: toolRoot,
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation,
      });
      this.#activations.set(spec.activationId, {
        instance,
        handle,
        evidence,
        toolchain,
        seenOperationIds: new Set(),
        seenCaptureIds: new Set(),
        bindingSha256,
        authorityEpoch: fencingToken(spec.assignment),
        state: "running",
        volumeId,
        lifetime: spec.lifetime ?? "agent_turn",
        toolRoot,
      });
      return handle;
    } catch (error: unknown) {
      await this.#client.destroy(instance.sandboxId).catch(() => undefined);
      throw error;
    }
  }

  async retainForWarm(
    handle: SandboxHandle,
    brokerAssignment: ToolSandboxAssignment,
  ): Promise<SandboxHandle> {
    const activation = await this.#owned(handle);
    if (activation.state !== "idle") {
      throw new ToolBrokerError(
        "cubesandbox_handoff_state_invalid",
        "CubeSandbox was not detached before warm retention",
        false,
      );
    }
    const nextAuthorityEpoch = fencingToken(brokerAssignment);
    if (
      brokerAssignment.tenantId !== handle.assignment.tenantId ||
      brokerAssignment.projectId !== handle.assignment.projectId ||
      brokerAssignment.workspaceId !== handle.assignment.workspaceId ||
      brokerAssignment.sessionId !== handle.assignment.sessionId ||
      nextAuthorityEpoch <= activation.authorityEpoch
    ) {
      throw new ToolBrokerError(
        "cubesandbox_rekey_identity_invalid",
        "CubeSandbox warm Broker authority was invalid",
        false,
      );
    }
    const retained = Object.freeze({ ...handle, assignment: brokerAssignment });
    activation.handle = retained;
    activation.authorityEpoch = nextAuthorityEpoch;
    activation.state = "idle";
    activation.seenOperationIds.clear();
    activation.seenCaptureIds.clear();
    return retained;
  }

  async rebind(
    handle: SandboxHandle,
    assignment: ToolSandboxAssignment,
    toolRoot = "/workspace",
  ): Promise<SandboxHandle> {
    this.#assertHandle(handle);
    const activation = this.#activations.get(handle.activationId);
    if (
      activation === undefined ||
      activation.handle.runtimeId !== handle.runtimeId ||
      activation.state !== "idle" ||
      assignment.tenantId !== handle.assignment.tenantId ||
      assignment.projectId !== handle.assignment.projectId ||
      assignment.workspaceId !== handle.assignment.workspaceId ||
      activation.authorityEpoch >= Number.MAX_SAFE_INTEGER
    ) {
      throw new ToolBrokerError(
        "cubesandbox_rebind_identity_invalid",
        "CubeSandbox warm rebind identity was invalid",
        false,
      );
    }
    const rebound: SandboxHandle = Object.freeze({
      ...handle,
      assignment,
      workspaceRoot: toolRoot,
    });
    activation.handle = rebound;
    activation.authorityEpoch = Math.max(activation.authorityEpoch + 1, fencingToken(assignment));
    activation.toolRoot = toolRoot;
    activation.state = "running";
    activation.seenOperationIds.clear();
    activation.seenCaptureIds.clear();
    return rebound;
  }

  async exec(
    handle: SandboxHandle,
    request: ToolSandboxOperationRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxOperationResponse> {
    const activation = await this.#owned(handle);
    if (request.activationId !== handle.activationId) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_mismatch",
        "Tool operation activation identity did not match",
        false,
      );
    }
    if (activation.seenOperationIds.has(request.operationId)) {
      throw new ToolBrokerError(
        "tool_operation_replay",
        "Tool operation ID was already used",
        false,
      );
    }
    activation.seenOperationIds.add(request.operationId);
    try {
      const timeoutMs =
        request.operation === "bash.exec" ? request.timeoutMs + 5_000 : this.#readyTimeoutMs;
      const output = parseToolWorkerOutput(
        await this.#guestJson(
          activation.instance,
          {
            mode: "operation",
            initialization: this.#attachedInitialization(activation),
            operation: request,
          },
          {
            program: "tool",
            runAsToolUser: true,
            timeoutMs,
            ...(signal === undefined ? {} : { signal }),
          },
        ),
      );
      if (output.type === "worker.failed") {
        throw new ToolBrokerError(output.code, output.message, output.retryable);
      }
      if (output.type !== "worker.operation_result") {
        throw new ToolBrokerError(
          "cubesandbox_protocol_error",
          "CubeSandbox returned the wrong Tool Worker response",
          false,
        );
      }
      return parseToolSandboxOperationResponse(output.response);
    } catch (error: unknown) {
      // A disconnected remote command has an unknowable execution result.
      // Destroying the disposable VM prevents it from continuing behind a
      // newer Attempt and is safer than replaying arbitrary Bash.
      await this.#client.destroy(activation.instance.sandboxId).catch(() => undefined);
      this.#activations.delete(handle.activationId);
      throw new ToolBrokerError(
        signal?.aborted ? "tool_cancelled" : "cubesandbox_tool_result_unknown",
        signal?.aborted
          ? "Tool command was cancelled"
          : "CubeSandbox Tool command result was unknown; the VM was destroyed",
        signal?.aborted === true,
      );
    }
  }

  async readFile(
    handle: SandboxHandle,
    input: SandboxReadFileInput,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.exec(
      handle,
      {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        activationId: handle.activationId,
        operationId: input.operationId,
        turnContextSha256: INTERNAL_STEP_CONTEXT_SHA256,
        attemptContextSha256: INTERNAL_STEP_CONTEXT_SHA256,
        stepContextSequence: 1,
        stepContextSha256: INTERNAL_STEP_CONTEXT_SHA256,
        toolName: "read",
        operation: "file.read",
        path: input.path,
      },
      signal,
    );
    if (response.type === "tool_sandbox.operation_failed") {
      throw new ToolBrokerError(response.code, response.message, response.retryable);
    }
    if (response.operation !== "file.read") {
      throw new ToolBrokerError(
        "cubesandbox_protocol_error",
        "CubeSandbox returned the wrong file operation",
        false,
      );
    }
    return Buffer.from(response.content, "base64");
  }

  async writeFile(
    handle: SandboxHandle,
    input: SandboxWriteFileInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.exec(
      handle,
      {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        activationId: handle.activationId,
        operationId: input.operationId,
        turnContextSha256: INTERNAL_STEP_CONTEXT_SHA256,
        attemptContextSha256: INTERNAL_STEP_CONTEXT_SHA256,
        stepContextSequence: 1,
        stepContextSha256: INTERNAL_STEP_CONTEXT_SHA256,
        toolName: "write",
        operation: "file.write",
        path: input.path,
        content: input.content,
      },
      signal,
    );
    if (response.type === "tool_sandbox.operation_failed") {
      throw new ToolBrokerError(response.code, response.message, response.retryable);
    }
    if (response.operation !== "file.write") {
      throw new ToolBrokerError(
        "cubesandbox_protocol_error",
        "CubeSandbox returned the wrong file operation",
        false,
      );
    }
  }

  async openTerminal(
    handle: SandboxHandle,
    size: SandboxTerminalSize,
  ): Promise<SandboxTerminalSession> {
    const activation = await this.#owned(handle);
    if (activation.state !== "running") {
      throw new ToolBrokerError(
        "workspace_terminal_runtime_unavailable",
        "Workspace terminal runtime was not active",
        true,
      );
    }
    if (activation.lifetime === "development_environment") {
      const connected = await this.#client.connect(activation.instance.sandboxId, -1);
      if (connected.sandboxId !== activation.instance.sandboxId) {
        throw new ToolBrokerError(
          "development_environment_connect_invalid",
          "CubeSandbox did not return the expected development environment connection",
          false,
        );
      }
      // Cube intentionally omits trafficAccessToken and metadata from
      // connect/resume responses. The create-time token remains the durable
      // private-ingress authority; #owned() already revalidated physical
      // metadata immediately before this refresh.
      activation.instance = Object.freeze({
        ...activation.instance,
        ...connected,
        metadata: activation.instance.metadata,
        ...(activation.instance.trafficAccessToken === undefined
          ? {}
          : { trafficAccessToken: activation.instance.trafficAccessToken }),
      });
    }
    const terminal = await this.#client.openTerminal(activation.instance, {
      rows: size.rows,
      cols: size.cols,
      admin: activation.lifetime === "development_environment",
    });
    return Object.freeze({
      pid: terminal.pid,
      output: terminal.output,
      sendInput: (data: Uint8Array) => terminal.sendInput(data),
      resize: (next: SandboxTerminalSize) => terminal.resize(next),
      kill: async () => {
        await terminal.kill();
      },
      disconnect: () => terminal.disconnect(),
    });
  }

  async previewHttp(
    handle: SandboxHandle,
    request: import("./sandbox-provider.ts").SandboxPreviewHttpRequest,
  ): Promise<import("./sandbox-provider.ts").SandboxPreviewHttpResponse> {
    const activation = await this.#owned(handle);
    if (activation.state !== "running" && activation.state !== "idle") {
      throw new ToolBrokerError(
        "sandbox_preview_runtime_unavailable",
        "Sandbox preview runtime was not available",
        true,
      );
    }
    return sandboxPreviewResponse(
      await this.#guestJson(
        activation.instance,
        {
          mode: "preview_http",
          request: {
            ...request,
            ...(request.body === undefined
              ? {}
              : { body: Buffer.from(request.body).toString("base64") }),
            maximumResponseBytes: 16 * 1_024 * 1_024,
            timeoutMs: 60_000,
          },
        },
        {
          program: "preview",
          runAsToolUser: true,
          timeoutMs: 65_000,
          maximumOutputBytes: PREVIEW_RESPONSE_LIMIT_BYTES,
        },
      ),
    );
  }

  async discoverHttpServices(
    handle: SandboxHandle,
    signal?: AbortSignal,
  ): Promise<SandboxHttpServiceDiscovery> {
    const activation = await this.#owned(handle);
    if (activation.state !== "running" && activation.state !== "idle") {
      throw new ToolBrokerError(
        "sandbox_service_discovery_unavailable",
        "Sandbox HTTP service discovery was unavailable",
        true,
      );
    }
    const result = await this.#client.runCommand(activation.instance, {
      command:
        `/usr/local/bin/node -e ` +
        `"eval(Buffer.from('${HTTP_SERVICE_DISCOVERY_SCRIPT}','base64').toString('utf8'))"`,
      cwd: "/",
      user: "root",
      timeoutMs: 5_000,
      maximumOutputBytes: 32 * 1_024,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0 || result.stderr.length > 0) {
      throw new ToolBrokerError(
        "sandbox_service_discovery_failed",
        "Sandbox HTTP service discovery failed",
        true,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new ToolBrokerError(
        "sandbox_service_discovery_invalid",
        "Sandbox HTTP service discovery returned invalid evidence",
        false,
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ToolBrokerError(
        "sandbox_service_discovery_invalid",
        "Sandbox HTTP service discovery returned invalid evidence",
        false,
      );
    }
    const candidate = value as Record<string, unknown>;
    const listeningPorts = candidate.listeningPorts;
    const httpServices = candidate.httpServices;
    if (
      !Array.isArray(listeningPorts) ||
      listeningPorts.length > 128 ||
      listeningPorts.some(
        (port) => !Number.isInteger(port) || Number(port) < 1_024 || Number(port) > 65_535,
      ) ||
      new Set(listeningPorts).size !== listeningPorts.length ||
      !Array.isArray(httpServices) ||
      httpServices.length > 32 ||
      httpServices.some(
        (service) =>
          typeof service !== "object" ||
          service === null ||
          Array.isArray(service) ||
          !Number.isInteger((service as Record<string, unknown>).port) ||
          Number((service as Record<string, unknown>).port) < 1_024 ||
          Number((service as Record<string, unknown>).port) > 65_535 ||
          (service as Record<string, unknown>).protocol !== "http",
      )
    ) {
      throw new ToolBrokerError(
        "sandbox_service_discovery_invalid",
        "Sandbox HTTP service discovery returned invalid evidence",
        false,
      );
    }
    return {
      listeningPorts: listeningPorts as number[],
      httpServices: httpServices as Array<{ port: number; protocol: "http" }>,
    };
  }

  async listDirectory(
    handle: SandboxHandle,
    path: string,
  ): Promise<import("./sandbox-provider.ts").SandboxDirectoryListing> {
    const activation = await this.#owned(handle);
    if (activation.state !== "running" && activation.state !== "idle") {
      throw new ToolBrokerError(
        "development_environment_directory_unavailable",
        "Exclusive machine must be running before browsing its filesystem",
        true,
      );
    }
    return sandboxDirectoryListing(
      await this.#guestJson(
        activation.instance,
        { mode: "list_directory", path },
        { program: "control", runAsToolUser: false, timeoutMs: 15_000 },
      ),
    );
  }

  async createDirectory(
    handle: SandboxHandle,
    path: string,
    name: string,
  ): Promise<SandboxDirectoryListing> {
    const activation = await this.#owned(handle);
    if (activation.state !== "running" && activation.state !== "idle") {
      throw new ToolBrokerError(
        "development_environment_directory_unavailable",
        "Exclusive machine must be running before changing its filesystem",
        true,
      );
    }
    if (
      name.length < 1 ||
      name.length > 128 ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      throw new ToolBrokerError(
        "development_environment_directory_invalid",
        "Cube guest directory name was invalid",
        false,
      );
    }
    return sandboxDirectoryListing(
      await this.#guestJson(
        activation.instance,
        { mode: "create_directory", path, name },
        { program: "control", runAsToolUser: false, timeoutMs: 15_000 },
      ),
    );
  }

  async pause(handle: SandboxHandle): Promise<void> {
    const activation = await this.#owned(handle);
    if (activation.state !== "running" && activation.state !== "idle") {
      throw new ToolBrokerError(
        "development_environment_pause_invalid",
        "CubeSandbox development environment cannot be paused from its current state",
        false,
      );
    }
    await this.#client.pause(activation.instance.sandboxId);
    activation.state = "paused";
  }

  async resume(handle: SandboxHandle): Promise<SandboxHandle> {
    this.#assertHandle(handle);
    const activation = this.#activations.get(handle.activationId);
    if (
      activation === undefined ||
      activation.handle.runtimeId !== handle.runtimeId ||
      activation.state !== "paused"
    ) {
      throw new ToolBrokerError(
        "development_environment_resume_invalid",
        "CubeSandbox development environment cannot be resumed from its current state",
        false,
      );
    }
    const instance = await this.#client.connect(activation.instance.sandboxId, -1);
    if (instance.sandboxId !== activation.instance.sandboxId) {
      throw new ToolBrokerError(
        "development_environment_identity_changed",
        "CubeSandbox changed the development environment identity during resume",
        false,
      );
    }
    activation.instance = Object.freeze({
      ...activation.instance,
      ...instance,
      metadata: activation.instance.metadata,
      ...(activation.instance.trafficAccessToken === undefined
        ? {}
        : { trafficAccessToken: activation.instance.trafficAccessToken }),
    });
    activation.state = "running";
    return activation.handle;
  }

  async persistentCapsule(
    handle: SandboxHandle,
  ): Promise<import("./sandbox-provider.ts").PersistentSandboxCapsule> {
    const activation = await this.#owned(handle);
    if (this.#persistentCapsules === undefined) {
      throw new ToolBrokerError(
        "persistent_capsule_key_missing",
        "Exclusive machine recovery key was not configured",
        false,
      );
    }
    if (activation.lifetime !== "development_environment") {
      throw new ToolBrokerError(
        "persistent_capsule_lifetime_invalid",
        "Only an exclusive development environment has durable machine state",
        false,
      );
    }
    return {
      handle: activation.handle,
      capsule: this.#persistentCapsules.seal({
        version: 1,
        imageRevision: activation.evidence.imageRevision,
        instance: activation.instance,
        handle: activation.handle,
        evidence: activation.evidence,
        toolchain: activation.toolchain,
        bindingSha256: activation.bindingSha256,
        authorityEpoch: activation.authorityEpoch,
        state: activation.state,
        volumeId: activation.volumeId,
        lifetime: activation.lifetime,
        toolRoot: activation.toolRoot,
      }),
    };
  }

  async adoptPersistentCapsule(capsule: string): Promise<SandboxHandle> {
    if (this.#persistentCapsules === undefined) {
      throw new ToolBrokerError(
        "persistent_capsule_key_missing",
        "Exclusive machine recovery key was not configured",
        false,
      );
    }
    const raw = record(this.#persistentCapsules.open(capsule), "Cube persistent machine capsule");
    const instance = raw.instance as CubeSandboxInstance;
    const handle = raw.handle as SandboxHandle;
    const evidence = parseEvidence(raw.evidence);
    const toolchain = raw.toolchain as EnvironmentToolchainReport;
    if (
      raw.version !== 1 ||
      typeof raw.imageRevision !== "string" ||
      !/^[0-9a-z._-]{1,128}$/.test(raw.imageRevision) ||
      raw.lifetime !== "development_environment" ||
      typeof raw.bindingSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(raw.bindingSha256) ||
      !Number.isSafeInteger(raw.authorityEpoch) ||
      (raw.authorityEpoch as number) < 1 ||
      typeof raw.volumeId !== "string" ||
      !/^pcw-[0-9a-f]{48}$/.test(raw.volumeId) ||
      typeof raw.toolRoot !== "string" ||
      !raw.toolRoot.startsWith("/") ||
      typeof instance !== "object" ||
      instance === null ||
      typeof instance.sandboxId !== "string" ||
      typeof instance.trafficAccessToken !== "string" ||
      instance.trafficAccessToken.length < 16 ||
      typeof handle !== "object" ||
      handle === null ||
      typeof evidence !== "object" ||
      evidence === null ||
      evidence.imageRevision !== raw.imageRevision ||
      typeof toolchain !== "object" ||
      toolchain === null ||
      toolchain.imageRevision !== raw.imageRevision
    ) {
      throw new ToolBrokerError(
        "persistent_capsule_invalid",
        "Exclusive machine recovery state was invalid",
        false,
      );
    }
    this.#assertHandle(handle);
    if (handle.environment.imageRevision !== raw.imageRevision) {
      throw new ToolBrokerError(
        "persistent_capsule_invalid",
        "Exclusive machine recovery image identity was inconsistent",
        false,
      );
    }
    if (this.#activations.has(handle.activationId)) {
      throw new ToolBrokerError(
        "persistent_capsule_replay",
        "Exclusive machine was already adopted",
        false,
      );
    }
    const current = await this.#client.read(handle.runtimeName);
    if (
      current === undefined ||
      runtimeUuid(current.sandboxId) !== handle.runtimeId ||
      !metadataMatchesPhysicalBinding(
        current.metadata,
        handle.activationId,
        handle.assignment,
        raw.bindingSha256,
        raw.imageRevision,
      )
    ) {
      throw new ToolBrokerError(
        "persistent_machine_identity_mismatch",
        "Exclusive machine physical identity did not match its recovery state",
        false,
      );
    }
    const recoveredInstance = Object.freeze({
      ...instance,
      ...current,
      metadata: instance.metadata,
      trafficAccessToken: instance.trafficAccessToken,
    });
    const state = current.state.toLowerCase() === "paused" ? "paused" : "running";
    this.#activations.set(handle.activationId, {
      instance: recoveredInstance,
      handle,
      evidence,
      toolchain,
      seenOperationIds: new Set(),
      seenCaptureIds: new Set(),
      bindingSha256: raw.bindingSha256,
      authorityEpoch: raw.authorityEpoch as number,
      state,
      volumeId: raw.volumeId,
      lifetime: "development_environment",
      toolRoot: raw.toolRoot,
    });
    return handle;
  }

  async detachPersistent(handle: SandboxHandle): Promise<void> {
    const activation = await this.#owned(handle);
    if (activation.lifetime !== "development_environment") {
      throw new ToolBrokerError(
        "persistent_detach_lifetime_invalid",
        "Only an exclusive machine can detach without destruction",
        false,
      );
    }
    this.#activations.delete(handle.activationId);
  }

  async snapshot(handle: SandboxHandle, requestId: string): Promise<ToolSandboxCaptureResponse> {
    const activation = await this.#owned(handle);
    if (activation.seenCaptureIds.has(requestId)) {
      throw new ToolBrokerError("tool_capture_replay", "Tool capture ID was already used", false);
    }
    activation.seenCaptureIds.add(requestId);
    let frozenToolProcesses: readonly Readonly<{ pid: number; startTime: string }>[] = [];
    try {
      const raw = record(
        await this.#guestJson(
          activation.instance,
          { mode: "freeze", path: activation.toolRoot },
          {
            program: "control",
            runAsToolUser: false,
            timeoutMs: this.#readyTimeoutMs,
          },
        ),
        "CubeSandbox checkpoint preparation",
      );
      activation.state = "quiesced";
      const processes = raw.processes;
      if (
        !Array.isArray(processes) ||
        processes.some((entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true;
          const processIdentity = entry as Record<string, unknown>;
          return (
            !Number.isSafeInteger(processIdentity.pid) ||
            (processIdentity.pid as number) < 1 ||
            typeof processIdentity.startTime !== "string" ||
            !/^[0-9]+$/.test(processIdentity.startTime)
          );
        })
      ) {
        throw new ToolBrokerError(
          "cubesandbox_checkpoint_prepare_invalid",
          "CubeSandbox did not prove a quiescent Workspace checkpoint",
          false,
        );
      }
      frozenToolProcesses = processes as readonly Readonly<{
        pid: number;
        startTime: string;
      }>[];
      const volume = await this.#workspaceVolumeGateway.snapshot({
        tenantId: handle.assignment.tenantId,
        workspaceId: handle.assignment.workspaceId,
        sessionId: handle.assignment.sessionId,
        volumeId: activation.volumeId,
        activationId: handle.activationId,
        bindingSha256: activation.bindingSha256,
        fencingToken: fencingToken(handle.assignment),
      });
      const workspace = encodeWorkspaceSnapshotBlob(
        createPersistentVolumeReference({
          volumeId: activation.volumeId,
          volumeRevision: volume.volumeRevision,
          activationId: handle.activationId,
          tenantId: handle.assignment.tenantId,
          workspaceId: handle.assignment.workspaceId,
          sourceSessionId: handle.assignment.sessionId,
          bindingSha256: activation.bindingSha256,
          fencingToken: fencingToken(handle.assignment),
          imageRevision: this.#imageRevision,
          environmentSpecSha256: handle.environment.specSha256,
          gitBaselineCommit: volume.gitBaselineCommit,
          files: volume.files,
          recipeCommands: activation.toolchain.recipeCommands,
        }),
      );
      const parsed = parseToolBrokerResponse({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.captured",
        requestId,
        activationId: handle.activationId,
        workspace,
        workspacePatch: volume.workspacePatch,
        environment: handle.environmentValidation,
      });
      if (parsed.type !== "tool_sandbox.captured") {
        throw new ToolBrokerError(
          "cubesandbox_protocol_error",
          "CubeSandbox returned the wrong persistent Volume reference",
          false,
        );
      }
      const completed = record(
        await this.#guestJson(
          activation.instance,
          { mode: "thaw", processes: frozenToolProcesses },
          {
            program: "control",
            runAsToolUser: false,
            timeoutMs: this.#readyTimeoutMs,
          },
        ),
        "CubeSandbox checkpoint completion",
      );
      if (completed.resumed !== frozenToolProcesses.length) {
        throw new ToolBrokerError(
          "cubesandbox_checkpoint_completion_invalid",
          "CubeSandbox did not resume the checkpointed process boundary",
          false,
        );
      }
      activation.state = "idle";
      return parsed;
    } catch (error: unknown) {
      if (activation.state === "quiesced") {
        try {
          await this.#guestJson(
            activation.instance,
            { mode: "thaw", processes: frozenToolProcesses },
            {
              program: "control",
              runAsToolUser: false,
              timeoutMs: this.#readyTimeoutMs,
            },
          );
          activation.state = "idle";
        } catch {
          await this.#client.destroy(activation.instance.sandboxId).catch(() => undefined);
          this.#activations.delete(handle.activationId);
          throw new ToolBrokerError(
            "cubesandbox_checkpoint_recovery_failed",
            "CubeSandbox checkpoint cleanup failed and the VM was destroyed",
            true,
          );
        }
      }
      throw error;
    }
  }

  async forkWorkspace(
    handle: SandboxHandle,
    request: ToolBrokerWorkspaceForkRequest,
  ): Promise<{
    sourceHandle: SandboxHandle;
    sourceRevision: string;
    targetRevision: string;
  }> {
    if (
      request.sourceActivationId !== handle.activationId ||
      !sameAssignment(request.sourceAssignment, handle.assignment) ||
      request.target.tenantId !== handle.assignment.tenantId ||
      request.target.projectId !== handle.assignment.projectId ||
      request.target.workspaceId === handle.assignment.workspaceId ||
      request.target.sessionId === handle.assignment.sessionId
    ) {
      throw new ToolBrokerError(
        "workspace_fork_identity_invalid",
        "Isolated Workspace fork identity did not match its parent activation",
        false,
      );
    }
    const captured = await this.snapshot(handle, request.requestId);
    if (captured.type !== "tool_sandbox.captured") {
      throw new ToolBrokerError(
        "workspace_fork_capture_invalid",
        "Parent Workspace did not produce an isolated fork boundary",
        true,
      );
    }
    const source = parsePersistentVolumeReference(decodeWorkspaceSnapshotBlob(captured.workspace));
    if (source === undefined) {
      throw new ToolBrokerError(
        "workspace_fork_capture_invalid",
        "Parent Workspace fork boundary was invalid",
        false,
      );
    }
    const targetVolumeId = workspaceVolumeId(request.target);
    try {
      await this.#client.ensureVolume(targetVolumeId, "picloud-posix");
      const forked = await this.#workspaceVolumeGateway.fork({
        tenantId: request.target.tenantId,
        sourceWorkspaceId: handle.assignment.workspaceId,
        sourceSessionId: handle.assignment.sessionId,
        sourceVolumeId: source.volumeId,
        expectedSourceRevision: source.volumeRevision,
        targetWorkspaceId: request.target.workspaceId,
        targetSessionId: request.target.sessionId,
        targetVolumeId,
      });
      const sourceHandle = await this.rebind(handle, handle.assignment);
      return {
        sourceHandle,
        sourceRevision: forked.sourceRevision,
        targetRevision: forked.volumeRevision,
      };
    } catch (error: unknown) {
      const activation = this.#activations.get(handle.activationId);
      if (activation?.state === "idle") {
        await this.rebind(handle, handle.assignment).catch(() => undefined);
      }
      throw error;
    }
  }

  async stop(handle: SandboxHandle): Promise<void> {
    await this.destroy(handle);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    this.#assertHandle(handle);
    const instance = await this.#client.read(handle.runtimeName);
    if (instance === undefined) {
      this.#activations.delete(handle.activationId);
      return;
    }
    if (
      runtimeUuid(instance.sandboxId) !== handle.runtimeId ||
      !metadataMatchesPhysicalBinding(
        instance.metadata,
        handle.activationId,
        handle.assignment,
        physicalBindingSha256(handle.activationId, handle.assignment, handle.environment),
        handle.environment.imageRevision,
      )
    ) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox handle identity did not match",
        false,
      );
    }
    await this.#client.destroy(instance.sandboxId);
    this.#activations.delete(handle.activationId);
  }

  async inspect(handle: SandboxHandle): Promise<SandboxInspection> {
    this.#assertHandle(handle);
    const instance = await this.#client.read(handle.runtimeName);
    if (instance === undefined) {
      return {
        providerApiVersion: 1,
        providerId: this.providerId,
        state: "absent",
        handle,
      };
    }
    if (
      runtimeUuid(instance.sandboxId) !== handle.runtimeId ||
      !metadataMatchesPhysicalBinding(
        instance.metadata,
        handle.activationId,
        handle.assignment,
        physicalBindingSha256(handle.activationId, handle.assignment, handle.environment),
        handle.environment.imageRevision,
      )
    ) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox inspection identity did not match",
        false,
      );
    }
    const activation = this.#activations.get(handle.activationId);
    const evidence = activation?.evidence ?? (await this.#waitForEvidence(instance));
    return {
      providerApiVersion: 1,
      providerId: this.providerId,
      state: instance.state === "running" ? "running" : "stopped",
      handle,
      effectiveIsolation: effectiveIsolation(evidence, this.defaultPolicy),
    };
  }

  async materializeFile(
    request: ToolBrokerMaterializeFileRequest,
    signal?: AbortSignal,
  ): Promise<ToolBrokerMaterializeFileResponse> {
    const snapshotBytes = decodeWorkspaceSnapshotBlob(request.snapshot);
    const volume = parsePersistentVolumeReference(snapshotBytes);
    if (volume !== undefined) {
      if (volume.tenantId !== request.tenantId || volume.workspaceId !== request.workspaceId) {
        throw new ToolBrokerError(
          "cubesandbox_volume_reference_invalid",
          "Persistent Workspace Volume reference did not match the requested Workspace",
          false,
        );
      }
      const expected = volume.files.find((file) => file.path === request.path);
      if (expected === undefined) {
        throw new ToolBrokerError(
          "workspace_file_not_found",
          "Workspace file was not found",
          false,
        );
      }
      if (signal?.aborted) {
        throw new ToolBrokerError(
          "snapshot_materialization_cancelled",
          "Workspace file materialization was cancelled",
          false,
        );
      }
      const materialized = await this.#workspaceVolumeGateway.materialize({
        tenantId: volume.tenantId,
        workspaceId: volume.workspaceId,
        sessionId: volume.sourceSessionId,
        volumeId: volume.volumeId,
        path: request.path,
        expectedSha256: expected.sha256,
        maximumBytes: Math.max(1, expected.sizeBytes),
      });
      if (
        signal?.aborted ||
        materialized.bytes.byteLength !== expected.sizeBytes ||
        materialized.sha256 !== expected.sha256
      ) {
        throw new ToolBrokerError(
          signal?.aborted
            ? "snapshot_materialization_cancelled"
            : "cubesandbox_volume_materialization_invalid",
          signal?.aborted
            ? "Workspace file materialization was cancelled"
            : "Persistent Workspace file did not match the selected revision",
          false,
        );
      }
      return {
        toolBrokerProtocolVersion: 1,
        type: "workspace.file_materialized",
        requestId: request.requestId,
        tenantId: request.tenantId,
        workspaceId: request.workspaceId,
        path: request.path,
        content: Buffer.from(materialized.bytes).toString("base64"),
        sha256: expected.sha256,
        executable: expected.executable,
        sizeBytes: expected.sizeBytes,
      };
    }
    throw new ToolBrokerError(
      "cubesandbox_volume_reference_unsupported",
      "CubeSandbox accepts only the current persistent Workspace Volume reference",
      false,
    );
  }

  async destroyActivation(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const activation = this.#activations.get(activationId);
    if (activation !== undefined) {
      if (!sameAssignment(activation.handle.assignment, assignment)) {
        throw new ToolBrokerError(
          "tool_sandbox_identity_mismatch",
          "CubeSandbox assignment identity did not match",
          false,
        );
      }
      await this.destroy(activation.handle);
      return;
    }
    const matches = (await this.#client.list()).filter((instance) =>
      metadataMatchesOrphanIdentity(instance.metadata, activationId, assignment),
    );
    if (matches.length > 1) {
      throw new ToolBrokerError(
        "cubesandbox_inventory_ambiguous",
        "CubeSandbox activation inventory was ambiguous",
        false,
      );
    }
    if (matches[0] !== undefined) await this.#client.destroy(matches[0].sandboxId);
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    bounded(sandboxId, "Sandbox inventory ID", 512);
    const output: SupervisorRuntimeAssignment[] = [];
    for (const instance of await this.#client.list()) {
      const managed = [...this.#activations.values()].find(
        (activation) => activation.instance.sandboxId === instance.sandboxId,
      );
      const assignment = managed?.handle.assignment ?? assignmentFromMetadata(instance);
      if (assignment !== undefined && assignment.sandboxId === sandboxId) {
        output.push(supervisorAssignment(instance, assignment));
      }
    }
    return output;
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const instance = await this.#client.read(assignment.containerName);
    if (instance === undefined) return;
    const managed = [...this.#activations.values()].find(
      (activation) => activation.instance.sandboxId === instance.sandboxId,
    );
    const current = managed?.handle.assignment ?? assignmentFromMetadata(instance);
    if (current === undefined || !sameRuntimeAssignment(instance, current, assignment)) {
      throw new ToolBrokerError(
        "cubesandbox_assignment_identity_mismatch",
        "CubeSandbox termination identity did not match",
        false,
      );
    }
    await this.#client.destroy(instance.sandboxId);
    for (const [activationId, active] of this.#activations) {
      if (active.instance.sandboxId === instance.sandboxId) {
        this.#activations.delete(activationId);
      }
    }
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    const instance = await this.#client.read(assignment.containerName);
    if (instance !== undefined && runtimeUuid(instance.sandboxId) === assignment.containerId) {
      throw new ToolBrokerError(
        "cubesandbox_assignment_still_alive",
        "CubeSandbox absence could not be confirmed",
        false,
      );
    }
  }

  async close(): Promise<void> {
    const instances = [...this.#activations.values()].map((activation) => activation.instance);
    this.#activations.clear();
    await Promise.allSettled(instances.map((instance) => this.#client.destroy(instance.sandboxId)));
    await Promise.all([this.#client.close(), this.#workspaceVolumeGateway.close()]);
  }

  async #probeRuntime(): Promise<void> {
    const instance = await this.#client.create({
      templateId: this.#templateId,
      timeoutSeconds: 60,
      metadata: {
        [METADATA.managed]: "true",
        [METADATA.provider]: this.providerId,
        [METADATA.workload]: "runtime-probe",
        [METADATA.imageRevision]: this.#imageRevision,
      },
      allowInternetAccess: true,
      allowPublicTraffic: false,
    });
    try {
      this.#assertEvidence(await this.#waitForEvidence(instance), this.defaultPolicy);
    } finally {
      await this.#client.destroy(instance.sandboxId);
    }
  }

  async #waitForEvidence(instance: CubeSandboxInstance): Promise<CubeRuntimeEvidence> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = record(
          await this.#guestJson(
            instance,
            { mode: "evidence" },
            {
              program: "control",
              runAsToolUser: true,
              timeoutMs: Math.min(5_000, this.#readyTimeoutMs),
            },
          ),
          "CubeSandbox evidence",
        );
        return parseEvidence(response.evidence);
      } catch (error: unknown) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    void lastError;
    throw new ToolBrokerError(
      "cubesandbox_data_plane_unavailable",
      "CubeSandbox Tool data plane did not become ready",
      true,
    );
  }

  #assertEvidence(evidence: CubeRuntimeEvidence, policy: SandboxPolicy): void {
    if (
      evidence.controlProtocolVersion !== 2 ||
      evidence.imageRevision !== this.#imageRevision ||
      evidence.uid !== 1_000 ||
      evidence.gid !== 1_000 ||
      evidence.supervisorUid !== 0 ||
      evidence.supervisorGid !== 0 ||
      evidence.cpuCount * 1_000_000_000 < policy.resources.cpuNano ||
      evidence.memoryBytes < Math.floor(policy.resources.memoryBytes * 0.9) ||
      !evidence.hypervisorFlag ||
      !evidence.noNewPrivileges ||
      !/^0+$/.test(evidence.effectiveCapabilities) ||
      evidence.readOnlyRootFilesystem
    ) {
      throw new ToolBrokerError(
        "cubesandbox_isolation_mismatch",
        "CubeSandbox runtime evidence did not satisfy the required policy",
        false,
      );
    }
  }

  async #owned(handle: SandboxHandle): Promise<CubeActivation> {
    this.#assertHandle(handle);
    const activation = this.#activations.get(handle.activationId);
    if (
      activation === undefined ||
      activation.handle.runtimeId !== handle.runtimeId ||
      activation.handle.runtimeName !== handle.runtimeName ||
      !sameAssignment(activation.handle.assignment, handle.assignment)
    ) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox handle identity did not match",
        false,
      );
    }
    const current = await this.#client.read(handle.runtimeName);
    if (
      current === undefined ||
      runtimeUuid(current.sandboxId) !== handle.runtimeId ||
      !metadataMatchesPhysicalBinding(
        current.metadata,
        handle.activationId,
        handle.assignment,
        activation.bindingSha256,
        activation.evidence.imageRevision,
      )
    ) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox runtime identity did not match",
        false,
      );
    }
    return activation;
  }

  #assertHandle(handle: SandboxHandle): void {
    if (
      handle.providerApiVersion !== 1 ||
      handle.providerId !== this.providerId ||
      handle.workspaceRoot.length < 1 ||
      handle.workspaceRoot.length > 4_096 ||
      !handle.workspaceRoot.startsWith("/") ||
      /[\u0000-\u001f\u007f]/u.test(handle.workspaceRoot) ||
      handle.runtimeId !== runtimeUuid(handle.runtimeName)
    ) {
      throw new ToolBrokerError(
        "tool_sandbox_identity_mismatch",
        "CubeSandbox handle shape did not match",
        false,
      );
    }
  }
}
