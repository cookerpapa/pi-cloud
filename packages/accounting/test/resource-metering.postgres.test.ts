import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import type { ResourceMeteringEvent, ResourceRateInput } from "@pi-cloud/protocol";
import { expect, it } from "vitest";
import { ResourceMeteringService } from "../src/resource-metering-service.ts";
import { createMeteringApplication } from "../src/http.ts";

it("prices source intervals at each rate boundary, rejects overlap, and retains unknown gaps without charging them", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 6,
  });
  const app = createMeteringApplication(db, "owned-resource-fixture");
  try {
    await runMigrations(db, "up");
    const service = new ResourceMeteringService(db),
      start = Date.now() + 3_600_000;
    const time = (delta: number) => new Date(start + delta).toISOString();
    const event: ResourceMeteringEvent = {
      version: 1,
      eventId: randomUUID(),
      resource: {
        kind: "compute",
        resourceId: randomUUID(),
        tenantId: randomUUID(),
        workspaceId: randomUUID(),
      },
      sourceId: "cube-node-owned",
      sourceBootId: randomUUID(),
      incarnation: randomUUID(),
      from: time(0),
      to: time(3_600_000),
      quality: "confirmed",
      state: "running",
      quantity: { kind: "compute", cpuMillis: 2000, memoryBytes: 2 * 1024 ** 3 },
    };
    const rate: ResourceRateInput = {
      kind: "customer",
      resourceKind: "compute",
      effectiveAt: time(0),
      currency: "USD",
      perHour: { cpuCore: "0.1", memoryGiB: "0.05" },
    };
    const first = await service.createRate(event.resource.tenantId, rate);
    expect((await service.createRate(event.resource.tenantId, rate)).id).toBe(first.id);
    await expect(
      service.createRate(event.resource.tenantId, { ...rate, currency: "CNY" }),
    ).rejects.toThrow("price version changed");
    await service.createRate(event.resource.tenantId, {
      ...rate,
      effectiveAt: time(1_800_000),
      perHour: { cpuCore: "0.2", memoryGiB: "0.1" },
    });
    await Promise.all(Array.from({ length: 3 }, () => service.ingest({ events: [event] })));
    const options = { from: time(-1), to: time(5_000_000), limit: 50 };
    const page = await service.list(event.resource.tenantId, options);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.valuation.map((v) => v.customer)).toMatchObject([
      { state: "priced", amountPico: "150000000000" },
      { state: "priced", amountPico: "300000000000" },
    ]);
    // A second Session or collector boot cannot bill the same shared VM interval.
    await expect(
      service.ingest({ events: [{ ...event, eventId: randomUUID(), incarnation: randomUUID() }] }),
    ).rejects.toThrow("overlap");
    const gap: ResourceMeteringEvent = {
      ...event,
      eventId: randomUUID(),
      from: event.to,
      to: time(4_000_000),
      quality: "unconfirmed",
      reason: "source_restarted",
      state: "unknown",
    };
    await service.ingest({ events: [gap] });
    const summary = await service.summary(event.resource.tenantId, options);
    expect(
      summary.categories.find((v) => v.kind === "customer" && v.state === "priced")?.amountPico,
    ).toBe("450000000000");
    expect(
      summary.categories.find((v) => v.kind === "customer" && v.state === "unconfirmed")
        ?.amountPico,
    ).toBeNull();
    expect((await service.list(randomUUID(), options)).items).toEqual([]);
    const statement = await service.statement(event.resource.tenantId, options);
    expect(statement.items).toHaveLength(1);
    expect(statement.items[0]).toMatchObject({
      confirmedMilliseconds: "3600000",
      unconfirmedMilliseconds: "400000",
    });
    expect(
      statement.items[0]!.charges.find((c) => c.kind === "customer" && c.state === "priced")
        ?.amountPico,
    ).toBe("450000000000");
    const send = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/internal/v1/resource-metering",
        headers: {
          authorization: "Bearer owned-resource-fixture",
          "content-type": "application/json",
        },
        payload: JSON.stringify(payload),
      });
    expect((await send({ events: [{ ...event, sourceId: "changed" }] })).statusCode).toBe(409);
    expect((await send({ events: [{ ...gap, reason: undefined }] })).statusCode).toBe(400);
    // A conflict at the end rolls back the whole batch, including a new resource.
    const newResource = {
      ...event,
      eventId: randomUUID(),
      resource: { ...event.resource, resourceId: randomUUID() },
    };
    await expect(
      service.ingest({ events: [newResource, { ...event, sourceId: "changed" }] }),
    ).rejects.toThrow("identity changed");
    expect(
      await db
        .selectFrom("resource_metering_events")
        .select("id")
        .where("id", "=", newResource.eventId)
        .execute(),
    ).toEqual([]);
  } finally {
    await app.close();
    await db.destroy();
  }
});

it("counts retained capacity independently of compute and keeps both price kinds informational", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 2,
  });
  try {
    await runMigrations(db, "up");
    const service = new ResourceMeteringService(db),
      start = Date.now() + 60_000;
    const event: ResourceMeteringEvent = {
      version: 1,
      eventId: randomUUID(),
      resource: {
        kind: "workspace",
        resourceId: `volume-${randomUUID()}`,
        tenantId: randomUUID(),
        workspaceId: randomUUID(),
      },
      sourceId: "volume-authority",
      sourceBootId: randomUUID(),
      incarnation: randomUUID(),
      from: new Date(start).toISOString(),
      to: new Date(start + 3_600_000).toISOString(),
      quality: "confirmed",
      state: "retained",
      quantity: { kind: "workspace", capacityBytes: 32 * 1024 ** 3 },
    };
    await service.createRate(event.resource.tenantId, {
      kind: "customer",
      resourceKind: "workspace",
      currency: "CNY",
      effectiveAt: event.from,
      perHour: { capacityGiB: "0.001" },
    });
    await service.ingest({ events: [event] });
    const page = await service.list(event.resource.tenantId, {
      from: event.from,
      to: new Date(start + 7_200_000).toISOString(),
      limit: 1,
    });
    expect(page.items[0]!.valuation[0]!.customer).toMatchObject({
      state: "priced",
      amountPico: "32000000000",
      currency: "CNY",
    });
    expect(page.items[0]!.valuation[0]!.upstream_estimate).toEqual({
      state: "unpriced",
      reason: "missing_rate",
    });
  } finally {
    await db.destroy();
  }
});
