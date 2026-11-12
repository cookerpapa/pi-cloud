import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import {
  ANDROID_CAPABILITIES,
  parseRegisterResourceDevice,
  parseUuidPathParameter,
} from "@pi-cloud/protocol";
import type { ExecutorTransport } from "@pi-cloud/sandbox-control";

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
  if (
    status.targetId !== request.targetId ||
    !ANDROID_CAPABILITIES.every((c) => status.capabilities.includes(c))
  )
    throw new Error("Device identity or capabilities do not match");
  await database.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${"resource-device:" + request.targetId},0))`.execute(
      tx,
    );
    const prior = (
      await sql<{ tenant_id: string; endpoint: string; name: string }>`
      select tenant_id,endpoint,name from execution_targets where id=${request.targetId}::uuid for update`.execute(
        tx,
      )
    ).rows[0];
    if (prior) {
      if (
        prior.tenant_id !== tenantId ||
        prior.endpoint !== request.endpoint ||
        prior.name !== request.name
      )
        throw new Error(
          "Device already registered with different identity; unbind and remove it before replacement",
        );
      return;
    }
    await sql`insert into execution_targets(id,tenant_id,kind,name,endpoint,capabilities)
      values(${request.targetId}::uuid,${tenantId}::uuid,'android',${request.name},${request.endpoint},${JSON.stringify(ANDROID_CAPABILITIES)}::jsonb)`.execute(
      tx,
    );
  });
  return { targetId: request.targetId, name: request.name, kind: "android" as const };
}
