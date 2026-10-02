import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import type { SandboxExecutionTarget } from "./sandbox-execution.ts";

/** Deny further effects for this recorded physical target. No network I/O and
 * no VM deletion/quota release; publication confirmation is a separate step. */
export async function quarantineExecutionTarget(
  database: Kysely<Database>,
  target: SandboxExecutionTarget,
): Promise<readonly string[]> {
  const exact = sql<boolean>`descriptor->'target'->>'sandboxId'=${target.sandboxId}
    and descriptor->'target'->>'apiUrl'=${target.apiUrl}
    and descriptor->'target'->>'nodeId'=${target.nodeId}
    and descriptor->'target'->>'bootId'=${target.bootId}`;
  return database.transaction().execute(async (tx) => {
    const routes = await tx
      .selectFrom("sandbox_tool_bindings")
      .select("snapshot")
      .where(exact)
      .execute();
    const ids = [
      ...new Set(
        routes
          .map((row) => row.snapshot.physicalActivationId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    if (!ids.length) return [];
    // Use the same resource -> binding lock order as controller quarantine.
    // An old binding cannot mark a rebuilt machine's new physical VM UNKNOWN.
    const workspaces = await tx
      .updateTable("workspace_runtimes")
      .set({
        state: "unknown",
        failure_code: "execution_stop_unconfirmed",
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where("workspace_runtime_id", "in", ids)
      .where("runtime_name", "=", target.sandboxId)
      .where("state", "not in", ["released", "cleaning"])
      .returning("workspace_runtime_id")
      .execute();
    const machines = await tx
      .updateTable("development_environments")
      .set({
        state: "unknown",
        failure_code: "execution_stop_unconfirmed",
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where("id", "in", ids)
      .where("runtime_name", "=", target.sandboxId)
      .where("state", "not in", ["released", "releasing", "failed"])
      .returning("id")
      .execute();
    const quarantined = [
      ...workspaces.map((row) => row.workspace_runtime_id),
      ...machines.map((row) => row.id),
    ];
    const closed = await tx
      .updateTable("sandbox_tool_bindings")
      .set({ dispatch_closed: true })
      .where((eb) =>
        eb.or([
          exact,
          ...(quarantined.length
            ? [eb(sql<string>`snapshot->>'physicalActivationId'`, "in", quarantined)]
            : []),
        ]),
      )
      .returning("binding_id")
      .execute();
    return closed.map((row) => row.binding_id);
  });
}
