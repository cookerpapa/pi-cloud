import type { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { RunExecutor } from "@pi-cloud/runtime-core/run-executor";
import type { RunCancellationExecutor } from "@pi-cloud/runtime-core/run-cancellation-executor";
import { PostgresPiWorker } from "../src/postgres-pi-worker.ts";

type TestClient = EventEmitter & { ended: boolean; listening: boolean; end(): Promise<void> };
const f = vi.hoisted(() => ({
  clients: [] as TestClient[],
  failListen: false,
  holdConnect: undefined as undefined | Promise<void>,
}));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Client: class extends EventEmitter {
      ended = false;
      listening = false;
      constructor() {
        super();
        f.clients.push(this);
      }
      async connect() {
        await f.holdConnect;
      }
      async query() {
        if (f.failListen) throw new Error("LISTEN failed");
        this.listening = true;
      }
      async end() {
        this.ended = true;
        this.emit("end");
      }
    },
  };
});
beforeEach(() => {
  f.clients = [];
  f.failListen = false;
  f.holdConnect = undefined;
});
function fixture() {
  const scan = vi.fn(async () => ({ status: "idle" }));
  const worker = new PostgresPiWorker({
    database: {} as Kysely<Database>,
    notificationConnectionString: "test",
    identity: "worker",
    maximumActiveFamilies: 1,
    maximumLanesPerFamily: 4,
    pollIntervalMs: 10,
    runExecutor: { dispatchNext: scan } as unknown as RunExecutor,
    cancellationExecutor: {} as RunCancellationExecutor,
  });
  return { worker, scan };
}
it.each(["error", "end"] as const)(
  "reconnects a lost LISTEN connection after %s while queue scans progress",
  async (event) => {
    const { worker, scan } = fixture();
    await worker.start();
    let release!: () => void;
    try {
      f.holdConnect = new Promise<void>((r) => {
        release = r;
      });
      if (event === "error") f.clients[0]!.emit("error", new Error("connection lost"));
      else await f.clients[0]!.end();
      await vi.waitFor(() => expect(f.clients).toHaveLength(2), { timeout: 500 });
      const before = scan.mock.calls.length;
      await vi.waitFor(() => expect(scan.mock.calls.length).toBeGreaterThan(before), {
        timeout: 500,
      });
      release();
      await vi.waitFor(() => expect(f.clients[1]!.listening).toBe(true));
      const scans = scan.mock.calls.length;
      f.clients[1]!.emit("notification", { channel: "pi_cloud_run_queue" });
      await vi.waitFor(() => expect(scan.mock.calls.length).toBeGreaterThan(scans));
    } finally {
      release?.();
      await worker.stop();
    }
    expect(f.clients.every((c) => c.ended)).toBe(true);
  },
);
it("closes a connected client when LISTEN itself fails during startup", async () => {
  f.failListen = true;
  const { worker } = fixture();
  await expect(worker.start()).rejects.toThrow("LISTEN failed");
  expect(f.clients[0]!.ended).toBe(true);
});

it("drains a pending notification reconnect without reviving a stopped Worker", async () => {
  const { worker } = fixture();
  await worker.start();
  let release!: () => void;
  f.holdConnect = new Promise<void>((r) => {
    release = r;
  });
  f.clients[0]!.emit("error", new Error("connection lost"));
  await vi.waitFor(() => expect(f.clients).toHaveLength(2));
  const closing = worker.stop();
  release();
  await closing;
  expect(worker.state).toBe("stopped");
  expect(f.clients.every((c) => c.ended)).toBe(true);
});
