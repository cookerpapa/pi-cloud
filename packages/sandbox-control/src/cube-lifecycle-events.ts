import { createClient } from "@redis/client";

// Pinned stock Cube v0.7.3 lifecycle channel. Redis belongs to Cube, not to the
// PiCloud Session log. This adapter reads only; it never schedules or renews VMs.
export const CUBE_LIFECYCLE_STREAM = "cube:v1:shared:sandbox:lifecycle:events";
const META = "cube:v1:shared:sandbox:lifecycle:meta";
const idPattern = /^(0|[1-9][0-9]{0,15})-(0|[1-9][0-9]{0,15})$/;
export type CubeLifecycleEvent = {
  id: string;
  operation: "create" | "update" | "state" | "delete";
  sandboxId: string;
  at: number;
  payload: Record<string, unknown>;
};
export type CubeLifecyclePage = {
  epoch: string;
  first: string;
  last: string;
  next: string;
  gap: boolean;
  hasMore: boolean;
  events: CubeLifecycleEvent[];
};
export type CubeLifecycleCommand = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<unknown>;
export function compareCubeCursor(a: string, b: string): number {
  if (!idPattern.test(a) || !idPattern.test(b)) throw new Error("Invalid native lifecycle cursor");
  const x = a.split("-").map(BigInt),
    y = b.split("-").map(BigInt);
  return x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : x[1]! < y[1]! ? -1 : x[1]! > y[1]! ? 1 : 0;
}
function entries(value: unknown): Array<[string, string[]]> {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid native lifecycle page");
  for (const row of value) {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== "string" ||
      !idPattern.test(row[0]) ||
      !Array.isArray(row[1]) ||
      row[1].length > 32 ||
      row[1].length % 2 ||
      row[1].some((v: unknown) => typeof v !== "string" || v.length > 16384)
    )
      throw new Error("Invalid native lifecycle record");
  }
  return value as Array<[string, string[]]>;
}
function event([id, fields]: [string, string[]]): CubeLifecycleEvent {
  const row: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) row[fields[i]!] = fields[i + 1]!;
  if (
    !["create", "update", "state", "delete"].includes(row.op ?? "") ||
    !/^[A-Za-z0-9-]{1,128}$/.test(row.sandbox_id ?? "") ||
    !/^[0-9]{10,16}$/.test(row.ts ?? "")
  )
    throw new Error("Unknown native lifecycle record");
  const at = Number(row.ts),
    payload: unknown = row.payload ? JSON.parse(row.payload) : {};
  if (
    !Number.isSafeInteger(at) ||
    !Number.isFinite(new Date(at).valueOf()) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    throw new Error("Invalid native lifecycle payload");
  return {
    id,
    operation: row.op as CubeLifecycleEvent["operation"],
    sandboxId: row.sandbox_id!,
    at,
    payload: payload as Record<string, unknown>,
  };
}

/** Native notifications can be lost. A retained explicit delete is provider
 * evidence; absence of an event, snapshot, or heartbeat never is. */
