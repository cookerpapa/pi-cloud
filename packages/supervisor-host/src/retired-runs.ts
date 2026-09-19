import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";

/** Terminal state is immutable. New controls cannot be admitted to a terminal
 * Run; missing rows mean its authority and dependent metadata were deleted. */
export async function findRetiredRuns(database: Kysely<Database>, ids: readonly string[]) {
  const retired = new Set<string>();
  for (let start = 0; start < ids.length; start += 1_000) {
    const batch = ids.slice(start, start + 1_000);
    const { rows } = await sql<{ id: string }>`
      select run.id from runs run
      where run.id=any(${batch}::uuid[]) and (
        run.state not in ('completed','failed','cancelled','timed_out')
        or run.output_sealed_at is null
        or exists(select 1 from turn_control_requests control
                   where control.target_run_id=run.id
                     and control.state in ('pending','dispatched','acknowledged'))
      )`.execute(database);
    const blocked = new Set(rows.map((row) => row.id));
    for (const id of batch) if (!blocked.has(id)) retired.add(id);
  }
  return retired;
}
