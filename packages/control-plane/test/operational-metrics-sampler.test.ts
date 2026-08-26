import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PiCloudMetrics } from "@pi-cloud/observability";
import type { JetStreamOperationalSnapshot } from "@pi-cloud/runtime-core/jetstream-event-runtime";
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
  it("publishes authoritative PostgreSQL backlog and JetStream health gauges", async () => {
    const metrics = new PiCloudMetrics("control-plane-test");
    const errors: unknown[] = [];
    const snapshot: JetStreamOperationalSnapshot = {
      streams: [
        {
          name: "PI_CLOUD_AGENT_EVENTS",
          messages: 41,
          bytes: 8_192,
          unavailableReplicas: 0,
        },
      ],
      consumers: [
        {
          stream: "PI_CLOUD_SESSION_MUTATIONS_V2",
          name: "PI_CLOUD_SESSION_PROJECTOR",
          pending: 3,
        },
      ],
      factChannels: {
        openedChannels: 12,
        activeChannels: 7,
        publishedFacts: 410,
        renewalCycles: 3,
        renewalFailures: 0,
        maximumActiveChannels: 128,
      },
    };
    const sampler = new OperationalMetricsSampler({
      database,
      events: { operationalSnapshot: async () => snapshot },
      metrics,
      onError: (_source, error) => errors.push(error),
    });

    await sampler.sample();
    expect(errors).toEqual([]);
    const output = await metrics.registry.metrics();

    expect(output).toContain('pi_cloud_queued_runs{service="control-plane-test"} 0');
    expect(output).toContain(
      'pi_cloud_terminal_event_outbox_pending{service="control-plane-test"} 0',
    );
    expect(output).toContain(
      'pi_cloud_workspace_storage_purge_pending{service="control-plane-test"} 0',
    );
    expect(output).toContain(
      'pi_cloud_jetstream_messages{stream="PI_CLOUD_AGENT_EVENTS",service="control-plane-test"} 41',
    );
    expect(output).toContain(
      'pi_cloud_jetstream_consumer_pending{stream="PI_CLOUD_SESSION_MUTATIONS_V2",consumer="PI_CLOUD_SESSION_PROJECTOR",service="control-plane-test"} 3',
    );
    expect(output).toContain('pi_cloud_fact_channels_active{service="control-plane-test"} 7');
    expect(output).toContain('pi_cloud_fact_channels_limit{service="control-plane-test"} 128');
    expect(output).toMatch(
      /pi_cloud_operational_sample_timestamp_seconds\{source="postgresql",service="control-plane-test"\} \d+/u,
    );
  });

  it("keeps the service running and exposes a failed telemetry sample", async () => {
    const metrics = new PiCloudMetrics("control-plane-failure-test");
    const sampler = new OperationalMetricsSampler({
      database,
      events: {
        operationalSnapshot: async () => {
          throw new Error("unavailable");
        },
      },
      metrics,
    });

    await sampler.sample();
    expect(await metrics.registry.metrics()).toContain(
      'pi_cloud_operational_sample_failures_total{source="jetstream",service="control-plane-failure-test"} 1',
    );
  });
});