export class CubeLifecycleEvents {
  readonly #command: CubeLifecycleCommand;
  readonly #close: () => void;
  readonly #deleted = new Map<string, CubeLifecycleEvent>();
  #cursor = "0-0";
  #epoch: string | undefined;
  #caughtUp = false;
  #refresh: Promise<void> | undefined;
  #refreshedAt = 0;
  constructor(options: { url?: string; password?: string; command?: CubeLifecycleCommand }) {
    if (options.command) {
      this.#command = options.command;
      this.#close = () => {};
      return;
    }
    if (!options.url) throw new Error("Native Cube lifecycle source is not configured");
    const parsed = new URL(options.url);
    if (!["redis:", "rediss:"].includes(parsed.protocol))
      throw new Error("Invalid native lifecycle URL");
    const client = createClient({
      url: options.url,
      ...(options.password ? { password: options.password } : {}),
      disableOfflineQueue: true,
      commandsQueueMaxLength: 128,
      socket: { connectTimeout: 3000, reconnectStrategy: false },
    });
    client.on("error", () => {}); // Never log an authenticated URL or raw connection errors.
    let connecting: Promise<unknown> | undefined;
    this.#command = async (args, signal) => {
      signal.throwIfAborted();
      if (!client.isOpen)
        connecting ??= client.connect().finally(() => {
          connecting = undefined;
        });
      await connecting;
      if (!client.isReady) throw new Error("Native lifecycle source unavailable");
      return client.sendCommand(args, { abortSignal: signal, timeout: 5000 });
    };
    this.#close = () => {
      if (client.isOpen) client.destroy();
    };
  }
  async page(after = "0-0", signal = AbortSignal.timeout(6000)): Promise<CubeLifecyclePage> {
    if (!idPattern.test(after)) throw new Error("Invalid native lifecycle cursor");
    const [info, firstRaw, lastRaw] = await Promise.all([
      this.#command(["INFO", "server"], signal),
      this.#command(["XRANGE", CUBE_LIFECYCLE_STREAM, "-", "+", "COUNT", "1"], signal),
      this.#command(["XREVRANGE", CUBE_LIFECYCLE_STREAM, "+", "-", "COUNT", "1"], signal),
    ]);
    const epoch =
      typeof info === "string" ? /^run_id:([0-9a-f]{40})\r?$/m.exec(info)?.[1] : undefined;
    if (!epoch) throw new Error("Native lifecycle source identity unavailable");
    const first = entries(firstRaw)[0]?.[0] ?? "0-0",
      last = entries(lastRaw)[0]?.[0] ?? "0-0";
    if (compareCubeCursor(after, last) > 0)
      return { epoch, first, last, next: "0-0", gap: true, hasMore: last !== "0-0", events: [] };
    const rows =
      last === "0-0"
        ? []
        : entries(
            await this.#command(
              ["XRANGE", CUBE_LIFECYCLE_STREAM, `(${after}`, last, "COUNT", "128"],
              signal,
            ),
          );
    let previous = after;
    const events = rows.map((row) => {
      if (compareCubeCursor(row[0], previous) <= 0 || compareCubeCursor(row[0], last) > 0)
        throw new Error("Native lifecycle ordering changed");
      previous = row[0];
      return event(row);
    });
    // Empty read below a previously observed tail means the source changed.
    if (!rows.length && compareCubeCursor(after, last) < 0)
      throw new Error("Native lifecycle history changed during collection");
    return {
      epoch,
      first,
      last,
      next: previous,
      gap: after === "0-0" || (first !== "0-0" && compareCubeCursor(after, first) < 0),
      hasMore: compareCubeCursor(previous, last) < 0,
      events,
    };
  }
  async metadata(
    sandboxId: string,
    signal = AbortSignal.timeout(6000),
  ): Promise<Record<string, unknown> | undefined> {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(sandboxId)) throw new Error("Invalid native Sandbox id");
    const raw = await this.#command(["HGET", META, sandboxId], signal);
    if (raw === null) return undefined;
    if (typeof raw !== "string" || raw.length > 16384)
      throw new Error("Invalid native lifecycle snapshot");
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).sandbox_id !== sandboxId
    )
      throw new Error("Native lifecycle snapshot identity changed");
    return value as Record<string, unknown>;
  }
  async deletion(sandboxId: string): Promise<CubeLifecycleEvent | undefined> {
    if (!this.#refresh && Date.now() - this.#refreshedAt > 1000) {
      this.#refresh = this.#refreshDeletes().finally(() => {
        this.#refresh = undefined;
      });
    }
    await this.#refresh;
    return this.#caughtUp ? this.#deleted.get(sandboxId) : undefined;
  }
  async #refreshDeletes() {
    this.#caughtUp = false;
    const signal = AbortSignal.timeout(6000);
    for (let i = 0; i < 32; i++) {
      const page = await this.page(this.#cursor, signal);
      if (this.#epoch !== undefined && page.epoch !== this.#epoch) {
        this.#deleted.clear();
        this.#cursor = "0-0";
        this.#epoch = page.epoch;
        continue;
      }
      this.#epoch = page.epoch;
      if (page.gap) this.#deleted.clear();
      for (const event of page.events) {
        if (event.operation === "delete") {
          if (this.#deleted.size >= 10000) this.#deleted.delete(this.#deleted.keys().next().value!);
          this.#deleted.set(event.sandboxId, event);
        } else if (event.operation === "create" || event.operation === "state")
          this.#deleted.delete(event.sandboxId);
      }
      this.#cursor = page.next;
      if (!page.hasMore) {
        this.#caughtUp = true;
        this.#refreshedAt = Date.now();
        return;
      }
    }
  }
  get position(): string {
    return this.#cursor;
  }
  close() {
    this.#close();
  }
}
