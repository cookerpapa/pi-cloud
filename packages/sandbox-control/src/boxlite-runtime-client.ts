import { Agent, request } from "undici";
import { WebSocket, createWebSocketStream } from "ws";
import { Readable, type Duplex } from "node:stream";
import {
  parseExecutionLogPosition,
  parseGuestProbeReply,
  type GuestProbeReply,
} from "@pi-cloud/protocol";
import {
  BOXLITE_NODE_PATH,
  BOXLITE_NODE_PROTOCOL_VERSION,
  type BoxLiteInstance,
} from "./boxlite-node-contract.ts";
import {
  GuestExecutionRejected,
  SandboxRuntimeClientError,
  SandboxRuntimeTransportError,
  type GuestRuntimeClient,
  type GuestRuntimeCreateInput,
  type GuestCommandRequest,
  type GuestCommandResult,
  type GuestToolHandoff,
  type GuestTerminal,
} from "./guest-runtime-client.ts";
import type { SandboxExecutionTarget } from "./sandbox-execution.ts";

/** The native SDK stays in the trusted node. This transport has no model,
 * execution-lease query or automatic mutation retry. */
export class BoxLiteRuntimeClient implements GuestRuntimeClient<BoxLiteInstance> {
  readonly #http = new Agent();
  readonly #instances = new Map<string, BoxLiteInstance>();
  readonly #streams = new Set<WebSocket>();
  readonly #base: string;
  constructor(
    readonly options: {
      url: string;
      token: string;
      nodeId: string;
    },
  ) {
    const url = new URL(options.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid BoxLite node endpoint");
    this.#base = url.toString().replace(/\/$/, "");
  }
  async #request(
    path: string,
    method: "GET" | "POST" | "PUT" = "GET",
    body?: unknown,
    signal?: AbortSignal,
    bytes?: number,
  ) {
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(this.#base + path, {
        method,
        dispatcher: this.#http,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined
            ? {}
            : {
                "content-type":
                  bytes === undefined ? "application/json" : "application/octet-stream",
                ...(bytes === undefined ? {} : { "content-length": String(bytes) }),
              }),
        },
        ...(body === undefined
          ? {}
          : {
              body:
                bytes === undefined
                  ? JSON.stringify(body)
                  : Readable.from(body as AsyncIterable<Uint8Array>, { objectMode: false }),
            }),
        signal: signal ?? AbortSignal.timeout(60000),
        headersTimeout: 60000,
        bodyTimeout: 60000,
      });
    } catch (error) {
      throw new SandboxRuntimeTransportError(error);
    }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 128 * 1024 * 1024) {
          response.body.destroy();
          throw new Error("BoxLite response exceeded its bound");
        }
        chunks.push(bytes);
      }
    } catch (error) {
      throw new SandboxRuntimeTransportError(error);
    }
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw new SandboxRuntimeClientError(
        "BoxLite node request was not confirmed",
        response.statusCode,
      );
    try {
      return JSON.parse(Buffer.concat(chunks).toString()) as any;
    } catch {
      throw new SandboxRuntimeClientError("Invalid BoxLite node response");
    }
  }
  #path(id: string, suffix = "") {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new Error("Invalid BoxLite identity");
    return `${BOXLITE_NODE_PATH}/boxes/${encodeURIComponent(id)}${suffix}`;
  }
  #remember(value: BoxLiteInstance): BoxLiteInstance {
    if (
      !value ||
      value.nodeId !== this.options.nodeId ||
      typeof value.sandboxId !== "string" ||
      !value.metadata ||
      !value.attachment ||
      !value.templateId ||
      !["running", "paused", "unknown"].includes(value.state)
    )
      throw new SandboxRuntimeClientError("BoxLite native identity changed");
    const previous = this.#instances.get(value.sandboxId);
    const instance = {
      ...value,
      ...(value.connection ? {} : previous?.connection ? { connection: previous.connection } : {}),
    };
    if (this.#instances.size >= 4096 && !this.#instances.has(instance.sandboxId))
      this.#instances.delete(this.#instances.keys().next().value!);
    this.#instances.set(instance.sandboxId, instance);
    return instance;
  }
  async checkHealth() {
    const reply = await this.#request("/health/ready");
    if (
      reply.status !== "ready" ||
      reply.nodeId !== this.options.nodeId ||
      reply.protocolVersion !== BOXLITE_NODE_PROTOCOL_VERSION ||
      reply.sdkVersion !== "0.12.0"
    )
      throw new Error("BoxLite node is not ready at the pinned contract");
  }
  async create(input: GuestRuntimeCreateInput) {
    return this.#remember(await this.#request(BOXLITE_NODE_PATH + "/boxes", "POST", input));
  }
  async read(id: string) {
    const { instance } = await this.#request(this.#path(id));
    return instance === null ? undefined : this.#remember(instance);
  }
  async list() {
    const { instances } = await this.#request(BOXLITE_NODE_PATH + "/boxes");
    if (!Array.isArray(instances)) throw new Error("Invalid BoxLite inventory");
    return instances.map((value: BoxLiteInstance) => this.#remember(value));
  }
  async observe(id: string, nodeId?: string, expected?: BoxLiteInstance) {
    if (nodeId && nodeId !== this.options.nodeId)
      return {
        runtimeName: id,
        nodeId,
        presence: "unavailable" as const,
        state: "unknown" as const,
      };
    const result = await this.#request(BOXLITE_NODE_PATH + "/observe", "POST", {
      id,
      expected: expected ?? this.#instances.get(id),
    });
    if (
      result.runtimeName !== id ||
      result.nodeId !== this.options.nodeId ||
      !["present", "absent", "unavailable"].includes(result.presence)
    )
      throw new Error("BoxLite observation identity changed");
    return result as Awaited<ReturnType<GuestRuntimeClient["observe"]>>;
  }
  async pause(id: string) {
    await this.#request(this.#path(id, "/pause"), "POST", {});
  }
  async connect(id: string) {
    return this.#remember(await this.#request(this.#path(id, "/resume"), "POST", {}));
  }
  async destroy(id: string, expected?: BoxLiteInstance) {
    const instance = expected ?? this.#instances.get(id) ?? (await this.read(id));
    if (!instance) throw new Error("Recorded BoxLite deletion evidence is unavailable");
    const result = await this.#request(BOXLITE_NODE_PATH + "/delete", "POST", instance);
    if (result.confirmed !== true) throw new Error("BoxLite deletion remains unconfirmed");
    this.#instances.delete(id);
  }
  async runCommand(
    instance: BoxLiteInstance,
    input: GuestCommandRequest,
  ): Promise<GuestCommandResult> {
    const { signal, onStdout, ...command } = input;
    const result = await this.#request(
      this.#path(instance.sandboxId, "/command"),
      "POST",
      command,
      signal ?? AbortSignal.timeout(input.timeoutMs + 5000),
    );
    if (
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      !Number.isSafeInteger(result.exitCode) ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > input.maximumOutputBytes
    )
      throw new Error("BoxLite control result exceeded its contract");
    if (onStdout) {
      await onStdout(Buffer.from(result.stdout));
      result.stdout = "";
    }
    return result;
  }
  writeGuestFile(instance: BoxLiteInstance, path: string, data: Uint8Array) {
    return this.writeGuestFileStream(
      instance,
      path,
      (async function* () {
        yield data;
      })(),
      data.byteLength,
    );
  }
  async writeGuestFileStream(
    instance: BoxLiteInstance,
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    byteLength: number,
    signal?: AbortSignal,
  ) {
    const result = await this.#request(
      this.#path(instance.sandboxId, "/file") +
        `?path=${encodeURIComponent(path)}&bytes=${byteLength}`,
      "PUT",
      chunks,
      signal,
      byteLength,
    );
    if (result.confirmed !== true) throw new Error("Guest file transfer was not confirmed");
  }
  async #guest(id: string, payload: object) {
    return this.#request(this.#path(id, "/guest"), "POST", payload);
  }
  async executionTarget(
    sandboxId: string,
    nodeId: string,
    connection?: BoxLiteInstance,
  ): Promise<SandboxExecutionTarget> {
    if (nodeId !== this.options.nodeId) throw new GuestExecutionRejected("node_unavailable");
    if (connection) this.#remember(connection);
    const value = await this.#guest(sandboxId, { version: 1, action: "info" });
    if (value.runtimeBlocked === true) throw new GuestExecutionRejected("runtime_quarantined");
    if (value.version !== 1 || !/^[0-9a-f-]{36}$/.test(value.bootId))
      throw new GuestExecutionRejected("execution_unavailable");
    return { apiUrl: this.#base, sandboxId, nodeId, bootId: value.bootId };
  }
  async #callGuest(target: SandboxExecutionTarget, request: object) {
    if (target.apiUrl !== this.#base || target.nodeId !== this.options.nodeId)
      throw new GuestExecutionRejected("node_unavailable");
    const value = await this.#guest(target.sandboxId, {
      version: 1,
      bootId: target.bootId,
      ...request,
    });
    if (value.accepted === false && value.rejection === "handoff_unconfirmed")
      throw new SandboxRuntimeTransportError("Guest receipt is unknown");
    if (value.accepted === false)
      throw new GuestExecutionRejected(
        typeof value.rejection === "string" ? value.rejection : "execution_unavailable",
      );
    if (value.accepted !== true || value.bootId !== target.bootId)
      throw new SandboxRuntimeClientError("Guest acknowledgement changed");
    return value;
  }
  async submitTool(target: SandboxExecutionTarget, value: GuestToolHandoff) {
    const reply = await this.#callGuest(target, {
      action: "submit",
      operationId: value.operationId,
      scopeId: value.executionScopeId,
      writerId: value.writerId,
      source: parseExecutionLogPosition(value.source),
      payload: value.payload,
      timeoutMs: value.timeoutMs,
    });
    if (reply.operationId !== value.operationId)
      throw new SandboxRuntimeClientError("Guest operation identity changed");
  }
  async cancelTool(
    target: SandboxExecutionTarget,
    value: Parameters<GuestRuntimeClient["cancelTool"]>[1],
  ) {
    await this.#callGuest(target, {
      action: "cancel",
      operationId: value.operationId,
      scopeId: value.executionScopeId,
      writerId: value.writerId,
      source: parseExecutionLogPosition(value.source),
    });
  }
  async probeExecution(target: SandboxExecutionTarget, probeId: string): Promise<GuestProbeReply> {
    const result = parseGuestProbeReply(
      (await this.#callGuest(target, { action: "probe", probeId })).output,
    );
    if (result.probeId !== probeId) throw new Error("Guest probe identity changed");
    return result;
  }
  async submitProbe(
    target: SandboxExecutionTarget,
    request: { probeId: string; delivery: unknown },
  ) {
    await this.#callGuest(target, { action: "probe", ...request });
  }
  #stream(value: object): Promise<{ stream: Duplex; executionId?: string }> {
    const url = new URL(this.#base + BOXLITE_NODE_PATH + "/stream");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${this.options.token}` },
        handshakeTimeout: 10000,
        maxPayload: 1024 * 1024,
      });
      this.#streams.add(ws);
      ws.once("close", () => this.#streams.delete(ws));
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("BoxLite stream handoff is unconfirmed"));
      }, 30000);
      timer.unref();
      let ready = false;
      ws.once("open", () => ws.send(JSON.stringify(value)));
      ws.once("message", (data) => {
        try {
          const header = JSON.parse(data.toString()) as { ready: boolean; executionId?: string };
          if (header.ready !== true) throw new Error("BoxLite stream was refused");
          const stream = createWebSocketStream(ws);
          ready = true;
          clearTimeout(timer);
          resolve({ stream, ...(header.executionId ? { executionId: header.executionId } : {}) });
        } catch (error) {
          clearTimeout(timer);
          ws.terminate();
          reject(error);
        }
      });
      ws.once("error", (error) => {
        if (!ready) {
          clearTimeout(timer);
          reject(new SandboxRuntimeTransportError(error));
        }
      });
      ws.once("close", () => {
        if (!ready) {
          clearTimeout(timer);
          reject(new SandboxRuntimeTransportError("BoxLite stream closed before admission"));
        }
      });
    });
  }
  async openTcp(instance: BoxLiteInstance, port: number, signal?: AbortSignal): Promise<Duplex> {
    signal?.throwIfAborted();
    const { stream } = await this.#stream({ id: instance.sandboxId, kind: "tcp", port });
    const abort = () => stream.destroy(signal?.reason as Error);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    stream.once("close", () => signal?.removeEventListener("abort", abort));
    return stream;
  }
  async openProgram(instance: BoxLiteInstance, input: { script: string; cwd: string }) {
    return (await this.#stream({ id: instance.sandboxId, kind: "program", ...input, tty: false }))
      .stream;
  }
  async openTerminal(
    instance: BoxLiteInstance,
    input: { rows: number; cols: number; admin: boolean },
  ): Promise<GuestTerminal> {
    const { stream, executionId } = await this.#stream({
      id: instance.sandboxId,
      kind: "program",
      script: "exec /bin/bash -l",
      cwd: input.admin ? "/home/user" : "/workspace",
      tty: true,
      ...input,
    });
    if (!executionId) {
      stream.destroy();
      throw new Error("Native terminal identity is unavailable");
    }
    const control = (action: string, size?: { rows: number; cols: number }) =>
      this.#request(
        this.#path(instance.sandboxId, "/executions/" + encodeURIComponent(executionId)),
        "POST",
        { action, ...size },
      );
    return {
      output: stream,
      sendInput: (data) =>
        new Promise<void>((resolve, reject) =>
          stream.write(data, (error?: Error | null) => (error ? reject(error) : resolve())),
        ),
      resize: async (size) => {
        await control("resize", size);
      },
      kill: async () => {
        await control("kill");
        stream.destroy();
      },
      disconnect: () => stream.destroy(),
    };
  }
  async close() {
    for (const stream of this.#streams) stream.terminate();
    this.#streams.clear();
    await this.#http.close();
  }
}
