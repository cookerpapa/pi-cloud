import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { expect, it } from "vitest";
import type { SandboxLifecycleEvent, SandboxLifecyclePage } from "@pi-cloud/protocol";
import { LifecycleCollector } from "../src/lifecycle-collector.ts";

it("commits source cursors with priced intervals, rejects conflicts, and resumes without duplicate shared-VM charges", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 4,
  });
  const provider = `cube:${randomUUID()}`,
    node = randomUUID(),
    epoch = randomUUID(),
    id = `${provider}:${node}`;
  const collector = new LifecycleCollector(db, {
    id: provider,
    list: async () => [],
    read: async () => {
      throw new Error("not used");
    },
  });
  const resource = {
    kind: "compute" as const,
    resourceId: randomUUID(),
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
  };
  const base = Date.now();
  const first: SandboxLifecycleEvent = {
    eventId: randomUUID(),
    sequence: "1",
    previousSequence: "0",
    resource,
    quantity: { kind: "compute", cpuMillis: 2000, memoryBytes: 1024 ** 3 },
    incarnation: "allocation-1",
    state: "running",
    sourceBootId: randomUUID(),
    observedAt: new Date(base).toISOString(),
    occurredAt: null,
  };
  const second = {
    ...first,
    eventId: randomUUID(),
    sequence: "2",
    previousSequence: "1",
    observedAt: new Date(base + 30_000).toISOString(),
  };
  const page: SandboxLifecyclePage = {
    epoch,
    low: "1",
    high: "2",
    next: "2",
    gap: false,
    hasMore: false,
    events: [first, second],
  };
  try {
    await runMigrations(db, "up");
    await db
      .insertInto("resource_lifecycle_sources")
      .values({ id, provider, node_id: node })
      .execute();
    const applied = await Promise.all([
      collector.apply(id, undefined, page),
      collector.apply(id, undefined, page),
    ]);
    expect(applied.sort()).toEqual([false, true]);
    const events = await db
      .selectFrom("resource_metering_events")
      .selectAll()
      .where("tenant_id", "=", resource.tenantId)
      .execute();
    expect(events).toHaveLength(2);
    const checkpoint = await db
      .selectFrom("resource_lifecycle_sources")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(String(checkpoint.after_sequence)).toBe("2");
    const conflicting: SandboxLifecyclePage = {
      ...page,
      high: "3",
      next: "3",
      events: [
        {
          ...second,
          sequence: "3",
          previousSequence: "2",
          resource: { ...resource, tenantId: randomUUID() },
        },
      ],
    };
    await expect(collector.apply(id, { epoch, sequence: "2" }, conflicting)).rejects.toThrow(
      "identity changed",
    );
    expect(
      String(
        (
          await db
            .selectFrom("resource_lifecycle_sources")
            .select("after_sequence")
            .where("id", "=", id)
            .executeTakeFirstOrThrow()
        ).after_sequence,
      ),
    ).toBe("2");
    const gap = {
      ...second,
      eventId: randomUUID(),
      sequence: "5",
      previousSequence: "4",
      observedAt: new Date(base + 90_000).toISOString(),
    };
    await collector.apply(
      id,
      { epoch, sequence: "2" },
      { ...page, low: "5", high: "5", next: "5", gap: true, events: [gap] },
    );
    expect(
      (
        await db
          .selectFrom("resource_metering_events")
          .select("quality")
          .where("id", "=", gap.eventId)
          .executeTakeFirstOrThrow()
      ).quality,
    ).toBe("unconfirmed");
  } finally {
    await collector.close();
    await db.destroy();
  }
});
