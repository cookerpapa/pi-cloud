import { Agent, buildConnector, fetch, type Dispatcher } from "undici";
import { directPrivateEgressCidrs } from "./direct-private-egress.ts";

export const CUBESANDBOX_ENVD_PORT = 49_983;
const CONNECT_PROTOCOL_VERSION = "1";
const CONNECT_CONTENT_TYPE = "application/connect+json";
const CONNECT_END_STREAM_FLAG = 0x02;
const CONNECT_COMPRESSED_FLAG = 0x01;
const MAXIMUM_CONNECT_ENVELOPE_BYTES = 64 * 1_024 * 1_024;

/**
 * Cube evaluates explicit allow entries before deny entries. PiCloud keeps a
 * deny-all fallback and admits only its egress proxy plus deployment-owned
 * direct private CIDRs.
 */
export const CUBESANDBOX_BLOCKED_EGRESS_CIDRS = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const);

export type CubeSandboxInstance = Readonly<{
  sandboxId: string;
  templateId: string;
  state: string;
  domain: string;
  metadata: Readonly<Record<string, string>>;
  trafficAccessToken?: string;
  envdAccessToken?: string;
  cpuCount?: number;
  memoryMB?: number;
}>;

export type CubeSandboxVolume = Readonly<{
  volumeId: string;
  name: string;
}>;

export type CubeSandboxCreateInput = Readonly<{
  templateId: string;
  timeoutSeconds: number;
  metadata: Readonly<Record<string, string>>;
  allowInternetAccess: true;
  allowPublicTraffic: false;
  volumeMounts?: readonly Readonly<{ name: string; path: "/workspace" | "/home/user" }>[];
  lifecycle?: Readonly<{ onTimeout: "kill" | "pause"; autoResume: boolean }>;
}>;

export type CubeSandboxGuestCommandRequest = Readonly<{
  command: string;
  cwd: string;
  user: string;
  timeoutMs: number;
  maximumOutputBytes: number;
  signal?: AbortSignal;
}>;

export type CubeSandboxGuestCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface CubeSandboxRuntimeClient {
  checkHealth(): Promise<void>;
  ensureVolume(volumeId: string, driver: string): Promise<CubeSandboxVolume>;
  deleteVolume(volumeId: string): Promise<void>;
  create(input: CubeSandboxCreateInput): Promise<CubeSandboxInstance>;
  read(sandboxId: string): Promise<CubeSandboxInstance | undefined>;
  pause(sandboxId: string): Promise<void>;
  connect(sandboxId: string, timeoutSeconds: number): Promise<CubeSandboxInstance>;
  list(): Promise<readonly CubeSandboxInstance[]>;
  destroy(sandboxId: string): Promise<void>;
  runCommand(
    instance: CubeSandboxInstance,
    input: CubeSandboxGuestCommandRequest,
  ): Promise<CubeSandboxGuestCommandResult>;
  writeGuestFile(instance: CubeSandboxInstance, path: string, data: Uint8Array): Promise<void>;
  removeGuestFile(instance: CubeSandboxInstance, path: string): Promise<void>;
  openTerminal(
    instance: CubeSandboxInstance,
    input: Readonly<{
      rows: number;
      cols: number;
      admin: boolean;
    }>,
  ): Promise<CubeSandboxTerminal>;
  close(): Promise<void>;
}

export interface CubeSandboxTerminal {
  readonly pid: number;
  readonly output: AsyncIterable<Uint8Array>;
  sendInput(data: Uint8Array): Promise<void>;
  resize(size: Readonly<{ rows: number; cols: number }>): Promise<void>;
  kill(): Promise<void>;
  disconnect(): void;
}

export type OfficialCubeSandboxRuntimeClientOptions = Readonly<{
  apiUrl: string;
  apiKey: string;
  proxyNodeIp: string;
  proxyPort: number;
  proxyScheme: "http" | "https";
  sandboxDomain: string;
  egressProxyIp: string;
  directPrivateCidrs?: readonly string[];
  requestTimeoutMs?: number;
}>;

