import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PiCloudMetrics } from "@pi-cloud/observability";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OperationalMetricsSampler } from "../src/operational-metrics-sampler.ts";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 2,
  });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe("operational metrics sampler", () => {
  it("samples bounded control backlog and age with one database statement", async () => {
    const tenantId = crypto.randomUUID(),
      id = crypto.randomUUID();
    await database
      .insertInto("tenants")
      .values({ id: tenantId, slug: "metrics-controls" })
      .execute();
    await database
      .insertInto("outbox")
      .values({
        id,
        tenant_id: tenantId,
        aggregate_type: "session_control_change",
        aggregate_id: id,
        topic: "session.control.changed.v1",
        payload: {
          kind: "control_change",
          entity: "input_queue",
          entityId: id,
          factId: id,
          version: "1",
          scope: { tenantId, piSessionId: id },
          occurredAt: new Date().toISOString(),
        },
        created_at: new Date(Date.now() - 10000),
        last_error: null,
      })
      .execute();
    let queries = 0;
    const measured = database.withPlugin({
      transformQuery({ node }) {
        return node;
      },
      async transformResult({ result }) {
        queries++;
        return result;
      },
    });
    const metrics = new PiCloudMetrics("control-backlog"),
      errors: unknown[] = [];
    const sampler = new OperationalMetricsSampler({
      database: measured,
      events: {
        statistics: () => ({
          liveTail: { activeSessionTails: 0, cachedEvents: 0, cachedBytes: 0 },
        }),
      } as never,
      metrics,
      onError: (_source, error) => errors.push(error),
    });
    await sampler.sample();
    expect(errors).toEqual([]);
    expect(queries).toBe(1);
    const backlog = await metrics.controlOutboxPending.get(),
      ages = await metrics.controlOutboxOldestAge.get();
    expect(backlog.values.find((v) => v.labels.entity === "input_queue")?.value).toBe(1);
    expect(
      ages.values.find((v) => v.labels.entity === "input_queue")!.value,
    ).toBeGreaterThanOrEqual(9);
    expect(backlog.values).toHaveLength(4);
    await database.deleteFrom("outbox").where("id", "=", id).execute();
    await sampler.sample();
    expect((await metrics.controlOutboxPending.get()).values.every((v) => v.value === 0)).toBe(
      true,
    );
  });
  it("publishes PostgreSQL backlog and local Session Projector gauges", async () => {
    const metrics = new PiCloudMetrics("control-plane-test");
    const errors: unknown[] = [];
    const snapshot = {
      liveTail: {
        activeSessionTails: 2,
        cachedEvents: 9,
        cachedBytes: 8_192,
        acceptedEvents: 410,
        duplicateEvents: 1,
        evictedEvents: 400,
      },
    };
    const sampler = new OperationalMetricsSampler({
      database,
      events: { statistics: () => snapshot },
      metrics,
      onError: (_source, error) => errors.push(error),
    });

    await sampler.sample();
    expect(errors).toEqual([]);
    const output = await metrics.registry.metrics();

    expect(output).toContain('pi_cloud_queued_runs{service="control-plane-test"} 0');
    expect(output).toContain('pi_cloud_kafka_live_tail_sessions{service="control-plane-test"} 2');
    expect(output).toContain('pi_cloud_kafka_live_tail_events{service="control-plane-test"} 9');
    expect(output).toContain('pi_cloud_kafka_live_tail_bytes{service="control-plane-test"} 8192');
    expect(output).toContain(
      'pi_cloud_terminal_event_outbox_pending{service="control-plane-test"} 0',
    );
    expect(output).toContain(
      'pi_cloud_workspace_storage_purge_pending{service="control-plane-test"} 0',
    );
    expect(output).toMatch(
      /pi_cloud_operational_sample_timestamp_seconds\{source="postgresql",service="control-plane-test"\} \d+/u,
    );
  });

  it("keeps the service running and exposes a failed telemetry sample", async () => {
    const metrics = new PiCloudMetrics("control-plane-failure-test");
    const sampler = new OperationalMetricsSampler({
      database,
      events: {
        statistics: () => {
          throw new Error("unavailable");
        },
      },
      metrics,
    });

    await sampler.sample();
    expect(await metrics.registry.metrics()).toContain(
      'pi_cloud_operational_sample_failures_total{source="kafka",service="control-plane-failure-test"} 1',
    );
  });
});
