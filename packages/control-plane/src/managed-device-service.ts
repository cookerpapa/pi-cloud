import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { resourceIdentityHash } from "@pi-cloud/database";

export type ManagedDeviceService = {
  billing: "platform";
  allocationId: string;
  bootId: string;
  quantity: { kind: "compute"; cpuMillis: number; memoryBytes: number };
};

/** Store an operator-approved service fact. This creates no device or execution authority. */
export async function registerManagedDeviceService(
  tx: Transaction<Database>,
  tenantId: string,
  targetId: string,
  service: ManagedDeviceService,
): Promise<void> {
  if (
    !Number.isSafeInteger(service.quantity.cpuMillis) ||
    service.quantity.cpuMillis < 1 ||
    service.quantity.cpuMillis > 1_000_000 ||
    !Number.isSafeInteger(service.quantity.memoryBytes) ||
    service.quantity.memoryBytes < 1
  )
    throw new Error("Managed device capacity is invalid");
  const identity = {
    kind: "compute",
    tenantId,
    resourceId: service.allocationId,
    workspaceId: null,
  };
  const contract = {
    billing: "platform",
    provider: "android",
    sourceKind: "android",
    sourceId: targetId,
    quantity: service.quantity,
  };
  const { rows } =
    await sql`insert into resource_metering_resources(id,tenant_id,workspace_id,kind,resource_id,context,context_hash,service_contract)
    values(${"compute:" + service.allocationId},${tenantId}::uuid,null,'compute',${service.allocationId},${JSON.stringify(identity)}::jsonb,${resourceIdentityHash(identity)},
      ${JSON.stringify(contract)}::jsonb||jsonb_build_object('acceptedAt',clock_timestamp()))
    on conflict(id) do update set context=resource_metering_resources.context
      where resource_metering_resources.context_hash=${resourceIdentityHash(identity)}
        and resource_metering_resources.service_contract->>'sourceId'=${targetId}
        and resource_metering_resources.service_contract->'quantity'=${JSON.stringify(service.quantity)}::jsonb
    returning id`.execute(tx);
  if (!rows.length) throw new Error("Managed device allocation identity or capacity changed");
  await sql`select pi_cloud_compute_service_state(${"compute:" + service.allocationId},true,clock_timestamp(),'ready')`.execute(
    tx,
  );
}

export async function observeManagedDeviceService(
  database: Kysely<Database>,
  allocationId: string,
  available: boolean,
): Promise<void> {
  await sql`select pi_cloud_compute_service_state(${"compute:" + allocationId},${available},clock_timestamp(),'unavailable')`.execute(
    database,
  );
}
