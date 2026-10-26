import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { ANDROID_CAPABILITIES, parseSessionControlChange } from "@pi-cloud/protocol";
import { type ExecutorTransport } from "@pi-cloud/sandbox-control";
import { ExecutionTargetService, ExecutionBindingView } from "../src/execution-target-service.ts";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { createTestWorker } from "./admit-test-execution.ts";
const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
it.skipIf(!postgres)(
  "freezes device grants at Run acceptance, orders routes and retains unavailable closures",
  async () => {
    const name = "android_" + randomUUID().replaceAll("-", "");
    const admin = createDatabase({ connectionString: postgres!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const endpoint = new URL(postgres!);
    endpoint.pathname = "/" + name;
    const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 8 });
    let release = () => {};
    let work: Promise<unknown> | undefined;
    try {
      await runMigrations(db, "up");
      const tenant = await createPrivateTenant(db, {
        slug: name.replaceAll("_", "-"),
        ownerDisplayName: "Android fixture",
      });
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const project = await store.createProject({
        name: "Android fixture",
        source: { kind: "empty" },
      });
      await db
        .updateTable("environment_versions")
        .set({ state: "validated", validated_at: new Date() })
        .where("id", "=", project.environment.environmentVersionId)
        .execute();
      const [a, b] = await Promise.all([
        store.createSession(project.projectId, project.workspaceId, "A", "elastic"),
        store.createSession(project.projectId, project.workspaceId, "B", "elastic"),
      ]);
      const target = randomUUID(),
        bootId = randomUUID();
      await sql`insert into execution_targets(id,tenant_id,kind,name,endpoint,capabilities) values(${target}::uuid,${tenant.tenantId}::uuid,'android','Android','http://fixture:8090',${JSON.stringify(ANDROID_CAPABILITIES)}::jsonb)`.execute(
        db,
      );
      const revoke = vi.fn(async () => {});
      const transport: ExecutorTransport = {
        inspect: async () => ({
          targetId: target,
          bootId,
          ready: true,
          capabilities: [...ANDROID_CAPABILITIES],
        }),
        revoke,
        submit: async () => {},
        cancel: async () => {},
        screenshot: async () => Buffer.alloc(0),
        close: async () => {},
      };
      const published: string[] = [];
      const service = new ExecutionTargetService({
        database: db,
        transport,
        publish: async (ids) => {
          published.push(...ids);
        },
      });
      const selections = await Promise.all([
        service.selection(tenant.tenantId, a.sessionId),
        service.selection(tenant.tenantId, b.sessionId),
      ]);
      const races = await Promise.allSettled([
        service.bindSession(tenant.tenantId, a.sessionId, target, selections[0]!.revision),
        service.bindSession(tenant.tenantId, b.sessionId, target, selections[1]!.revision),
      ]);
      expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const winner = races[0]!.status === "fulfilled" ? a : b;
      const selected = await service.selection(tenant.tenantId, winner.sessionId);
      expect(selected.target?.targetId).toBe(target);
      await expect(
        service.bindSession(tenant.tenantId, winner.sessionId, null, "0"),
      ).rejects.toThrow("changed");
      await expect(service.selection(randomUUID(), winner.sessionId)).rejects.toThrow("not found");
      const accepted = await store.acceptTurn(winner.sessionId, "android-input", {
        prompt: "Observe this phone",
      });
      const frozen = await db
        .selectFrom("runs")
        .select("execution_target_snapshot")
        .where("id", "=", accepted.runId)
        .executeTakeFirstOrThrow();
      expect(frozen.execution_target_snapshot).toEqual([selected.target]);
      const worker = await createTestWorker(db);
      const started =
        Promise.withResolvers<
          import("@pi-cloud/runtime-core/run-executor").TurnExecutionAdmission
        >();
      work = worker
        .executor({
          execute: async (_request, _lifecycle, admission) => {
            started.resolve(admission);
            await new Promise<void>((r) => {
              release = r;
            });
            return { stopReason: "stop" };
          },
        })
        .dispatchRun(accepted.runId);
      const admission = await started.promise;
      await expect(
        service.bindSession(tenant.tenantId, winner.sessionId, null, selected.revision),
      ).rejects.toThrow();
      const view = new ExecutionBindingView(service, 1);
      await view.load([0], () => true);
      const id = await service.prepare(admission.executionReference, selected.target!);
      expect(published).toContain(id);
      expect(await service.prepare(admission.executionReference, selected.target!)).toBe(id);
      const row = (await service.read(id))!;
      const scope = {
        tenantId: tenant.tenantId,
        sessionId: winner.sessionId,
        runId: accepted.runId,
        piSessionId: row.pi_session_id,
        writerId: row.writer_id,
        fencingToken: Number(row.fencing_token),
      };
      const outbox = await db
        .selectFrom("outbox")
        .select("payload")
        .where("aggregate_id", "=", id)
        .executeTakeFirstOrThrow();
      const change = parseSessionControlChange(outbox.payload);
      await view.prepare(change, () => true);
      expect(view.get(id, scope)).toBeUndefined();
      await view.consume(change, () => true);
      expect(view.get(id, scope)?.id).toBe(id);
      expect(view.get(id, { ...scope, tenantId: randomUUID() })).toBeUndefined();
      revoke.mockRejectedValue(new Error("endpoint down"));
      await view.closeWriter(scope);
      expect(view.get(id, scope)).toBeUndefined();
      expect((await service.read(id))?.closed).toBe(true);
      // Replaying an older open notification cannot undo the durable close.
      await view.prepare(change, () => true);
      await view.consume(change, () => true);
      expect(view.get(id, scope)).toBeUndefined();
      await expect(service.prepare(admission.executionReference, selected.target!)).rejects.toThrow(
        "closed",
      );
      revoke.mockResolvedValue();
      await service.cleanup();
      expect(await service.read(id)).toBeUndefined();
      release();
      await work;
      work = undefined;
      await service.bindSession(
        tenant.tenantId,
        winner.sessionId,
        null,
        (await service.selection(tenant.tenantId, winner.sessionId)).revision,
      );
      expect((await service.selection(tenant.tenantId, winner.sessionId)).target).toBeNull();
    } finally {
      release();
      await work?.catch(() => {});
      await db.destroy();
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    }
  },
  60000,
);
