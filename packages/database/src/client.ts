import { Kysely, PostgresDialect, type PostgresPoolClient } from "kysely";
import { Client, Pool, type PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { Database } from "./database-types.ts";

export type CreateDatabaseOptions = {
  connectionString: string;
  maxConnections?: number;
};

const MAX_PREPARED_SELECTS_PER_CONNECTION = 128;

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
  const connections = new WeakMap<PoolClient, PostgresPoolClient>();
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: {
        Client,
        options: pool.options,
        end: () => pool.end(),
        async connect() {
          const client = await pool.connect();
          let connection = connections.get(client);
          if (!connection) {
            // pg owns parsing, binding, reconnects and errors. Only give stable
            // parameterized SELECTs a name so PostgreSQL can reuse their plans.
            // Bound server-side plans too; other SQL keeps pg's unnamed behavior.
            const statements = new Map<string, string>();
            connection = {
              get processID() {
                return (client as PoolClient & { processID: number }).processID;
              },
              release: () => client.release(),
              query: ((text: unknown, parameters?: readonly unknown[]) => {
                if (typeof text === "string" && /^\s*select\s/i.test(text) && parameters?.length) {
                  let name = statements.get(text);
                  if (!name && statements.size < MAX_PREPARED_SELECTS_PER_CONNECTION) {
                    name = `pc_${createHash("sha256").update(text).digest("base64url")}`;
                    statements.set(text, name);
                  }
                  if (name) return client.query({ name, text, values: [...parameters] });
                }
                return Reflect.apply(client.query, client, [text, parameters]);
              }) as PostgresPoolClient["query"],
            };
            connections.set(client, connection);
          }
          return connection;
        },
      },
    }),
  });
}
