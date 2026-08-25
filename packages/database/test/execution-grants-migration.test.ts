import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../src/index.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("ExecutionGrant migration", () => {
  it("leaves one current authority table and removes the old execution columns", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 2,
    });
    resources.push(async () => pglite.close());
    resources.push(async () => socket.stop());
    resources.push(async () => database.destroy());

    await runMigrations(database, "up");
    const columns = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name in (
           'execution_grants',
           'run_attempts',
           'sessions',
           'tool_broker_activations',
           'workspace_terminal_sessions'
         )
    `.execute(database);
    const names = new Set(
      columns.rows.map((column) => `${column.table_name}.${column.column_name}`),
    );

    expect(names).toContain("execution_grants.grant_id");
    expect(names).toContain("execution_grants.execution_id");
    expect(names).toContain("execution_grants.last_event_seq");
    expect(names).toContain("run_attempts.execution_grant_id");
    expect(names).toContain("sessions.last_execution_generation");
    expect(names).toContain("tool_broker_activations.execution_grant_id");
    expect(names).toContain("workspace_terminal_sessions.generation");
    expect(names).not.toContain("execution_grants.lease_id");
    expect(names).not.toContain("run_attempts.fencing_token");
  }, 20_000);
});
