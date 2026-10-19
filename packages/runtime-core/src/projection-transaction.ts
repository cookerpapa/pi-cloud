import type { Database } from "@pi-cloud/database";
import { sql, type Kysely, type Transaction } from "kysely";

export type ProjectionBudget = Readonly<{ lockTimeoutMs: number; statementTimeoutMs: number }>;
export const PROJECTION_BUDGET: ProjectionBudget = Object.freeze({
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 10_000,
});

/** Server cancellation and transaction rollback, not a client Promise timeout.
 * Budgets cover each lock/statement. Production also supplies a bounded checkout
 * pool for acquisition and client I/O, including COMMIT. An uncertain return is
 * reconciled by ordered replay; no offset advances after an SQL failure. */
export async function projectionTransaction<T>(
  database: Kysely<Database>,
  work: (transaction: Transaction<Database>) => Promise<T>,
  budget: ProjectionBudget = PROJECTION_BUDGET,
): Promise<T> {
  if (
    !Number.isSafeInteger(budget.lockTimeoutMs) ||
    budget.lockTimeoutMs < 1 ||
    !Number.isSafeInteger(budget.statementTimeoutMs) ||
    budget.statementTimeoutMs <= budget.lockTimeoutMs
  )
    throw new TypeError("Invalid projection transaction budget");
  return database.transaction().execute(async (transaction) => {
    await sql`select set_config('lock_timeout', ${`${budget.lockTimeoutMs}ms`}, true),
      set_config('statement_timeout', ${`${budget.statementTimeoutMs}ms`}, true)`.execute(
      transaction,
    );
    return work(transaction);
  });
}