export class CubeRuntimeClientError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "CubeRuntimeClientError";
    this.statusCode = statusCode;
  }
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CubeRuntimeClientError(`${label} was invalid`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CubeRuntimeClientError(`${label} response was invalid`);
  }
  return value as Record<string, unknown>;
}

function metadata(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return Object.freeze({});
  const candidate = record(value, "CubeSandbox metadata");
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(candidate)) {
    output[bounded(key, "CubeSandbox metadata key", 128)] = bounded(
      item,
      "CubeSandbox metadata value",
      1_024,
    );
  }
  return Object.freeze(output);
}

function validateHost(value: string, label: string): string {
  if (value.length < 1 || value.length > 253 || /[\u0000-\u0020\u007f/?#@:[\]]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function parseInstance(value: unknown, fallbackDomain: string): CubeSandboxInstance {
  const candidate = record(value, "CubeSandbox");
  const sandboxId = bounded(candidate.sandboxID, "CubeSandbox ID", 128);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,126}[A-Za-z0-9])?$/.test(sandboxId)) {
    throw new CubeRuntimeClientError("CubeSandbox ID was invalid");
  }
  const cpuCount =
    typeof candidate.cpuCount === "number" && Number.isSafeInteger(candidate.cpuCount)
      ? candidate.cpuCount
      : undefined;
  const memoryMB =
    typeof candidate.memoryMB === "number" && Number.isSafeInteger(candidate.memoryMB)
      ? candidate.memoryMB
      : undefined;
  return Object.freeze({
    sandboxId,
    templateId: bounded(candidate.templateID, "CubeSandbox template ID", 256),
    state: bounded(candidate.state ?? "running", "CubeSandbox state", 64),
    domain: validateHost(
      bounded(candidate.domain ?? fallbackDomain, "CubeSandbox domain", 253),
      "CubeSandbox domain",
    ),
    metadata: metadata(candidate.metadata),
    ...(typeof candidate.trafficAccessToken === "string"
      ? {
          trafficAccessToken: bounded(
            candidate.trafficAccessToken,
            "CubeSandbox traffic access token",
            4_096,
          ),
        }
      : {}),
    ...(typeof candidate.envdAccessToken === "string"
      ? {
          envdAccessToken: bounded(
            candidate.envdAccessToken,
            "CubeSandbox envd access token",
            4_096,
          ),
        }
      : {}),
    ...(cpuCount === undefined ? {} : { cpuCount }),
    ...(memoryMB === undefined ? {} : { memoryMB }),
  });
}

function parseVolume(value: unknown): CubeSandboxVolume {
  const candidate = record(value, "CubeSandbox volume");
  const volumeId = bounded(candidate.volumeID ?? candidate.volume_id, "CubeSandbox volume ID", 128);
  const name = bounded(candidate.name, "CubeSandbox volume name", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(volumeId) || !/^[A-Za-z0-9_-]+$/.test(name) || name !== volumeId) {
    throw new CubeRuntimeClientError("CubeSandbox volume identity was invalid");
  }
  return Object.freeze({ volumeId, name });
}

function validateApiUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("CubeSandbox API URL is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new TypeError("CubeSandbox API URL is invalid");
  }
  return parsed.toString().replace(/\/$/, "");
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError("CubeSandbox runtime numeric configuration is invalid");
  }
  return candidate;
}

async function readBoundedResponse(
  response: Awaited<ReturnType<typeof fetch>>,
  maximumBytes: number,
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new CubeRuntimeClientError("CubeSandbox response exceeded its byte limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes: Buffer, label: string): unknown {
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new CubeRuntimeClientError(`${label} response was not valid JSON`);
  }
}

function encodeConnectEnvelope(data: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(data.byteLength, 1);
  return Buffer.concat([header, data]);
}

function userAuthorization(user: string): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) {
    throw new TypeError("CubeSandbox envd user was invalid");
  }
  return `Basic ${Buffer.from(`${user}:`, "utf8").toString("base64")}`;
}

