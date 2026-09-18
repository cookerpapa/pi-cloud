import { Kysely, PostgresDialect, type PostgresPoolClient } from "kysely";
import { Client, Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Database } from "./database-types.ts";

export type CreateDatabaseOptions = {
  connectionString: string;
  maxConnections?: number;
  minConnections?: number;
};

const MAX_PREPARED_STATEMENTS_PER_CONNECTION = 128;
const SLOW_COMMIT_MS = 100;

export function createDatabase(options: CreateDatabaseOptions): Kysely<Database> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("connectionString must not be empty");
  }
  const maxConnections = options.maxConnections ?? 10;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new Error("maxConnections must be a positive safe integer");
  }
  const minConnections = options.minConnections ?? Math.min(2, maxConnections);
  if (
    !Number.isSafeInteger(minConnections) ||
    minConnections < 0 ||
    minConnections > maxConnections
  ) {
    throw new Error("minConnections must be an integer between zero and maxConnections");
  }
  // Keep a small warm floor across user/model pauses so named plans survive.
  // pg still creates clients lazily and retires excess idle/broken connections.
  const pool = new Pool({
    connectionString: options.connectionString,
    max: maxConnections,
    min: minConnections,
  });
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
  const connections = new WeakMap<
    PoolClient,
    { connection: PostgresPoolClient; onError(error: Error): void }
  >();
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: {
        Client,
        options: pool.options,
        end: () => pool.end(),
        async connect() {
          const client = await pool.connect();
          let entry = connections.get(client);
          if (!entry) {
            // pg owns parsing, binding, reconnects and errors. Only give stable
            // parameterized SELECT/WITH statements a name so PG can reuse plans.
            // Bound server-side plans too; other SQL keeps pg's unnamed behavior.
            const statements = new Map<string, string>();
            // Names remain client-local even behind a multiplexing test backend.
            const namespace = `pc_${randomUUID().replaceAll("-", "")}_`;
            let failure: Error | undefined;
            // pg's pool only listens while a client is idle. A checked-out
            // client can disconnect between SQL statements, including COMMIT.
            // Fail that transaction and evict the socket, never retry its SQL.
            const onError = (error: Error) => {
              failure ??= error;
            };
            const connection: PostgresPoolClient = {
              get processID() {
                return (client as PoolClient & { processID: number }).processID;
              },
              release: () => {
                client.removeListener("error", onError);
                client.release(failure);
              },
              query: ((text: unknown, parameters?: readonly unknown[]) => {
                if (failure) return Promise.reject(failure);
                if (text === "commit") {
                  const started = performance.now();
                  const loop = performance.eventLoopUtilization();
                  return client.query(text).then((result) => {
                    const durationMs = performance.now() - started;
                    if (durationMs >= SLOW_COMMIT_MS) {
                      const elapsed = performance.eventLoopUtilization(loop);
                      // A slow client COMMIT includes socket/callback delivery.
                      // Report facts, not "disk latency"; never include SQL or values.
                      try {
                        console.warn(
                          JSON.stringify({
                            timestamp: new Date().toISOString(),
                            level: "warn",
                            service: "pi-cloud-database",
                            event: "database.slow_commit",
                            backendPid: (client as PoolClient & { processID: number }).processID,
                            durationMs,
                            eventLoopActiveMs: elapsed.active,
                            eventLoopIdleMs: elapsed.idle,
                          }),
                        );
                      } catch {
                        // A diagnostic sink must not turn a committed transaction into failure.
                      }
                    }
                    return result;
                  });
                }
                if (
                  typeof text === "string" &&
                  /^\s*(select|with)\s/i.test(text) &&
                  parameters?.length
                ) {
                  let name = statements.get(text);
                  if (!name && statements.size < MAX_PREPARED_STATEMENTS_PER_CONNECTION) {
                    name = `${namespace}${statements.size}`;
                    statements.set(text, name);
                  }
                  if (name) return client.query({ name, text, values: [...parameters] });
                }
                return Reflect.apply(client.query, client, [text, parameters]);
              }) as PostgresPoolClient["query"],
            };
            entry = { connection, onError };
            connections.set(client, entry);
          }
          client.on("error", entry.onError);
          return entry.connection;
        },
      },
    }),
  });
}
