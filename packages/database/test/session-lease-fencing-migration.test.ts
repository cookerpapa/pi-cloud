import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../src/index.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("Session lease and fencing migration", () => {
  it("leaves one lease authority and removes the secondary Tool capability", async () => {
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
           'session_leases',
           'run_attempts',
           'sessions',
           'tool_broker_activations',
           'workspace_terminal_sessions'
         )
    `.execute(database);
    const names = new Set(
      columns.rows.map((column) => `${column.table_name}.${column.column_name}`),
    );

    expect(names).toContain("session_leases.lease_id");
    expect(names).toContain("session_leases.fencing_token");
    expect(names).toContain("session_leases.attempt_id");
    expect(names).toContain("session_leases.last_event_seq");
    expect(names).toContain("run_attempts.lease_id");
    expect(names).toContain("run_attempts.fencing_token");
    expect(names).toContain("sessions.last_fencing_token");
    expect(names).toContain("tool_broker_activations.lease_id");
    expect(names).toContain("tool_broker_activations.fencing_token");
    expect(names).toContain("workspace_terminal_sessions.fencing_token");
    expect(names).not.toContain("tool_broker_activations.capability_sha256");
  }, 20_000);
});