async function* connectFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ flags: number; payload: Buffer }> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let buffered = 0;
  const header = (): { flags: number; size: number } => {
    const first = chunks[0]!;
    if (first.byteLength >= 5) {
      return { flags: first.readUInt8(0), size: first.readUInt32BE(1) };
    }
    const bytes = Buffer.allocUnsafe(5);
    let offset = 0;
    for (const chunk of chunks) {
      const length = Math.min(chunk.byteLength, 5 - offset);
      chunk.copy(bytes, offset, 0, length);
      offset += length;
      if (offset === 5) break;
    }
    return { flags: bytes.readUInt8(0), size: bytes.readUInt32BE(1) };
  };
  const take = (length: number): Buffer => {
    const first = chunks[0]!;
    buffered -= length;
    if (first.byteLength >= length) {
      if (first.byteLength === length) chunks.shift();
      else chunks[0] = first.subarray(length);
      return first.subarray(0, length);
    }
    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = chunks[0]!;
      const required = length - offset;
      if (chunk.byteLength <= required) {
        chunk.copy(output, offset);
        offset += chunk.byteLength;
        chunks.shift();
      } else {
        chunk.copy(output, offset, 0, required);
        chunks[0] = chunk.subarray(required);
        offset = length;
      }
    }
    return output;
  };
  try {
    for (;;) {
      while (buffered >= 5) {
        const { flags, size } = header();
        if (size > MAXIMUM_CONNECT_ENVELOPE_BYTES) {
          throw new CubeRuntimeClientError("CubeSandbox envd frame exceeded its byte limit");
        }
        if (buffered < size + 5) break;
        take(5);
        yield { flags, payload: take(size) };
      }
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > 0) {
        if (buffered + next.value.byteLength > MAXIMUM_CONNECT_ENVELOPE_BYTES + 5) {
          throw new CubeRuntimeClientError("CubeSandbox envd stream buffer exceeded its limit");
        }
        chunks.push(Buffer.from(next.value));
        buffered += next.value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffered !== 0) {
    throw new CubeRuntimeClientError("CubeSandbox envd stream ended with a partial frame");
  }
}

function raiseConnectEnd(payload: Buffer): void {
  if (payload.byteLength === 0) return;
  const value = parseJson(payload, "CubeSandbox envd end stream");
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return;
  const details = error as Record<string, unknown>;
  const message = typeof details.message === "string" ? details.message : "envd stream failed";
  throw new CubeRuntimeClientError(
    typeof details.code === "string" ? `${details.code}: ${message}` : message,
  );
}

function exitCodeFromStatus(status: unknown): number | undefined {
  if (typeof status !== "string") return undefined;
  const exited = status.match(/(?:exit status|exited with code)\s+(-?\d+)/u);
  if (exited?.[1] !== undefined) return Number(exited[1]);
  const signal = status.match(/(?:signal|terminated by signal)\s+(\d+)/u);
  if (signal?.[1] !== undefined) return 128 + Number(signal[1]);
  return status === "exited" ? 0 : undefined;
}

function errorResponseDiagnostic(bytes: Buffer): string {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).error === "string"
    ) {
      const value = (parsed as Record<string, unknown>).error as string;
      const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      if (normalized.length > 0) return normalized.slice(0, 512);
    }
  } catch {
    // The public response remains generic; trusted logs only need a bounded
    // marker when the remote service did not return its documented envelope.
  }
  return "unstructured error response";
}

function terminalSize(value: Readonly<{ rows: number; cols: number }>): Readonly<{
  rows: number;
  cols: number;
}> {
  if (
    !Number.isSafeInteger(value.rows) ||
    !Number.isSafeInteger(value.cols) ||
    value.rows < 2 ||
    value.rows > 500 ||
    value.cols < 2 ||
    value.cols > 1_000
  ) {
    throw new TypeError("CubeSandbox PTY size was invalid");
  }
  return { rows: value.rows, cols: value.cols };
}

export class OfficialCubeSandboxRuntimeClient implements CubeSandboxRuntimeClient {
  readonly #apiUrl: string;
  readonly #apiKey: string;
  readonly #proxyScheme: "http" | "https";
  readonly #sandboxDomain: string;
  readonly #requestTimeoutMs: number;
  readonly #egressProxyIp: string;
  readonly #directPrivateCidrs: readonly string[];
  readonly #dispatcher: Dispatcher;

