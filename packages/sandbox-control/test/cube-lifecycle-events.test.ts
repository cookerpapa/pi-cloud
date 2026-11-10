import { describe, it, expect, vi } from "vitest";
import {
  CubeLifecycleEvents,
  CUBE_LIFECYCLE_STREAM,
  compareCubeCursor,
} from "../src/cube-lifecycle-events.ts";

function fixture() {
  const state = {
    epoch: "a".repeat(40),
    rows: [] as Array<[string, string[]]>,
    metadata: null as unknown,
    offline: false,
  };
  const command = vi.fn(async (args: readonly string[]) => {
    if (state.offline) throw new Error("source unavailable");
    if (args[0] === "INFO") return `run_id:${state.epoch}\r\n`;
    if (args[0] === "HGET") return state.metadata;
    expect(args[1]).toBe(CUBE_LIFECYCLE_STREAM);
    if (args[0] === "XREVRANGE") return state.rows.slice(-1).reverse();
    if (args[0] === "XRANGE")
      return state.rows
        .filter(
          ([id]) =>
            (args[2] === "-" || compareCubeCursor(id, args[2]!.slice(1)) > 0) &&
            (args[3] === "+" || compareCubeCursor(id, args[3]!) <= 0),
        )
        .slice(0, Number(args[5]));
    throw new Error("Unexpected native lifecycle command");
  });
  const add = (id: string, operation: string, sandboxId = "vm-one", payload = {}) => {
    state.rows.push([
      id,
      [
        "op",
        operation,
        "sandbox_id",
        sandboxId,
        "ts",
        "1794350000000",
        "payload",
        JSON.stringify(payload),
      ],
    ]);
  };
  return { state, command, add, reader: new CubeLifecycleEvents({ command }) };
}

describe("stock Cube lifecycle evidence", () => {
  it("requires an explicit retained delete, never a missing snapshot or an empty stream", async () => {
    const f = fixture();
    expect(await f.reader.deletion("vm-one")).toBeUndefined();
    expect(await f.reader.metadata("vm-one")).toBeUndefined();
    f.reader.close();
    f.add("100-0", "create");
    f.add("101-0", "delete");
    const next = new CubeLifecycleEvents({ command: f.command });
    expect(await next.deletion("vm-one")).toMatchObject({ operation: "delete", id: "101-0" });
    expect(await next.deletion("vm-two")).toBeUndefined();
  });
  it("catches up past multiple bounded pages before returning a deletion", async () => {
    const f = fixture();
    f.add("100-0", "delete");
    for (let i = 101; i < 300; i++) f.add(`${i}-0`, "update", "another-vm");
    f.add("300-0", "state", "vm-one", { state: "running" });
    expect(await f.reader.deletion("vm-one")).toBeUndefined();
    expect(
      f.command.mock.calls.filter(([args]) => args[0] === "XRANGE" && args[2] !== "-"),
    ).toHaveLength(2);
  });
  it("reports trimming and cursor rollback instead of inventing complete history", async () => {
    const f = fixture();
    f.add("100-0", "create");
    f.add("200-0", "delete");
    expect(await f.reader.page("50-0")).toMatchObject({ gap: true, next: "200-0" });
    expect(await f.reader.page("300-0")).toMatchObject({
      gap: true,
      next: "0-0",
      hasMore: true,
      events: [],
    });
  });
  it("does not retain a previous positive answer through a source restart", async () => {
    const f = fixture();
    f.add("100-0", "delete");
    expect(await f.reader.deletion("vm-one")).toBeDefined();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    try {
      f.state.epoch = "b".repeat(40);
      f.state.rows = [];
      expect(await f.reader.deletion("vm-one")).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });
  it("does not return stale absence during a source outage", async () => {
    const f = fixture();
    f.add("100-0", "delete");
    expect(await f.reader.deletion("vm-one")).toBeDefined();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    try {
      f.state.offline = true;
      await expect(f.reader.deletion("vm-one")).rejects.toThrow("unavailable");
    } finally {
      now.mockRestore();
    }
  });
  it("rejects malformed or future native operations", async () => {
    const f = fixture();
    f.add("100-0", "future-op");
    await expect(f.reader.deletion("vm-one")).rejects.toThrow("Unknown native lifecycle");
    f.state.rows = [["101-0", ["op", "delete", "sandbox_id", "vm-one", "ts", "not-a-time"]]];
    await expect(f.reader.page()).rejects.toThrow();
  });
  it("keeps native timeout metadata distinct from terminal deletion evidence", async () => {
    const f = fixture();
    f.state.metadata = JSON.stringify({ sandbox_id: "vm-one", timeout_seconds: 1800, end_at: 1 });
    expect(await f.reader.metadata("vm-one")).toMatchObject({ timeout_seconds: 1800, end_at: 1 });
    expect(await f.reader.deletion("vm-one")).toBeUndefined();
    f.state.metadata = JSON.stringify({ sandbox_id: "wrong-vm" });
    await expect(f.reader.metadata("vm-one")).rejects.toThrow("identity changed");
  });
});
