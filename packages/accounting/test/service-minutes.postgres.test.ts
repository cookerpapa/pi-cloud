import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDatabase, runMigrations, resourceIdentityHash } from "@pi-cloud/database";
import { beforeAll, afterAll, it, expect } from "vitest";
import { ServiceMinuteCollector } from "../src/service-minute-collector.ts";
import { ResourceMeteringService } from "../src/resource-metering-service.ts";
import type { ResourceMeteringEvent } from "@pi-cloud/protocol";

const db = createDatabase({
  connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
  maxConnections: 8,
});
beforeAll(() => runMigrations(db, "up"), 60_000);
afterAll(() => db.destroy());
async function fixture(provider: string, billing = "platform") {
  const start = Date.now() - 3_600_000,
    time = (ms: number) => new Date(start + ms);
  const identity = {
    kind: "compute",
    resourceId: randomUUID(),
    tenantId: randomUUID(),
    workspaceId: provider === "android" ? null : randomUUID(),
  };
  const key = "compute:" + identity.resourceId;
  const contract = {
    billing,
    provider,
    sourceKind: "android",
    sourceId: randomUUID(),
    acceptedAt: time(-1).toISOString(),
    quantity: { kind: "compute", cpuMillis: 2000, memoryBytes: 1024 ** 3 },
  };
  await sql`insert into resource_metering_resources(id,tenant_id,workspace_id,kind,resource_id,context,context_hash,service_contract)
    values(${key},${identity.tenantId}::uuid,${identity.workspaceId}::uuid,'compute',${identity.resourceId},${JSON.stringify(identity)}::jsonb,${resourceIdentityHash(identity)},${JSON.stringify(contract)}::jsonb)`.execute(
    db,
  );
  const state = async (
    at: number,
    available: boolean,
    reason = "unavailable",
    cutoff: number | null = null,
  ) => {
    await sql`select pi_cloud_compute_service_state(${key},${available},${time(at)},${reason},${cutoff === null ? null : time(cutoff)})`.execute(
      db,
    );
  };
  const receipts = async () =>
    (
      await sql<{
        payload: ResourceMeteringEvent;
        valuation: {
          customer: { amountPico?: string };
          upstream_estimate: { state: string; reason?: string };
        }[];
      }>`select payload,valuation from resource_metering_events where resource_key=${key} order by from_at`.execute(
        db,
      )
    ).rows;
  return { identity, key, state, receipts, time };
}

it.each(["cubesandbox", "boxlite", "android"])(
  "settles %s service minutes across restarts without charging cleanup or the final remainder",
  async (provider) => {
    const f = await fixture(provider),
      metering = new ResourceMeteringService(db);
    // Historical rate fixtures represent plans configured before the simulated service.
    // The public API's prohibition on backdated new prices remains unchanged.
    for (const [offset, price] of [
      [0, "0.3"],
      [30_000, "0.6"],
    ] as const) {
      const definition = {
        kind: "customer" as const,
        resourceKind: "compute" as const,
        effectiveAt: f.time(offset).toISOString(),
        currency: "USD",
        perHour: { cpuCore: price, memoryGiB: "0" },
      };
      await db
        .insertInto("resource_rate_versions")
        .values({
          id: randomUUID(),
          tenant_id: f.identity.tenantId,
          kind: "customer",
          resource_kind: "compute",
          effective_at: f.time(offset),
          definition,
        })
        .execute();
    }
    await f.state(0, true);
    await f.state(70_000, true);
    await new ServiceMinuteCollector(db).tick();
    expect(
      (await f.receipts()).map((r) => Date.parse(r.payload.to) - Date.parse(r.payload.from)),
    ).toEqual([60_000]);
    await f.state(165_000, false, "idle_expiry", 159_000);
    await Promise.all([
      new ServiceMinuteCollector(db).tick(),
      new ServiceMinuteCollector(db).tick(),
    ]);
    const rows = await f.receipts();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.payload.basis === "platform_service_minute_v1")).toBe(true);
    expect(
      rows.reduce((sum, row) => sum + Date.parse(row.payload.to) - Date.parse(row.payload.from), 0),
    ).toBe(120_000);
    expect(
      rows
        .flatMap((row) => row.valuation)
        .reduce((sum, value) => sum + BigInt(value.customer.amountPico!), 0n),
    ).toBe(35_000_000_000n);
    expect(
      rows
        .flatMap((row) => row.valuation)
        .every(
          (value) => value.upstream_estimate.reason === "service_duration_is_not_vendor_usage",
        ),
    ).toBe(true);
    await sql`update resource_metering_resources set reclamation=${JSON.stringify({ deletionConfirmedAt: f.time(180_000).toISOString(), physicalStopOccurredAt: null })}::jsonb where id=${f.key}`.execute(
      db,
    );
    await new ServiceMinuteCollector(db).tick();
    expect(await f.receipts()).toEqual(rows);
    const statement = await metering.statement(f.identity.tenantId, {
      from: f.time(-1).toISOString(),
      to: f.time(360_000).toISOString(),
      limit: 50,
    });
    expect(statement.items[0]!.resource.workspaceId).toBe(f.identity.workspaceId);
  },
);

