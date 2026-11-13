import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { type ManagedDeviceService } from "../src/managed-device-service.ts";
import { ANDROID_CAPABILITIES, LOCAL_CAPABILITIES } from "@pi-cloud/protocol";
import type { ExecutorStatus } from "@pi-cloud/sandbox-control/executor-transport";
import { it, expect } from "vitest";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { registerResourceDevice } from "../src/execution-target-registration.ts";
import { ManagedDeviceServiceObserver } from "../src/managed-device-service-observer.ts";

it("requires explicit managed Android enrollment and never bills an ordinary registered device", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 6,
  });
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Owned service fixture",
    });
    const request = {
      targetId: randomUUID(),
      name: "Android fixture",
      endpoint: "http://fixture:8090",
    };
    const status: ExecutorStatus = {
      kind: "android",
      targetId: request.targetId,
      bootId: randomUUID(),
      ready: true,
      capabilities: [...ANDROID_CAPABILITIES],
      provisionedCompute: {
        allocationId: randomUUID(),
        cpuMillis: 2000,
        memoryBytes: 3 * 1024 ** 3,
      },
    };
    let reachable = true;
    const transport = {
      inspect: async () => {
        if (!reachable) throw new Error("unavailable");
        return status;
      },
    };
    await registerResourceDevice(db, transport, tenant.tenantId, request);
    expect(
      (
        await sql`select 1 from resource_metering_resources where tenant_id=${tenant.tenantId}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
    await registerResourceDevice(db, transport, tenant.tenantId, {
      ...request,
      computeService: { billing: "platform" },
    });
    const registered = (
      await sql<{
        context: { workspaceId: unknown };
      }>`select context from resource_metering_resources where tenant_id=${tenant.tenantId}::uuid`.execute(
        db,
      )
    ).rows;
    expect(registered).toHaveLength(1);
    expect(registered[0]!.context.workspaceId).toBeNull();
    const observer = new ManagedDeviceServiceObserver(db, transport);
    const row = async () =>
      (
        await sql<{
          id: string;
          tenant_id: string;
          endpoint: string;
          compute_service: ManagedDeviceService;
        }>`select id,tenant_id,endpoint,compute_service from execution_targets where id=${request.targetId}::uuid`.execute(
          db,
        )
      ).rows[0]!;
    status.bootId = randomUUID();
    await observer.observe(await row());
    reachable = false;
    await observer.observe(await row());
    await observer.close();
    const periods = (
      await sql<{
        ended_at: Date | null;
        end_reason: string;
      }>`select ended_at,end_reason from compute_service_periods where tenant_id=${tenant.tenantId}::uuid order by opened_at`.execute(
        db,
      )
    ).rows;
    expect(periods).toHaveLength(2);
    expect(periods.every((period) => period.ended_at !== null)).toBe(true);
    expect(periods[0]!.end_reason).toBe("instance_changed");
    const local = {
      targetId: randomUUID(),
      name: "Own computer",
      endpoint: "http://device-link:8090/targets/" + randomUUID(),
    };
    const localTransport = {
      inspect: async (): Promise<ExecutorStatus> => ({
        kind: "linux",
        targetId: local.targetId,
        bootId: randomUUID(),
        ready: true,
        capabilities: [...LOCAL_CAPABILITIES],
      }),
    };
    await expect(
      registerResourceDevice(db, localTransport, tenant.tenantId, {
        ...local,
        computeService: { billing: "platform" },
      }),
    ).rejects.toThrow("managed Android");
    await registerResourceDevice(db, localTransport, tenant.tenantId, local);
    expect(
      (
        await sql`select 1 from resource_metering_resources where service_contract->>'sourceId'=${local.targetId}`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await db.destroy();
  }
}, 30_000);
