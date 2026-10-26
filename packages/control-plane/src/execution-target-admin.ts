import { readFile } from "node:fs/promises";
import { createDatabase } from "@pi-cloud/database/client";
import { sql } from "kysely";
import { ANDROID_CAPABILITIES } from "@pi-cloud/protocol";
import { HttpExecutorTransport } from "@pi-cloud/sandbox-control";

/** Operator-only provisioning. No public URL registration or phone lifecycle API. */
async function main() {
  const [action, targetId, tenantId, name, endpoint] = process.argv.slice(2);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !targetId ||
    !tenantId ||
    !uuid.test(targetId) ||
    !uuid.test(tenantId) ||
    !["register", "remove", "check"].includes(action ?? "")
  )
    throw Error(
      "Usage: register TARGET_UUID TENANT_UUID NAME ENDPOINT | remove TARGET_UUID TENANT_UUID",
    );
  const path = process.env.DATABASE_URL_FILE;
  if (!path) throw Error("Database configuration is missing");
  const db = createDatabase({
    connectionString: (await readFile(path, "utf8")).trim(),
    maxConnections: 1,
  });
  const tokenFile = process.env.PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE;
  if (!tokenFile) throw Error("Executor management credential is missing");
  const transport = new HttpExecutorTransport((await readFile(tokenFile, "utf8")).trim());
  try {
    if (action === "check") {
      const pending =
        await sql`select 1 from execution_target_bindings where target_id=${targetId}::uuid
     union all select 1 from runs r join execution_targets t on t.bound_session_id=r.session_id where t.id=${targetId}::uuid and r.state not in ('completed','failed','cancelled','timed_out') limit 1`.execute(
          db,
        );
      if (pending.rows.length)
        throw Error("Settle and close active device work before replacing its executor");
    } else if (action === "remove") {
      await db.transaction().execute(async (tx) => {
        const row = await sql<{
          bound_session_id: string | null;
        }>`select bound_session_id from execution_targets where id=${targetId}::uuid and tenant_id=${tenantId}::uuid for update`.execute(
          tx,
        );
        if (!row.rows[0]) return;
        if (row.rows[0].bound_session_id) throw Error("Unbind the device before removal");
        const bindings =
          await sql`select 1 from execution_target_bindings where target_id=${targetId}::uuid limit 1`.execute(
            tx,
          );
        if (bindings.rows.length)
          throw Error("Confirm admission closure before removing the target");
        await sql`delete from execution_targets where id=${targetId}::uuid and tenant_id=${tenantId}::uuid`.execute(
          tx,
        );
      });
    } else {
      if (!name || name.length > 128 || !endpoint) throw Error("Name and endpoint are required");
      const url = new URL(endpoint);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw Error("Use an internal endpoint origin");
      const status = await transport.inspect(url.origin);
      if (
        status.targetId !== targetId ||
        !ANDROID_CAPABILITIES.every((c) => status.capabilities.includes(c))
      )
        throw Error("Executor identity/capabilities do not match");
      await db.transaction().execute(async (tx) => {
        const prior = await sql<{
          tenant_id: string;
          endpoint: string;
          name: string;
          capabilities: string[];
        }>`select tenant_id,endpoint,name,capabilities from execution_targets where id=${targetId}::uuid for update`.execute(
          tx,
        );
        if (prior.rows[0]) {
          const row = prior.rows[0];
          if (
            row.tenant_id !== tenantId ||
            row.endpoint !== url.origin ||
            row.name !== name ||
            JSON.stringify(row.capabilities) !== JSON.stringify(ANDROID_CAPABILITIES)
          )
            throw Error(
              "Existing target configuration differs; unbind and remove it before reconfiguration",
            );
          return;
        }
        await sql`insert into execution_targets(id,tenant_id,kind,name,endpoint,capabilities) values(${targetId}::uuid,${tenantId}::uuid,'android',${name},${url.origin},${JSON.stringify(ANDROID_CAPABILITIES)}::jsonb)`.execute(
          tx,
        );
      });
    }
    console.log(JSON.stringify({ action, targetId }));
  } finally {
    await transport.close();
    await db.destroy();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Execution target administration failed");
  process.exitCode = 1;
});
