import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";

/** Re-admission only. Native intent checkpoints provide a conservative budget
 * floor; they never prove that a provider request or shell effect completed.
 * Unlimited Runs do not need this read. No independent billing/operation ledger. */
export async function readDurableRunUsage(
  database: Kysely<Database>,
  tenantId: string,
  runId: string,
): Promise<{ modelRequests: number; toolCalls: number }> {
  const rows = await sql<{ body: string }>`select log.body from pi_durable_records task
    join pi_durable_log log on log.tenant_id=task.tenant_id and log.session_id=task.session_id and log.record_id=task.id
    where task.tenant_id=${tenantId}::uuid and task.fields->>'run'=${runId} and task.kind='task'
      and log.phase=any(${["request", "summarize", "execute"].map((phase) => JSON.stringify(phase))}::text[])`.execute(
    database,
  );
  const models = new Set<string>(),
    tools = new Set<number>();
  for (const row of rows.rows) {
    const task = JSON.parse(row.body).value;
    const checkpoint = task.state.checkpoint;
    if (task.kind === "pi.tool" && checkpoint?.phase === "execute") tools.add(task.id);
    else if (
      (task.kind === "pi.generation" && checkpoint?.phase === "request") ||
      (task.kind === "pi.compaction" && checkpoint?.phase === "summarize")
    ) {
      models.add(
        JSON.stringify([
          task.id,
          checkpoint.phase,
          checkpoint.attempt,
          checkpoint.cutoff,
          checkpoint.tail,
        ]),
      );
    }
  }
  return { modelRequests: models.size, toolCalls: tools.size };
}
