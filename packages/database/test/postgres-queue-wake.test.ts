import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
import { PostgresNotificationWake, PostgresQueueWake } from "../src/postgres-queue-wake.ts";

type TestClient = EventEmitter & { ended: boolean; listening: boolean; end(): Promise<void> };
const f = vi.hoisted(() => ({
  clients: [] as TestClient[],
  connect: undefined as Promise<void> | undefined,
  fail: false,
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
        await f.connect;
      }
      async query() {
        if (f.fail) throw Error("private connection details");
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
  f.connect = undefined;
  f.fail = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("remembers a hint during an empty scan and wakes a waiting loop", async () => {
  const wake = new PostgresQueueWake(),
    abort = new AbortController(),
    generation = wake.generation;
  wake.notify();
  await wake.wait(generation, 10000, abort.signal);
  const waiting = wake.wait(wake.generation, 10000, abort.signal);
  wake.notify();
  await waiting;
  const stopping = wake.wait(wake.generation, 10000, abort.signal);
  abort.abort();
  await stopping;
});
it.each(["error", "end"])(
  "reconnects after %s with one bounded listener and a post-LISTEN scan",
  async (event) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const wake = new PostgresNotificationWake("private-uri", "terminal_test");
    try {
      wake.refresh();
      wake.refresh();
      await vi.waitFor(() => expect(wake.generation).toBe(1));
      expect(f.clients).toHaveLength(1);
      f.clients[0]!.emit("notification", { channel: "other" });
      expect(wake.generation).toBe(1);
      f.clients[0]!.emit("notification", { channel: "terminal_test" });
      expect(wake.generation).toBe(2);
      f.clients[0]!.emit(event, Error("lost"));
      wake.refresh();
      expect(f.clients).toHaveLength(1);
      now = 1001;
      wake.refresh();
      await vi.waitFor(() => expect(f.clients[1]?.listening).toBe(true));
      expect(wake.generation).toBe(4);
      expect(f.clients[0]!.ended).toBe(true);
    } finally {
      await wake.close();
    }
    expect(f.clients.every((c) => c.ended)).toBe(true);
  },
);
it("closes a failed LISTEN without leaking credentials, and closes during pending connect", async () => {
  f.fail = true;
  const failed = new PostgresNotificationWake("private-uri", "terminal_test");
  failed.refresh();
  await vi.waitFor(() => expect(f.clients[0]?.ended).toBe(true));
  await failed.close();
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private");
  f.fail = false;
  const hold = Promise.withResolvers<void>();
  f.connect = hold.promise;
  const stopping = new PostgresNotificationWake("private-uri", "terminal_test");
  stopping.refresh();
  const closing = stopping.close();
  hold.resolve();
  await closing;
  expect(f.clients[1]!.ended).toBe(true);
  expect(f.clients[1]!.listening).toBe(false);
  stopping.refresh();
  expect(f.clients).toHaveLength(2);
});
