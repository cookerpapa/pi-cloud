import { type Database } from "@pi-cloud/database";
import {
  registerManagedDeviceService,
  type ManagedDeviceService,
} from "./managed-device-service.ts";
import { isDeepStrictEqual } from "node:util";
import { sql, type Kysely } from "kysely";
import {
  ANDROID_CAPABILITIES,
  LOCAL_CAPABILITIES,
  parseRegisterResourceDevice,
  parseUuidPathParameter,
} from "@pi-cloud/protocol";
import type { ExecutorTransport } from "@pi-cloud/sandbox-control/executor-transport";

/** Registers an existing device executor. It creates no emulator, disk or Linux Workspace. */
export async function registerResourceDevice(
  database: Kysely<Database>,
  transport: Pick<ExecutorTransport, "inspect">,
  tenant: string,
  input: unknown,
) {
  const tenantId = parseUuidPathParameter(tenant, "tenantId"),
    request = parseRegisterResourceDevice(input);
  const status = await transport.inspect(request.endpoint);
  const capabilities = status.kind === "linux" ? LOCAL_CAPABILITIES : ANDROID_CAPABILITIES;
  if (
    !["android", "linux"].includes(status.kind) ||
    status.targetId !== request.targetId ||
    !capabilities.every((c) => status.capabilities.includes(c))
  )
    throw new Error("Device identity or capabilities do not match");
  let service: ManagedDeviceService | null = null;
  if (request.computeService) {
    const compute = status.provisionedCompute;
    if (status.kind !== "android" || !compute)
      throw new Error("Only a verified managed Android allocation can offer platform compute");
    service = {
      billing: "platform",
      allocationId: compute.allocationId,
      bootId: status.bootId,
      quantity: { kind: "compute", cpuMillis: compute.cpuMillis, memoryBytes: compute.memoryBytes },
    };
  }
  await database.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${"resource-device:" + request.targetId},0))`.execute(
      tx,
    );
    const prior = (
      await sql<{
        tenant_id: string;
        endpoint: string;
        name: string;
        kind: string;
        bound_session_id: string | null;
        compute_service: ManagedDeviceService | null;
      }>`
      select tenant_id,endpoint,name,kind,bound_session_id,compute_service from execution_targets where id=${request.targetId}::uuid for update`.execute(
        tx,
      )
    ).rows[0];
    if (prior) {
      if (
        prior.tenant_id !== tenantId ||
        prior.endpoint !== request.endpoint ||
        prior.name !== request.name ||
        prior.kind !== status.kind
      )
        throw new Error(
          "Device already registered with different identity; unbind and remove it before replacement",
        );
      if (request.computeService === undefined || isDeepStrictEqual(prior.compute_service, service))
        return;
      const pending =
        await sql`select 1 from execution_target_bindings where target_id=${request.targetId}::uuid limit 1`.execute(
          tx,
        );
      if (prior.bound_session_id || pending.rows.length)
        throw new Error("Unbind the idle device before changing its compute service");
      await sql`update execution_targets set compute_service=${service ? JSON.stringify(service) : null}::jsonb,revision=revision+1,updated_at=clock_timestamp() where id=${request.targetId}::uuid`.execute(
        tx,
      );
      if (service) await registerManagedDeviceService(tx, tenantId, request.targetId, service);
      return;
    }
    await sql`insert into execution_targets(id,tenant_id,kind,name,endpoint,capabilities,compute_service)
      values(${request.targetId}::uuid,${tenantId}::uuid,${status.kind},${request.name},${request.endpoint},${JSON.stringify(capabilities)}::jsonb,${service ? JSON.stringify(service) : null}::jsonb)`.execute(
      tx,
    );
    if (service) await registerManagedDeviceService(tx, tenantId, request.targetId, service);
  });
  return { targetId: request.targetId, name: request.name, kind: status.kind };
}
