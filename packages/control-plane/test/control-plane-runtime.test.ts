import { emptyEventRuntime } from "./fixtures/event-runtime.ts";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PiCloudMetrics } from "@pi-cloud/observability";
import { createTestWorker } from "./admit-test-execution.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";
import type { TurnSteerResource } from "@pi-cloud/protocol";

import {
  HashedBearerSupervisorAuthorizer,
  SessionEventHub,
  SandboxPreviewGateway,
  SupervisorMaintenanceRuntime,
  createControlPlaneRuntime,
  createPrivateTenant,
  ControlPlaneStore,
  type SupervisorMaintenanceActivity,
} from "../src/index.ts";

const IDS = {
  tenant: "81000000-0000-4000-8000-000000000001",
  profile: "81000000-0000-4000-8000-000000000003",
  controlPlane: "81000000-0000-4000-8000-000000000004",
  boot: "81000000-0000-4000-8000-000000000005",
  sandbox: "81000000-0000-4000-8000-000000000006",
} as const;

const SUPERVISOR_ID = "remote-runtime-test";
const TOKEN = `pi-cloud-${"w".repeat(48)}`;

let pglite: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let database: Kysely<Database>;

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for remote control-plane runtime state");
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

beforeAll(async () => {
  let connectionString = process.env.PI_CLOUD_TEST_DATABASE_URL;
  if (!connectionString) {
    pglite = await PGlite.create();
    socketServer = new PGLiteSocketServer({
      db: pglite,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 1,
    });
    await socketServer.start();
    connectionString = `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`;
  }
  database = createDatabase({
    connectionString,
    maxConnections: pglite === undefined ? 4 : 1,
  });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("remote control-plane runtime composition", () => {
  it("preserves admission metrics and the supplied non-local Steer transport through composition", async () => {
    const tenant = await createPrivateTenant(database, {
      slug: `composition-${randomUUID()}`,
      ownerDisplayName: "Composition regression",
    });
    const store = new ControlPlaneStore({
      database,
      tenantId: tenant.tenantId,
      defaultModelProfileId: tenant.defaultModelProfileId,
    });
    const project = await store.createProject({ name: "Composition", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Composition",
      "elastic",
    );
    const metrics = new PiCloudMetrics("composition-regression");
    const finishDelivery = Promise.withResolvers<void>();
    const steer = vi.fn(async () => {
      await finishDelivery.promise;
    });
    const backendFactory = vi.fn(async () => ({ steer }));
    const runtime = await createControlPlaneRuntime({
      database,
      tenantId: tenant.tenantId,
      defaultModelProfileId: tenant.defaultModelProfileId,
      controlPlaneInstanceId: randomUUID(),
      eventRuntime: emptyEventRuntime(),
      metrics,
      turnSteerBackendFactory: backendFactory,
      supervisorAuthorizer: new HashedBearerSupervisorAuthorizer({
        token: TOKEN,
        identity: { supervisorId: SUPERVISOR_ID, bootId: IDS.boot, sandboxId: IDS.sandbox },
      }),
      supervisorOwnerBoundary: {
        async stopAndConfirm() {
          throw new Error("No Worker is registered here");
        },
      },
      assignmentInventoryFactory: () => ({
        async listAssignments() {
          return [];
        },
        async terminateAndConfirmAbsent() {
          throw new Error("No assignments");
        },
      }),
    });
    const finished = Promise.withResolvers<void>();
    let execution: Promise<unknown> | undefined;
    try {
      const address = await runtime.listen(0, "127.0.0.1");
      const accepted = await fetch(`${address}/v1/sessions/${session.sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
        body: JSON.stringify({ prompt: "Queue only; no model is running in this fixture." }),
      });
      expect(accepted.status).toBe(202);
      const turn = (await accepted.json()) as { runId: string; turnId: string };
      const samples = await metrics.turnAdmissionDuration.get();
      expect.soft(samples.values.find((v) => v.metricName?.endsWith("_count"))?.value).toBe(1);
      // Run admission intentionally has no tenant-concurrency lock. Resource
      // creation is the separate path which actually observes this metric.
      const resource = await fetch(`${address}/v1/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Metric resource", source: { kind: "empty" } }),
      });
      expect(resource.status).toBe(201);
      expect
        .soft(
          (await metrics.tenantAdmissionLockWait.get()).values.find((v) =>
            v.metricName?.endsWith("_count"),
          )?.value,
        )
        .toBeGreaterThan(0);

      const worker = await createTestWorker(database);
      const entered = Promise.withResolvers<void>();
      execution = worker
        .executor({
          execute: async () => {
            entered.resolve();
            await finished.promise;
            return { stopReason: "stop" };
          },
        })
        .dispatchRun(turn.runId);
      void execution.catch(entered.reject);
      await entered.promise;

      // Acceptance must persist a held source before reconciliation uses the
      // supplied transport, even without a local Worker WebSocket connection.
      const text = "Change the requested output.";
      const key = randomUUID();
      expect(runtime.gateway.activeConnectionCount).toBe(0);
      const delivered = await fetch(
        `${address}/v1/sessions/${session.sessionId}/turns/${turn.turnId}/steers`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ text }),
        },
      );
      expect(delivered.status).toBe(202);
      const receipt = (await delivered.json()) as TurnSteerResource;
      expect(receipt).toMatchObject({
        targetRunId: turn.runId,
        state: "accepted",
        replayed: false,
      });
      expect(
        await database
          .selectFrom("runs")
          .select(["state", "queued_steer_id"])
          .where("id", "=", receipt.sourceRunId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "queued", queued_steer_id: receipt.controlRequestId });
      runtime.application.get(QueuedInputService).recoverPending();
      await waitFor(() => steer.mock.calls.length === 1);
      expect(backendFactory).toHaveBeenCalledWith(worker.workerId);
      expect(steer).toHaveBeenCalledWith(
        expect.objectContaining({ text, target: expect.objectContaining({ runId: turn.runId }) }),
      );
      // HTTP acceptance did not await the deliberately blocked Worker reply.
      finishDelivery.resolve();
      await waitFor(
        async () =>
          (
            await database
              .selectFrom("turn_control_requests")
              .select("state")
              .where("id", "=", receipt.controlRequestId)
              .executeTakeFirst()
          )?.state === "acknowledged",
      );
      expect(
        await database
          .selectFrom("turn_control_requests")
          .select("state")
          .where("id", "=", receipt.controlRequestId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "acknowledged" });
      const replay = await fetch(
        `${address}/v1/sessions/${session.sessionId}/turns/${turn.turnId}/steers`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ text }),
        },
      );
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ ...receipt, replayed: true });
      await runtime.application.get(QueuedInputService).reconcileOnce();
      expect(steer).toHaveBeenCalledOnce();
    } finally {
      finishDelivery.resolve();
      finished.resolve();
      await execution;
      await runtime.close();
    }
  });

  it("retries maintenance without overlap or raw error disclosure", async () => {
    const activities: SupervisorMaintenanceActivity[] = [];
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const runtime = new SupervisorMaintenanceRuntime({
      maintenanceRunner: {
        async processNextRetirement() {
          return { kind: "idle" };
        },
        async sweepExpiredExecutions() {
          calls += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
          active -= 1;
          if (calls === 1) {
            throw { code: "maintenance_probe_failed", retryable: true, secret: TOKEN };
          }
          return {
            connections: {
              scannedConnections: 0,
              expiredConnections: 0,
              expiredConnectionIds: [],
            },
            expiredAssignments: 0,
          };
        },
      },
      maintenanceIntervalMs: 5,
      failurePollMs: 5,
      onActivity(activity) {
        activities.push(activity);
      },
    });

    runtime.start();
    expect(() => runtime.start()).toThrow("already started");
    await waitFor(() => calls >= 2);
    await Promise.all([runtime.stop(), runtime.stop()]);

    expect(runtime.state).toBe("stopped");
    expect(maximumActive).toBe(1);
    expect(activities).toEqual(
      expect.arrayContaining([
        {
          type: "runtime.failure",
          component: "maintenance",
          code: "maintenance_probe_failed",
          retryable: true,
        },
        {
          type: "maintenance.completed",
          expiredAssignments: 0,
          scannedConnections: 0,
          expiredConnections: 0,
        },
      ]),
    );
    expect(JSON.stringify(activities)).not.toContain(TOKEN);
  });

  it("keeps sweeping while remote retirement stalls and drains both loops without overlap", async () => {
    const activities: SupervisorMaintenanceActivity[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let scans = 0;
    let retirements = 0;
    const runtime = new SupervisorMaintenanceRuntime({
      maintenanceRunner: {
        async sweepExpiredExecutions() {
          scans++;
          return {
            connections: { scannedConnections: 0, expiredConnections: 0, expiredConnectionIds: [] },
            expiredAssignments: 1,
          };
        },
        async processNextRetirement() {
          retirements++;
          await blocked;
          throw { code: "remote_stop_timeout", retryable: true, secret: TOKEN };
        },
      },
      maintenanceIntervalMs: 5,
      failurePollMs: 5,
      onActivity: (activity) => activities.push(activity),
    });
    runtime.start();
    try {
      await waitFor(() => scans >= 4);
      expect(retirements).toBe(1);
      const stopped = runtime.stop();
      expect(runtime.state).toBe("stopping");
      const scansAtDrain = scans;
      release();
      await stopped;
      expect(scans).toBe(scansAtDrain);
      expect(runtime.state).toBe("stopped");
      expect(activities).toContainEqual({
        type: "runtime.failure",
        component: "retirement",
        code: "remote_stop_timeout",
        retryable: true,
      });
      expect(JSON.stringify(activities)).not.toContain(TOKEN);
    } finally {
      release();
      await runtime.stop();
    }
  });

  it("starts maintenance with the HTTP/WebSocket control plane and drains idempotently", async () => {
    const activities: SupervisorMaintenanceActivity[] = [];
    const sandboxPreviewGateway = new SandboxPreviewGateway({
      database,
      previewToken: `preview-${"p".repeat(48)}`,
      publicOriginBaseUrl: "http://preview.localhost:8080",
      allowInsecureInternalHttp: true,
    });
    const runtime = await createControlPlaneRuntime({
      eventRuntime: emptyEventRuntime(),
      database,
      tenantId: IDS.tenant,
      defaultModelProfileId: IDS.profile,
      controlPlaneInstanceId: IDS.controlPlane,
      supervisorAuthorizer: new HashedBearerSupervisorAuthorizer({
        token: TOKEN,
        identity: {
          supervisorId: SUPERVISOR_ID,
          bootId: IDS.boot,
          sandboxId: IDS.sandbox,
        },
      }),
      supervisorOwnerBoundary: {
        async stopAndConfirm() {
          throw new Error("No disconnected Supervisor should be retired in this test");
        },
      },
      assignmentInventoryFactory: () => ({
        async listAssignments() {
          return [];
        },
        async terminateAndConfirmAbsent() {
          throw new Error("An empty inventory cannot terminate an assignment");
        },
      }),
      sandboxPreviewGateway,
      maintenance: {
        maintenanceIntervalMs: 10,
        failurePollMs: 10,
        onActivity(activity) {
          activities.push(activity);
          if (activities.length === 1) {
            throw new Error("Observer failures must not stop maintenance");
          }
        },
      },
    });

    try {
      const address = await runtime.listen(0, "127.0.0.1");
      expect(
        (
          await fetch(
            `${address}/v1/conversations/10000000-0000-4000-8000-000000000001/preview/8000/`,
          )
        ).status,
      ).toBe(401);
      expect(runtime.application.get(SessionEventHub)).toBe(runtime.eventHub);
      await waitFor(() => activities.some((activity) => activity.type === "maintenance.completed"));
      expect(runtime.maintenance.state).toBe("running");

      await Promise.all([runtime.close(), runtime.close()]);
      expect(runtime.state).toBe("closed");
      expect(runtime.maintenance.state).toBe("stopped");
      expect(runtime.gateway.activeConnectionCount).toBe(0);
    } finally {
      await runtime.close();
    }
  });
});
