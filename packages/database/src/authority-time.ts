import { sql, type Kysely } from "kysely";
import type { Database } from "./database-types.ts";

/** Read after authority/lifecycle locks. Unlike now(), this is not transaction-start time. */
export async function databaseTime(database: Kysely<Database>): Promise<Date> {
  const result = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(database);
  return result.rows[0]!.now;
}
