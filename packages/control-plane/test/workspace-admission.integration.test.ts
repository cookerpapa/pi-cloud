import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely, type QueryId } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";

const connectionString = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

// PGlite shares a single backend and cannot exercise independent row-lock owners.
// CI supplies real PostgreSQL; use a disposable database, never its application tables.
describe.skipIf(connectionString === undefined)("Workspace deletion / message admission", () => {
  const databaseName = `workspace_admission_${randomUUID().replaceAll("-", "")}`;
  let administrator: Kysely<Database>;
  let database: Kysely<Database>;
  let store: ControlPlaneStore;
  let scope: { tenantId: string; defaultModelProfileId: string };

  beforeAll(async () => {
    administrator = createDatabase({ connectionString: connectionString!, maxConnections: 1 });
    await sql`create database ${sql.id(databaseName)}`.execute(administrator);
    const url = new URL(connectionString!);
    url.pathname = `/${databaseName}`;
    url.searchParams.set("application_name", databaseName);
    url.searchParams.set(
      "options",
      "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000",
    );
    database = createDatabase({ connectionString: url.toString(), maxConnections: 5 });
    await runMigrations(database, "up");
    scope = await createPrivateTenant(database, {
      slug: "workspace-admission",
      ownerDisplayName: "Workspace admission test",
    });
    store = new ControlPlaneStore({ database, ...scope });
  }, 60_000);

  afterAll(async () => {
    await database?.destroy();
    if (administrator) {
      await sql`drop database if exists ${sql.id(databaseName)}`.execute(administrator);
      await administrator.destroy();
    }
  });

  async function fixture(name: string) {
    const project = await store.createProject({ name, source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      name,
      "elastic",
    );
    return { project, session };
  }

  function pauseAfterInsert(table: string) {
    let notifyWaiting!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      notifyWaiting = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = new WeakSet<QueryId>();
    const paused = database.withPlugin({
      transformQuery({ node, queryId }) {
        const query = database.getExecutor().compileQuery(node, queryId);
        if (query.sql.startsWith(`insert into "${table}"`)) selected.add(queryId);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (selected.has(queryId)) {
          notifyWaiting();
          await released;
        }
        return result;
      },
    });
    return {
      store: new ControlPlaneStore({ database: paused, ...scope }),
      waiting,
      release,
    };
  }

  async function waitForContender() {
    await vi.waitFor(
      async () => {
        const result = await sql<{ count: string }>`
        select count(*)::text as count from pg_stat_activity
        where application_name = ${databaseName} and wait_event_type = 'Lock'
      `.execute(database);
        expect(Number(result.rows[0]!.count)).toBeGreaterThan(0);
      },
      { timeout: 3_000, interval: 10 },
    );
  }

  it("rejects a message if concurrent deletion commits after its Workspace lookup begins", async () => {
    const { project, session } = await fixture("deletion-first");
    const paused = pauseAfterInsert("workspace_delete_operations");
    const deletion = paused.store.deleteWorkspace(project.workspaceId, "delete-first");
    let admission: Promise<unknown> | undefined;
    try {
      await paused.waiting;
      admission = store
        .acceptTurn(session.sessionId, "racing-message", { prompt: "do not lose me" })
        .then(
          (value) => ({ accepted: value }),
          (error) => ({ rejected: error }),
        );
      await waitForContender();
    } finally {
      paused.release();
    }
    await deletion;
    expect(await admission).toMatchObject({ rejected: { code: "conflict" } });
    expect(
      await database
        .selectFrom("turns")
        .select("id")
        .where("session_id", "=", session.sessionId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom("runs")
        .select("id")
        .where("session_id", "=", session.sessionId)
        .execute(),
    ).toHaveLength(0);
  });

  it("lets admitted work prevent deletion without taking an exclusive Workspace lock", async () => {
    const { project, session } = await fixture("admission-first");
    const paused = pauseAfterInsert("runs");
    const admission = paused.store.acceptTurn(session.sessionId, "accept-first", {
      prompt: "keep me",
    });
    let deletion: Promise<unknown> | undefined;
    try {
      await paused.waiting;
      // Another Session may perform its own admission check concurrently.
      await database.transaction().execute(async (transaction) => {
        await sql`select id from workspaces where id = ${project.workspaceId} for share nowait`.execute(
          transaction,
        );
      });
      deletion = store.deleteWorkspace(project.workspaceId, "delete-second").then(
        (value) => ({ deleted: value }),
        (error) => ({ rejected: error }),
      );
      await waitForContender();
    } finally {
      paused.release();
    }
    const accepted = await admission;
    expect(await deletion).toMatchObject({ rejected: { code: "conflict" } });
    expect(
      await database
        .selectFrom("runs")
        .select(["id", "state"])
        .where("id", "=", accepted.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: accepted.runId, state: "queued" });
    expect(
      await database
        .selectFrom("workspaces")
        .select("deleted_at")
        .where("id", "=", project.workspaceId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ deleted_at: null });
  });
});
