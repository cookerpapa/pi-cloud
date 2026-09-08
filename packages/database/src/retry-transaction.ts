import type { Kysely, Transaction } from "kysely";

/** Only for SQL-only callbacks. These SQLSTATEs certify that PostgreSQL aborted
 * the transaction. Never wrap a model call, Kafka append or external Tool effect,
 * and never retry transport/COMMIT uncertainty through this helper. */
export async function retryTransaction<DB, T>(
  database: Kysely<DB>,
  body: (transaction: Transaction<DB>) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await database.transaction().execute(body);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (attempt >= 4 || (code !== "40P01" && code !== "40001")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}
