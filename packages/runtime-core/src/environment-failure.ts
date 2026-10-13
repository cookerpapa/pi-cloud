import { randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import type { Transaction } from "kysely";

/** The failed environment belongs to the immutable root work configuration. */
export async function recordEnvironmentFailure(
  tx: Transaction<Database>,
  input: { tenantId: string; runId: string; code: string; now: Date },
): Promise<void> {
  if (!input.code.startsWith("environment_")) return;
  const run = await tx
    .selectFrom("runs")
    .select(["project_id", "environment_version_id"])
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.runId)
    .executeTakeFirstOrThrow();
  await tx
    .insertInto("environment_validations")
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      project_id: run.project_id,
      environment_version_id: run.environment_version_id,
      run_id: input.runId,
      status: "failed",
      report: null,
      failure_code: input.code,
      validated_at: input.now,
    })
    .onConflict((c) => c.columns(["environment_version_id", "run_id"]).doNothing())
    .execute();
  await tx
    .updateTable("environment_versions")
    .set({ state: "failed", failure_code: input.code, validated_at: null, updated_at: input.now })
    .where("tenant_id", "=", input.tenantId)
    .where("project_id", "=", run.project_id)
    .where("id", "=", run.environment_version_id)
    .executeTakeFirstOrThrow();
}
