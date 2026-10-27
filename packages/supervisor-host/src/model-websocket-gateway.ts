import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { parseModelSocketRequest, type ModelSamplingIdentity } from "@pi-cloud/protocol";

export type ModelSocketGrant = {
  upstreamUrl: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  admit(body: Record<string, unknown>): void;
  reserve(bytes: number): () => void;
  observe(
    sampling: ModelSamplingIdentity,
    timing: Record<string, number | boolean | string | null>,
  ): void;
  release(): void;
};
const MAX_REQUEST = 128 * 1024 * 1024;
const MAX_RESPONSE = 64 * 1024 * 1024;
const bytes = (value: RawData) =>
  Array.isArray(value) ? Buffer.concat(value) : Buffer.isBuffer(value) ? value : Buffer.from(value);

/** Transport only: Pi owns context/deltas; CLIProxyAPI owns provider credentials.
 * No transcript, previous-response map, request retry or native settlement here. */
export class ModelWebSocketGateway {
  readonly #server: WebSocketServer;
  readonly #connections = new Set<() => void>();
  constructor(
    readonly authorize: (request: IncomingMessage) => ModelSocketGrant,
    readonly connectTimeoutMs: number,
    readonly limits = { requestBytes: MAX_REQUEST, responseBytes: MAX_RESPONSE },
  ) {
    if (
      ![limits.requestBytes, limits.responseBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error("Invalid model transport byte limits");
    this.#server = new WebSocketServer({
      noServer: true,
      maxPayload: limits.requestBytes + 4096,
      perMessageDeflate: false,
    });
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let grant: ModelSocketGrant;
    try {
      grant = this.authorize(request);
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(grant.upstreamUrl, {
        headers: grant.headers,
        handshakeTimeout: this.connectTimeoutMs,
        maxPayload: this.limits.responseBytes,
        perMessageDeflate: false,
      });
    } catch {
      grant.release();
      socket.destroy();
      return;
    }
    const openedAt = performance.now();
    let client: WebSocket | undefined,
      closed = false,
      rejecting = false,
      requestCount = 0;
    let releaseUpload: (() => void) | undefined;
    let current:
      | {
          sampling: ModelSamplingIdentity;
          started: number;
          timing: Record<string, number | boolean | string | null>;
          responseBytes: number;
        }
      | undefined;
    const finish = (completed: boolean) => {
      const sample = current;
      current = undefined;
      releaseUpload?.();
      releaseUpload = undefined;
      if (sample)
        grant.observe(sample.sampling, {
          ...sample.timing,
          responseBytes: sample.responseBytes,
          elapsedMs: performance.now() - sample.started,
          transportCompleted: completed,
        });
    };
    const close = () => {
      if (closed) return;
      closed = true;
      finish(false);
      this.#connections.delete(close);
      grant.signal.removeEventListener("abort", close);
      socket.off("close", close);
      upstream.terminate();
      client?.terminate();
      if (!client) socket.destroy();
      grant.release();
    };
    const rejectFrame = (code: string, status = 400) => {
      if (closed || rejecting) return;
      rejecting = true;
      const frame = JSON.stringify({
        type: "error",
        status,
        error: {
          type: status >= 500 ? "server_error" : "invalid_request_error",
          code,
          message: "Model Gateway request failed",
        },
      });
      client?.send(frame, () => close());
      if (!client) close();
    };
    this.#connections.add(close);
    socket.on("close", close);
    socket.on("error", close);
    grant.signal.addEventListener("abort", close, { once: true });
    if (grant.signal.aborted) {
      close();
      return;
    }
    upstream.on("error", () => {
      // Rejecting the upgrade allows Pi's native HTTP fallback before any input
      // has been sent upstream. Do not manufacture a successful connection.
      if (!client && !socket.destroyed)
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      else close();
    });
    upstream.on("close", (code, reason) => {
      if (current) current.timing.upstreamCloseCode = code;
      // Preserve usable provider close codes (notably 1009) for Pi's native
      // transport handling. Ownership cancellation still terminates immediately.
      if (
        !closed &&
        client?.readyState === WebSocket.OPEN &&
        code >= 1000 &&
        code < 5000 &&
        ![1004, 1005, 1006, 1015].includes(code)
      ) {
        rejecting = true;
        client.close(code, reason);
      } else close();
    });
    upstream.on("open", () => {
      if (closed || grant.signal.aborted) {
        close();
        return;
      }
      const connectMs = performance.now() - openedAt;
      try {
        this.#server.handleUpgrade(request, socket, head, (peer) => {
          client = peer;
          if (closed || grant.signal.aborted) {
            close();
            return;
          }
          peer.on("error", close);
          peer.on("close", close);
          peer.on("message", (raw, binary) => {
            if (closed || rejecting) return;
            if (current) {
              rejectFrame("model_request_in_progress");
              return;
            }
            const started = performance.now();
            try {
              if (binary) throw new Error("Binary model requests are unsupported");
              const frameBytes = bytes(raw);
              releaseUpload = grant.reserve(frameBytes.length);
              const frame = parseModelSocketRequest(frameBytes.toString("utf8"));
              const requestBytes = Buffer.byteLength(frame.request);
              if (requestBytes > this.limits.requestBytes) {
                rejectFrame("model_request_too_large", 413);
                return;
              }
              const body = JSON.parse(frame.request) as Record<string, unknown>;
              if (!body || Array.isArray(body) || body.type !== "response.create")
                throw new Error("Expected response.create");
              grant.admit(body);
              const connectionReused = requestCount++ > 0;
              current = {
                sampling: frame.sampling,
                started,
                responseBytes: 0,
                timing: {
                  transport: "websocket",
                  receivedAtMs: Date.now(),
                  receivedMonotonicMs: started,
                  processStartedAtMs: performance.timeOrigin,
                  requestBytes,
                  incremental:
                    typeof body.previous_response_id === "string" &&
                    body.previous_response_id.length > 0,
                  connectionReused,
                  connectMs: connectionReused ? 0 : connectMs,
                  upstreamStartMs: performance.now() - started,
                  upstreamStatus: 101,
                  upstreamAttempts: 1,
                },
              };
              const sample = current,
                release = releaseUpload;
              // A second request is rejected above, never queued as work.
              upstream.send(frame.request, (error) => {
                release?.();
                if (releaseUpload === release) releaseUpload = undefined;
                if (error) close();
                else if (current === sample)
                  current.timing.requestWrittenMs = performance.now() - started;
              });
            } catch (error) {
              releaseUpload?.();
              releaseUpload = undefined;
              const failure = error as { code?: unknown; status?: unknown };
              rejectFrame(
                typeof failure?.code === "string" && /^[a-z0-9_]+$/.test(failure.code)
                  ? failure.code
                  : "model_request_rejected",
                typeof failure?.status === "number" ? failure.status : 400,
              );
            }
          });
        });
      } catch {
        close();
      }
    });
    upstream.on("message", (raw, binary) => {
      const sample = current;
      if (closed || rejecting || !client || !sample) return;
      if (binary) {
        rejectFrame("provider_frame_invalid");
        return;
      }
      const data = bytes(raw);
      sample.responseBytes += data.length;
      sample.timing.firstByteMs ??= performance.now() - sample.started;
      if (sample.responseBytes > this.limits.responseBytes) {
        rejectFrame("provider_response_too_large", 502);
        return;
      }
      let terminal = false;
      try {
        const frame = JSON.parse(data.toString("utf8")) as { type?: string };
        terminal = [
          "response.completed",
          "response.failed",
          "response.incomplete",
          "error",
        ].includes(frame.type ?? "");
        if (terminal) sample.timing.terminalEvent = frame.type!;
      } catch {
        rejectFrame("provider_frame_invalid");
        return;
      }
      upstream.pause();
      client.send(data, { binary: false }, (error) => {
        if (error) {
          close();
          return;
        }
        if (!closed) upstream.resume();
      });
      if (terminal) finish(true);
    });
  }

  close(): void {
    for (const close of [...this.#connections]) close();
    this.#server.close();
  }
}
