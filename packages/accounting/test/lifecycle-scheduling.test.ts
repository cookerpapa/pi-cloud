import { expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { LifecycleCollector } from "../src/lifecycle-collector.ts";
import type { SandboxLifecycleSource } from "../src/lifecycle-source.ts";

it("gives untouched sources a turn while other nodes continuously catch up", async () => {
  const query = { select: () => query, where: () => query, execute: async () => [] };
  const db = { selectFrom: () => query } as unknown as Kysely<Database>;
  const source: SandboxLifecycleSource = {
    id: "fixture",
    list: async () => Array.from({ length: 6 }, (_, n) => ({ id: String(n), available: true })),
    read: async () => {
      throw new Error("Collection is isolated in this scheduler contract");
    },
  };
  const collector = new LifecycleCollector(db, source);
  const collected = vi.spyOn(collector, "collect").mockResolvedValue(true);
  try {
    await collector.tick(1_000_000);
    expect(collected.mock.calls.map(([node]) => node)).toEqual(["0", "1", "2", "3"]);
    collected.mockClear();
    await collector.tick(1_005_000);
    expect(collected.mock.calls.map(([node]) => node).slice(0, 2)).toEqual(["4", "5"]);
    expect(collected).toHaveBeenCalledTimes(4);
  } finally {
    await collector.close();
  }
});
