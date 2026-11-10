import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations, resourceIdentityHash } from "@pi-cloud/database";
import { expect, it, vi } from "vitest";
import { CubeLifecycleEvents, compareCubeCursor } from "@pi-cloud/sandbox-control/cube-lifecycle";
import { CubeLifecycleSource } from "../src/cube-lifecycle-source.ts";
import { LifecycleCollector } from "../src/lifecycle-collector.ts";

async function fixture(count: number, quantity = true) {
  const database = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 4,
  });
  await runMigrations(database, "up");
  const sourceId = `cubesandbox:${randomUUID()}`,
    tenantId = randomUUID(),
    workspaceId = randomUUID();
  const resources = Array.from({ length: count }, (_, i) => ({
    identity: { kind: "compute", resourceId: randomUUID(), tenantId, workspaceId },
    nativeId: `owned-${i}`,
  }));
  for (const row of resources)
    await database
      .insertInto("resource_metering_resources")
      .values({
        id: `compute:${row.identity.resourceId}`,
        resource_id: row.identity.resourceId,
        kind: "compute",
        tenant_id: tenantId,
        workspace_id: workspaceId,
        context: row.identity,
        context_hash: resourceIdentityHash(row.identity),
        provider_binding: {
          sourceId,
          resourceId: row.nativeId,
          ...(quantity
            ? { quantity: { kind: "compute", cpuMillis: 1000, memoryBytes: 1024 ** 3 } }
            : {}),
        },
      })
      .execute();
  const rows: Array<[string, string[]]> = [];
  const events = new CubeLifecycleEvents({
    command: async (args) => {
      if (args[0] === "INFO") return `run_id:${"a".repeat(40)}\r\n`;
      if (args[0] === "XREVRANGE") return rows.slice(-1);
      if (args[0] === "XRANGE")
        return rows
          .filter(([id]) => args[2] === "-" || compareCubeCursor(id, args[2]!.slice(1)) > 0)
          .slice(0, Number(args[5]));
      throw new Error("Unexpected native read");
    },
  });
  const inventory: Array<{ sandboxID: string; state: string; cpuCount: number; memoryMB: number }> =
    [];
  const source = new CubeLifecycleSource({
    id: sourceId,
    url: "https://owned-cube.test",
    apiKey: "fixture",
    database,
    events,
    fetch: async () => new Response(JSON.stringify(inventory), { status: 200 }),
  });
  const collector = new LifecycleCollector(database, source);
  const close = async () => {
    await collector.close();
    await database
      .deleteFrom("resource_metering_events")
      .where("tenant_id", "=", tenantId)
      .execute();
    await database
      .deleteFrom("resource_metering_resources")
      .where("tenant_id", "=", tenantId)
      .execute();
    await database
      .deleteFrom("resource_lifecycle_sources")
      .where("provider", "=", sourceId)
      .execute();
    await database.destroy();
  };
  return { database, sourceId, tenantId, resources, rows, inventory, source, collector, close };
}

it("keeps native sampled time unpriced and attributes delete evidence after active bindings are gone", async () => {
  const f = await fixture(2);
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    f.inventory.push({
      sandboxID: f.resources[0]!.nativeId,
      state: "running",
      cpuCount: 1,
      memoryMB: 1024,
    });
    await f.collector.collect("observations");
    now += 60000;
    f.rows.push([
      "100-0",
      ["op", "delete", "sandbox_id", f.resources[1]!.nativeId, "ts", String(now - 30000)],
    ]);
    await f.collector.collect("observations");
    const receipts = await f.database
      .selectFrom("resource_metering_events")
      .selectAll()
      .where("tenant_id", "=", f.tenantId)
      .execute();
    expect(receipts).toHaveLength(4);
    expect(receipts.every((r) => r.quality === "unconfirmed")).toBe(true);
    expect(receipts.some((r) => r.payload.state === "absent")).toBe(true);
    for (const r of receipts)
      for (const value of r.valuation)
        expect(value).toMatchObject({ customer: { state: "unconfirmed" } });
    const checkpoint = await f.database
      .selectFrom("resource_lifecycle_sources")
      .selectAll()
      .where("provider", "=", f.sourceId)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(checkpoint.source_position!)).toMatchObject({ after: "", native: "100-0" });
    expect(checkpoint.gap_detected_at).not.toBeNull();
  } finally {
    clock.mockRestore();
    await f.close();
  }
}, 30000);

it("atomically advances an opaque scan cursor even when missing quantities produce no priced events", async () => {
  const f = await fixture(65, false);
  try {
    const id = `${f.sourceId}:observations`;
    await f.database
      .insertInto("resource_lifecycle_sources")
      .values({ id, provider: f.sourceId, node_id: "observations" })
      .execute();
    const first = await f.source.read("observations", undefined, new AbortController().signal);
    expect(first).toMatchObject({ events: [], next: "0", hasMore: true, gap: true });
    expect(await f.collector.apply(id, undefined, first)).toBe(true);
    expect(await f.collector.apply(id, { epoch: first.epoch, sequence: "0" }, first)).toBe(false);
    const cursor = {
      epoch: first.epoch,
      sequence: first.next,
      sourcePosition: first.sourcePosition!,
    };
    const second = await f.source.read("observations", cursor, new AbortController().signal);
    expect(second).toMatchObject({ events: [], next: "0", hasMore: false });
    expect(await f.collector.apply(id, cursor, second)).toBe(true);
    expect(
      await f.database
        .selectFrom("resource_metering_events")
        .select("id")
        .where("tenant_id", "=", f.tenantId)
        .execute(),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 30000);