  constructor(options: OfficialCubeSandboxRuntimeClientOptions) {
    this.#apiUrl = validateApiUrl(options.apiUrl);
    this.#apiKey = bounded(options.apiKey, "CubeSandbox API key", 4_096);
    this.#proxyScheme = options.proxyScheme;
    const proxyPort = positiveInteger(options.proxyPort, 80, 1, 65_535);
    this.#sandboxDomain = validateHost(options.sandboxDomain, "CubeSandbox domain");
    this.#requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 30_000, 1_000, 300_000);
    this.#egressProxyIp = validateHost(options.egressProxyIp, "CubeSandbox egress proxy IP");
    this.#directPrivateCidrs = directPrivateEgressCidrs(options.directPrivateCidrs);
    const proxyNodeIp = validateHost(options.proxyNodeIp, "CubeSandbox proxy node IP");
    const baseConnect = buildConnector({ timeout: this.#requestTimeoutMs });
    this.#dispatcher = new Agent({
      connect(connection, callback) {
        const servername =
          (connection as { servername?: string }).servername ??
          (typeof connection.hostname === "string" ? connection.hostname : undefined);
        baseConnect(
          {
            ...connection,
            hostname: proxyNodeIp,
            port: String(proxyPort),
            ...(servername === undefined ? {} : { servername }),
          },
          callback,
        );
      },
    });
  }

  async checkHealth(): Promise<void> {
    const response = await this.#control("/health");
    await response.body?.cancel().catch(() => undefined);
  }