it.each(["cubesandbox", "boxlite", "android", "linux"])(
  "never prices user-provided %s compute even when it reports availability",
  async (provider) => {
    const f = await fixture(provider, "external");
    await f.state(0, true);
    await f.state(60_000, true);
    await f.state(120_000, true);
    await f.state(180_000, false, "release");
    await new ServiceMinuteCollector(db).tick();
    expect(await f.receipts()).toEqual([]);
    expect(
      (await sql`select 1 from compute_service_periods where resource_key=${f.key}`.execute(db))
        .rows,
    ).toEqual([]);
  },
);

it("withholds observation gaps and closes interruption at the last confirmation", async () => {
  const f = await fixture("cubesandbox");
  await f.state(0, true);
  await f.state(70_000, true);
  await f.state(230_000, true);
  await f.state(250_000, false);
  const collector = new ServiceMinuteCollector(db);
  await collector.tick();
  const rows = await f.receipts();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload.to).toBe(f.time(60_000).toISOString());
  const periods = (
    await sql<{
      opened_at: Date;
      ended_at: Date;
    }>`select opened_at,ended_at from compute_service_periods where resource_key=${f.key} order by opened_at`.execute(
      db,
    )
  ).rows;
  expect(periods.map((row) => [row.opened_at.getTime(), row.ended_at.getTime()])).toEqual([
    [f.time(0).getTime(), f.time(70_000).getTime()],
    [f.time(230_000).getTime(), f.time(230_000).getTime()],
  ]);
});

it("retains management facts while metering is stopped and carries partial minutes across resume", async () => {
  const f = await fixture("boxlite");
  await f.state(0, true);
  for (let minute = 1; minute <= 20; minute++) await f.state(minute * 60_000, true);
  await f.state(20 * 60_000 + 35_000, false, "pause");
  expect(await f.receipts()).toEqual([]);
  const collector = new ServiceMinuteCollector(db);
  await collector.tick();
  await collector.tick();
  const total = (await f.receipts()).reduce(
    (sum, row) => sum + Date.parse(row.payload.to) - Date.parse(row.payload.from),
    0,
  );
  expect(total).toBe(20 * 60_000);
  await f.state(30 * 60_000, true);
  await f.state(31 * 60_000 + 10_000, true);
  await f.state(31 * 60_000 + 30_000, false, "release");
  await collector.tick();
  expect(
    (await f.receipts()).reduce(
      (sum, row) => sum + Date.parse(row.payload.to) - Date.parse(row.payload.from),
      0,
    ),
  ).toBe(21 * 60_000);
});

it("closes an authoritative stop after clock rollback without rebilling earlier time", async () => {
  const f = await fixture("boxlite"),
    collector = new ServiceMinuteCollector(db);
  await f.state(0, true);
  await f.state(60_000, true);
  await collector.tick();
  await f.state(30_000, false, "release");
  await f.state(40_000, true);
  expect(
    (
      await sql`select 1 from compute_service_periods where resource_key=${f.key} and ended_at is null`.execute(
        db,
      )
    ).rows,
  ).toEqual([]);
  await f.state(70_000, true);
  await f.state(130_000, true);
  await collector.tick();
  expect(
    (await f.receipts()).reduce(
      (sum, row) => sum + Date.parse(row.payload.to) - Date.parse(row.payload.from),
      0,
    ),
  ).toBe(120_000);
});
