import {
  parsePiCloudEvent,
  parseSessionViewSnapshotResource,
  type PiCloudEvent,
  type SessionViewSnapshotResource,
} from "@pi-cloud/protocol";

const MAX_PENDING_FRAME_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_RETRY_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 5_000;

export type SessionStreamPhase = "connecting" | "live" | "reconnecting" | "failed";

export type SessionStreamStatus = {
  phase: SessionStreamPhase;
  attempt: number;
  retryInMs?: number;
  message?: string;
};

export type SseFrame = {
  event?: string;
  data: string;
  retry?: number;
};

class SessionStreamError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SessionStreamError";
    this.retryable = retryable;
  }
}

export class SseFrameParser {
  #buffer = "";
  #firstPush = true;

  push(value: string): readonly SseFrame[] {
    let chunk = value;
    if (this.#firstPush) {
      this.#firstPush = false;
      if (chunk.startsWith("\uFEFF")) chunk = chunk.slice(1);
    }
    this.#buffer += chunk;
    if (new TextEncoder().encode(this.#buffer).byteLength > MAX_PENDING_FRAME_BYTES) {
      throw new SessionStreamError("SSE frame exceeded the browser buffer limit", false);
    }

    const frames: SseFrame[] = [];
    let boundary = /\r?\n\r?\n/.exec(this.#buffer);
    while (boundary !== null) {
      const raw = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary[0].length);
      const frame = parseFrame(raw);
      if (frame !== undefined) frames.push(frame);
      boundary = /\r?\n\r?\n/.exec(this.#buffer);
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let retry: number | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    if (field === "event") event = value;
    if (field === "retry" && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) retry = parsed;
    }
  }
  if (data.length === 0) return undefined;
  return {
    data: data.join("\n"),
    ...(event === undefined ? {} : { event }),
    ...(retry === undefined ? {} : { retry }),
  };
}

type FetchImplementation = typeof fetch;

export type StreamSessionEventsOptions = {
  sessionId: string;
  signal: AbortSignal;
  onSnapshot(snapshot: SessionViewSnapshotResource): void;
  onEvent(event: PiCloudEvent): void;
  onStatus(status: SessionStreamStatus): void;
  fetchImplementation?: FetchImplementation;
  retryDelayMs?: number;
  authorizationToken?: string;
};

function retryDelay(baseDelay: number, attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, baseDelay * 2 ** Math.min(attempt - 1, 4));
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    const onAbort = (): void => settle();
    function settle(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function consumeResponse(
  response: Response,
  options: StreamSessionEventsOptions,
): Promise<{ retryMs?: number }> {
  if (response.body === null) {
    throw new SessionStreamError("SSE response did not include a body", true);
  }
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let serverRetryMs: number | undefined;
  let snapshotReceived = false;
  try {
    while (!options.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        if (frame.retry !== undefined) serverRetryMs = frame.retry;
        let value: unknown;
        try {
          value = JSON.parse(frame.data) as unknown;
        } catch {
          throw new SessionStreamError("SSE frame contained malformed JSON", false);
        }
        if (frame.event === "session.snapshot") {
          const snapshot = parseSessionViewSnapshotResource(value);
          if (snapshot.conversation.session.sessionId !== options.sessionId) {
            throw new SessionStreamError("SSE snapshot belongs to a different Session", false);
          }
          options.onSnapshot(snapshot);
          snapshotReceived = true;
          options.onStatus({ phase: "live", attempt: 0 });
          continue;
        }
        if (!snapshotReceived) {
          throw new SessionStreamError("SSE live event arrived before its Session snapshot", false);
        }
        const event = parsePiCloudEvent(value);
        if (event.sessionId !== options.sessionId || frame.event !== event.type) {
          throw new SessionStreamError("SSE event identity is invalid", false);
        }
        options.onEvent(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return serverRetryMs === undefined ? {} : { retryMs: serverRetryMs };
}

export async function streamSessionEvents(options: StreamSessionEventsOptions): Promise<void> {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const baseRetryDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(baseRetryDelay) || baseRetryDelay < 0) {
    throw new TypeError("retryDelayMs must be a non-negative safe integer");
  }
  let attempt = 0;
  let serverRetryMs: number | undefined;

  while (!options.signal.aborted) {
    options.onStatus({ phase: attempt === 0 ? "connecting" : "reconnecting", attempt });
    try {
      const response = await fetchImplementation(
        `/v1/sessions/${encodeURIComponent(options.sessionId)}/events`,
        {
          method: "GET",
          credentials: "same-origin",
          headers: {
            accept: "text/event-stream",
            ...(options.authorizationToken === undefined
              ? {}
              : { authorization: `Bearer ${options.authorizationToken}` }),
          },
          cache: "no-store",
          signal: options.signal,
        },
      );
      if (!response.ok) {
        throw new SessionStreamError(
          `SSE request failed with HTTP ${String(response.status)}`,
          true,
        );
      }
      let result: Awaited<ReturnType<typeof consumeResponse>>;
      try {
        result = await consumeResponse(response, options);
      } catch (error: unknown) {
        if (error instanceof SessionStreamError) throw error;
        throw new SessionStreamError(
          error instanceof Error ? error.message : "SSE stream violated the Session protocol",
          false,
        );
      }
      serverRetryMs = result.retryMs ?? serverRetryMs;
      if (options.signal.aborted) return;
      attempt += 1;
    } catch (error: unknown) {
      if (options.signal.aborted) return;
      if (
        error instanceof SessionStreamError ||
        (typeof error === "object" && error !== null && "retryable" in error)
      ) {
        const failure = error as Error & { retryable: boolean };
        if (!failure.retryable) {
          options.onStatus({ phase: "failed", attempt, message: failure.message });
          throw failure;
        }
      }
      attempt += 1;
    }
    const delayMs = serverRetryMs ?? retryDelay(baseRetryDelay, attempt);
    options.onStatus({ phase: "reconnecting", attempt, retryInMs: delayMs });
    await wait(delayMs, options.signal);
  }
}