  async ensureVolume(volumeId: string, driver: string): Promise<CubeSandboxVolume> {
    const id = bounded(volumeId, "CubeSandbox volume ID", 128);
    const selectedDriver = bounded(driver, "CubeSandbox volume driver", 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(selectedDriver)) {
      throw new CubeRuntimeClientError("CubeSandbox volume request was invalid");
    }
    const encoded = encodeURIComponent(id);
    const existing = await this.#control(`/volumes/${encoded}`, {}, true);
    if (existing.status !== 404) {
      return parseVolume(
        parseJson(await readBoundedResponse(existing, 64 * 1_024), "CubeSandbox volume inspect"),
      );
    }
    await existing.body?.cancel().catch(() => undefined);
    try {
      const created = await this.#control("/volumes", {
        method: "POST",
        body: JSON.stringify({ name: id, driver: selectedDriver }),
      });
      return parseVolume(
        parseJson(await readBoundedResponse(created, 64 * 1_024), "CubeSandbox volume create"),
      );
    } catch (error: unknown) {
      // A competing activation may have created the same deterministic volume
      // after our read. Re-read and adopt only an exact identity.
      const raced = await this.#control(`/volumes/${encoded}`, {}, true);
      if (raced.status === 404) {
        await raced.body?.cancel().catch(() => undefined);
        throw error;
      }
      return parseVolume(
        parseJson(await readBoundedResponse(raced, 64 * 1_024), "CubeSandbox volume inspect"),
      );
    }
  }

  async deleteVolume(volumeId: string): Promise<void> {
    const id = bounded(volumeId, "CubeSandbox volume ID", 128);
    if (!/^pcw-[0-9a-f]{48}$/.test(id)) {
      throw new CubeRuntimeClientError("CubeSandbox volume deletion request was invalid");
    }
    const response = await this.#control(
      `/volumes/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      true,
    );
    await response.body?.cancel().catch(() => undefined);
  }

  async create(input: CubeSandboxCreateInput): Promise<CubeSandboxInstance> {
    const response = await this.#control("/sandboxes", {
      method: "POST",
      body: JSON.stringify({
        templateID: input.templateId,
        timeout: input.timeoutSeconds,
        metadata: input.metadata,
        ...(input.volumeMounts === undefined
          ? {}
          : {
              volumeMounts: input.volumeMounts.map((mount) => {
                if (
                  !/^pcw-[0-9a-f]{48}$/.test(mount.name) ||
                  !new Set(["/workspace", "/home/user"]).has(mount.path)
                ) {
                  throw new CubeRuntimeClientError("CubeSandbox volume mount was invalid");
                }
                return { name: mount.name, path: mount.path };
              }),
            }),
        allow_internet_access: true,
        network: {
          allowPublicTraffic: false,
          maskRequestHost: "localhost:${PORT}",
          allowOut: [...new Set([`${this.#egressProxyIp}/32`, ...this.#directPrivateCidrs])],
          denyOut: ["0.0.0.0/0"],
        },
        // PiCloud owns the shorter Session warm TTL and explicit destroy.
        // Cube's timeout is only the fail-safe orphan reaper. A timed-out VM
        // must not become an untracked paused guest because this provider no
        // longer reconnects physical runtimes across manager loss.
        lifecycle: {
          on_timeout: input.lifecycle?.onTimeout ?? "kill",
          auto_resume: input.lifecycle?.autoResume ?? false,
        },
      }),
    });
    const instance = parseInstance(
      parseJson(await readBoundedResponse(response, 256 * 1_024), "CubeSandbox create"),
      this.#sandboxDomain,
    );
    if (instance.trafficAccessToken === undefined) {
      await this.destroy(instance.sandboxId).catch(() => undefined);
      throw new CubeRuntimeClientError(
        "CubeSandbox did not return the required private-ingress token",
      );
    }
    return instance;
  }

  async read(sandboxId: string): Promise<CubeSandboxInstance | undefined> {
    const id = encodeURIComponent(bounded(sandboxId, "CubeSandbox ID", 256));
    const response = await this.#control(`/sandboxes/${id}`, {}, true);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return parseInstance(
      parseJson(await readBoundedResponse(response, 256 * 1_024), "CubeSandbox inspect"),
      this.#sandboxDomain,
    );
  }

  async pause(sandboxId: string): Promise<void> {
    const id = encodeURIComponent(bounded(sandboxId, "CubeSandbox ID", 256));
    try {
      const response = await this.#control(`/sandboxes/${id}/pause`, { method: "POST" });
      await response.body?.cancel().catch(() => undefined);
    } catch (error: unknown) {
      // CubeAPI currently applies its short standard-route timeout to pause,
      // while CubeMaster continues the full-VM snapshot after that HTTP 408.
      // Resolve the uncertain transport outcome from physical state instead
      // of turning a successfully paused machine into an UNKNOWN allocation.
      if (!(error instanceof CubeRuntimeClientError) || error.statusCode !== 408) throw error;
      await this.#waitForState(sandboxId, "paused");
    }
  }

  async connect(sandboxId: string, timeoutSeconds: number): Promise<CubeSandboxInstance> {
    const id = encodeURIComponent(bounded(sandboxId, "CubeSandbox ID", 256));
    const timeout = timeoutSeconds === -1 ? -1 : positiveInteger(timeoutSeconds, 900, 1, 86_400);
    const response = await this.#control(`/sandboxes/${id}/connect`, {
      method: "POST",
      body: JSON.stringify({ timeout }),
    });
    return parseInstance(
      parseJson(await readBoundedResponse(response, 256 * 1_024), "CubeSandbox connect"),
      this.#sandboxDomain,
    );
  }

  async list(): Promise<readonly CubeSandboxInstance[]> {
    const response = await this.#control("/v2/sandboxes?limit=1000");
    const body = parseJson(
      await readBoundedResponse(response, 4 * 1_024 * 1_024),
      "CubeSandbox inventory",
    );
    const values = Array.isArray(body)
      ? body
      : Array.isArray((body as { sandboxes?: unknown })?.sandboxes)
        ? (body as { sandboxes: unknown[] }).sandboxes
        : undefined;
    if (values === undefined || values.length > 1_000) {
      throw new CubeRuntimeClientError("CubeSandbox inventory response was invalid");
    }
    return values.map((value) => parseInstance(value, this.#sandboxDomain));
  }

  async destroy(sandboxId: string): Promise<void> {
    const id = encodeURIComponent(bounded(sandboxId, "CubeSandbox ID", 256));
    const response = await this.#control(`/sandboxes/${id}`, { method: "DELETE" }, true);
    await response.body?.cancel().catch(() => undefined);
  }

  async runCommand(
    instance: CubeSandboxInstance,
    input: CubeSandboxGuestCommandRequest,
  ): Promise<CubeSandboxGuestCommandResult> {
    if (
      input.command.length < 1 ||
      input.command.length > 16 * 1_024 * 1_024 ||
      /[\u0000]/u.test(input.command) ||
      !input.cwd.startsWith("/") ||
      /[\u0000-\u001f\u007f]/u.test(input.cwd)
    ) {
      throw new TypeError("CubeSandbox envd command was invalid");
    }
    const timeoutMs = positiveInteger(input.timeoutMs, 30_000, 100, 10 * 60_000);
    const maximumOutputBytes = positiveInteger(
      input.maximumOutputBytes,
      8 * 1_024 * 1_024,
      1,
      32 * 1_024 * 1_024,
    );
    const payload = encodeConnectEnvelope(
      Buffer.from(
        JSON.stringify({
          process: {
            cmd: "/bin/bash",
            args: ["--noprofile", "--norc", "-lc", input.command],
            cwd: input.cwd,
            envs: {},
          },
          stdin: false,
        }),
        "utf8",
      ),
    );
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
    const response = await this.#dataFetch(
      instance,
      CUBESANDBOX_ENVD_PORT,
      "/process.Process/Start",
      {
        headers: {
          authorization: userAuthorization(input.user),
          "content-type": CONNECT_CONTENT_TYPE,
          "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
          "connect-content-encoding": "identity",
          "connect-timeout-ms": String(timeoutMs),
        },
        body: payload,
        signal,
      },
    );
    if (!response.ok || response.body === null) {
      const bytes = await readBoundedResponse(response, 64 * 1_024);
      throw new CubeRuntimeClientError(
        `CubeSandbox envd command failed with HTTP ${response.status}: ${errorResponseDiagnostic(bytes)}`,
        response.status,
      );
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let exitCode: number | undefined;
    for await (const frame of connectFrames(response.body as ReadableStream<Uint8Array>)) {
      if ((frame.flags & CONNECT_COMPRESSED_FLAG) !== 0) {
        throw new CubeRuntimeClientError("CubeSandbox envd returned compressed output");
      }
      if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
        raiseConnectEnd(frame.payload);
        break;
      }
      const value = record(
        parseJson(frame.payload, "CubeSandbox envd process event"),
        "envd event",
      );
      const event = record(value.event, "envd process event");
      const data = record(event.data ?? {}, "envd process data");
      for (const [stream, target] of [
        [data.stdout, stdout],
        [data.stderr, stderr],
      ] as const) {
        if (stream === undefined) continue;
        if (typeof stream !== "string") {
          throw new CubeRuntimeClientError("CubeSandbox envd process output was invalid");
        }
        const chunk = Buffer.from(stream, "base64");
        if (chunk.toString("base64") !== stream) {
          throw new CubeRuntimeClientError("CubeSandbox envd process output was invalid");
        }
        bytes += chunk.byteLength;
        if (bytes > maximumOutputBytes) {
          throw new CubeRuntimeClientError("CubeSandbox envd process output exceeded its limit");
        }
        target.push(chunk);
      }
      if (event.end !== undefined && event.end !== null) {
        const end = record(event.end, "envd process end");
        const candidate = end.exitCode ?? end.exit_code ?? exitCodeFromStatus(end.status);
        if (Number.isSafeInteger(candidate)) exitCode = candidate as number;
        else if (typeof end.error === "string" && end.error.length > 0) {
          throw new CubeRuntimeClientError(`CubeSandbox envd process failed: ${end.error}`);
        }
      }
    }
    if (exitCode === undefined) {
      throw new CubeRuntimeClientError("CubeSandbox envd process ended without an exit code");
    }
    return {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode,
    };
  }

  async writeGuestFile(
    instance: CubeSandboxInstance,
    path: string,
    data: Uint8Array,
  ): Promise<void> {
    const target = this.#guestPath(path);
    const response = await this.#dataFetch(
      instance,
      CUBESANDBOX_ENVD_PORT,
      `/files?path=${encodeURIComponent(target)}&username=root`,
      {
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(data),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      },
    );
    const bytes = await readBoundedResponse(response, 64 * 1_024);
    if (!response.ok) {
      throw new CubeRuntimeClientError(
        `CubeSandbox envd file write failed with HTTP ${response.status}: ${errorResponseDiagnostic(bytes)}`,
        response.status,
      );
    }
  }

  async removeGuestFile(instance: CubeSandboxInstance, path: string): Promise<void> {
    if (
      !/^\/tmp\/pi-cloud-envd-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u.test(
        path,
      )
    ) {
      throw new TypeError("CubeSandbox temporary guest path was invalid");
    }
    const result = await this.runCommand(instance, {
      command: `/bin/rm -- ${path}`,
      cwd: "/",
      user: "root",
      timeoutMs: Math.min(this.#requestTimeoutMs, 10_000),
      maximumOutputBytes: 64 * 1_024,
    });
    if (result.exitCode !== 0) {
      throw new CubeRuntimeClientError("CubeSandbox temporary guest file could not be removed");
    }
  }

  async openTerminal(
    instance: CubeSandboxInstance,
    input: Readonly<{
      rows: number;
      cols: number;
      admin: boolean;
    }>,
  ): Promise<CubeSandboxTerminal> {
    const size = terminalSize(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    timeout.unref();
    try {
      const payload = encodeConnectEnvelope(
        Buffer.from(
          JSON.stringify({
            process: {
              cmd: input.admin ? "/bin/bash" : "/usr/bin/setpriv",
              args: input.admin
                ? ["-i", "-l"]
                : [
                    "--reuid",
                    "1000",
                    "--regid",
                    "1000",
                    "--clear-groups",
                    "--no-new-privs",
                    "/bin/bash",
                    "-i",
                    "-l",
                  ],
              cwd: input.admin ? "/root" : "/workspace",
              envs: { TERM: "xterm-256color", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
            },
            pty: { size },
          }),
          "utf8",
        ),
      );
      const response = await this.#dataFetch(
        instance,
        CUBESANDBOX_ENVD_PORT,
        "/process.Process/Start",
        {
          headers: {
            authorization: userAuthorization("root"),
            "content-type": CONNECT_CONTENT_TYPE,
            "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
            "connect-content-encoding": "identity",
          },
          body: payload,
          signal: controller.signal,
        },
      );
      if (!response.ok || response.body === null) {
        const bytes = await readBoundedResponse(response, 64 * 1_024);
        throw new CubeRuntimeClientError(
          `CubeSandbox envd PTY start failed with HTTP ${response.status}: ${errorResponseDiagnostic(bytes)}`,
          response.status,
        );
      }
      const frames = connectFrames(response.body as ReadableStream<Uint8Array>);
      const events = (async function* (): AsyncGenerator<Record<string, unknown>> {
        for await (const frame of frames) {
          if ((frame.flags & CONNECT_COMPRESSED_FLAG) !== 0) {
            throw new CubeRuntimeClientError("CubeSandbox envd returned compressed PTY output");
          }
          if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
            raiseConnectEnd(frame.payload);
            return;
          }
          const message = record(parseJson(frame.payload, "CubeSandbox envd PTY"), "envd PTY");
          if (message.event !== undefined) yield record(message.event, "envd PTY event");
        }
      })();
      const first = await events.next();
      const start = first.done ? undefined : record(first.value.start, "envd PTY start");
      if (start === undefined || !Number.isSafeInteger(start.pid) || (start.pid as number) < 1) {
        throw new CubeRuntimeClientError("CubeSandbox envd PTY stream did not begin with a PID");
      }
      clearTimeout(timeout);
      const pid = start.pid as number;
      let disconnected = false;
      let consumed = false;
      const output: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: async function* () {
          if (consumed) {
            throw new CubeRuntimeClientError("CubeSandbox PTY output can only be consumed once");
          }
          consumed = true;
          try {
            for await (const event of events) {
              const data = record(event.data ?? {}, "envd PTY data");
              if (typeof data.pty === "string") {
                const bytes = Buffer.from(data.pty, "base64");
                if (bytes.byteLength > 64 * 1_024 || bytes.toString("base64") !== data.pty) {
                  throw new CubeRuntimeClientError("CubeSandbox envd PTY output was invalid");
                }
                yield bytes;
              }
              if (event.end !== undefined) return;
            }
          } catch (error: unknown) {
            if (!disconnected) throw error;
          }
        },
      };
      const unary = async (
        method: "SendInput" | "Update" | "SendSignal",
        payload: unknown,
        allowAbsent = false,
      ): Promise<void> => {
        const result = await this.#dataFetch(
          instance,
          CUBESANDBOX_ENVD_PORT,
          `/process.Process/${method}`,
          {
            headers: {
              "content-type": "application/json",
              "connect-protocol-version": CONNECT_PROTOCOL_VERSION,
            },
            body: Buffer.from(JSON.stringify(payload), "utf8"),
            signal: AbortSignal.timeout(this.#requestTimeoutMs),
          },
        );
        const bytes = await readBoundedResponse(result, 64 * 1_024);
        if (!result.ok && !(allowAbsent && result.status === 404)) {
          throw new CubeRuntimeClientError(
            `CubeSandbox envd PTY request failed with HTTP ${result.status}: ${errorResponseDiagnostic(bytes)}`,
            result.status,
          );
        }
      };
      return Object.freeze({
        pid,
        output,
        sendInput: (data: Uint8Array) =>
          unary("SendInput", {
            process: { pid },
            input: { pty: Buffer.from(data).toString("base64") },
          }),
        resize: (next: Readonly<{ rows: number; cols: number }>) =>
          unary("Update", { process: { pid }, pty: { size: terminalSize(next) } }),
        kill: () => unary("SendSignal", { process: { pid }, signal: "SIGNAL_SIGKILL" }, true),
        disconnect: () => {
          disconnected = true;
          controller.abort();
          void events.return(undefined).catch(() => undefined);
        },
      });
    } catch (error: unknown) {
      clearTimeout(timeout);
      controller.abort();
      if (error instanceof CubeRuntimeClientError) throw error;
      throw new CubeRuntimeClientError(
        `CubeSandbox envd PTY start failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  async #dataFetch(
    instance: CubeSandboxInstance,
    port: number,
    path: string,
    input: Readonly<{
      method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
      headers?: Readonly<Record<string, string>>;
      body?: Uint8Array;
      signal: AbortSignal;
    }>,
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    const token = instance.trafficAccessToken;
    if (token === undefined) {
      throw new CubeRuntimeClientError("CubeSandbox private-ingress token was unavailable");
    }
    const host = `${String(port)}-${instance.sandboxId}.${instance.domain}`;
    return fetch(`${this.#proxyScheme}://${host}${path}`, {
      method: input.method ?? "POST",
      headers: {
        "e2b-traffic-access-token": token,
        "cube-traffic-access-token": token,
        ...(port !== CUBESANDBOX_ENVD_PORT || instance.envdAccessToken === undefined
          ? {}
          : { "x-access-token": instance.envdAccessToken }),
        ...(input.headers ?? {}),
      },
      ...(input.body === undefined ? {} : { body: Buffer.from(input.body) }),
      dispatcher: this.#dispatcher,
      signal: input.signal,
    });
  }

  async close(): Promise<void> {
    await this.#dispatcher.close();
  }

  #guestPath(path: string): string {
    if (
      path.length < 1 ||
      path.length > 4_096 ||
      !path.startsWith("/") ||
      /[\u0000-\u001f\u007f]/u.test(path)
    ) {
      throw new TypeError("CubeSandbox guest path was invalid");
    }
    return path;
  }

  async #waitForState(sandboxId: string, expectedState: string): Promise<void> {
    const deadline = Date.now() + this.#requestTimeoutMs;
    for (;;) {
      const current = await this.read(sandboxId);
      if (current === undefined) {
        throw new CubeRuntimeClientError(
          `CubeSandbox disappeared while waiting for ${expectedState}`,
        );
      }
      if (current.state.toLowerCase() === expectedState) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CubeRuntimeClientError(
          `CubeSandbox did not reach ${expectedState} after an uncertain lifecycle response`,
          408,
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(1_000, remaining)));
    }
  }

  async #control(
    path: string,
    init: { method?: "GET" | "POST" | "DELETE"; body?: string } = {},
    allowNotFound = false,
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      await response.body?.cancel().catch(() => undefined);
      throw new CubeRuntimeClientError(
        `CubeSandbox API request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return response;
  }
}
