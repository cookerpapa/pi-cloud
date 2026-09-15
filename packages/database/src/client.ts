import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "./database-types.ts";

export type CreateDatabaseOptions = {
  connectionString: string;
  maxConnections?: number;
};

export function createDatabase(options: CreateDatabaseOptions): Kysely<Database> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("connectionString must not be empty");
  }
  const maxConnections = options.maxConnections ?? 10;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new Error("maxConnections must be a positive safe integer");
  }
  const pool = new Pool({ connectionString: options.connectionString, max: maxConnections });
  // pg removes a broken idle client itself. Observe that background event
  // without crashing unrelated Runs or retrying an in-flight SQL operation.
  pool.on("error", (error) => {
    const code = (error as { code?: unknown }).code;
    // The attached pg Client can contain credentials; never log the raw error.
    console.error(
      JSON.stringify({
        level: "error",
        service: "pi-cloud-database",
        event: "database.idle_connection_lost",
        code: typeof code === "string" ? code : "unknown",
      }),
    );
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
