// Creates and drops an isolated database; records the behavior of the named audit baseline.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const root = fileURLToPath(new URL("../", import.meta.url));
const { createDatabase, runMigrations } = await import(root + "/packages/database/src/index.ts");
const { sql } = await import(root + "/node_modules/kysely/dist/index.js");
const { ControlPlaneStore } = await import(
  root + "/packages/control-plane/src/control-plane-store.ts"
);
const { createPrivateTenant } = await import(
  root + "/packages/control-plane/src/tenant-administration.ts"
);
const { ConversationArchiveService } = await import(
  root + "/packages/control-plane/src/conversation-archive-service.ts"
);
const { PostgresSubagentJobProvider } = await import(
  root + "/packages/subagent-control/src/postgres-subagent-job-provider.ts"
);
const { createTestWorker } = await import(
  root + "/packages/control-plane/test/admit-test-execution.ts"
);
const { projectNativeSessionAppend } = await import(
  root + "/packages/pi-session-postgres/src/project-native-session-append.ts"
);
const { parseConversationDetailResource } = await import(root + "/packages/protocol/src/index.ts");
if (!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)
  throw new Error("Provide an isolated PostgreSQL administrator URL");
const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL);
const admin = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
const name = "review_boundaries_" + crypto.randomUUID().replaceAll("-", "");
await sql`create database ${sql.id(name)}`.execute(admin);
url.pathname = "/" + name;
const db = createDatabase({ connectionString: url.toString(), maxConnections: 5 });
const report = {
  method: "isolated PostgreSQL with current migrations and production service methods",
  inherited: [],
  quota: {},
};
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: "review-inheritance",
    ownerDisplayName: "Review",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "Review", source: { kind: "empty" } });
  const source = await readFile(
    root + "/packages/control-plane/src/conversation-reader.ts",
    "utf8",
  );
  const cap = Number(source.match(/MAX_INHERITED_MESSAGES\s*=\s*([\d_]+)/)[1].replaceAll("_", ""));
  report.inheritedLimit = cap;
  for (const n of [10, cap + 1]) {
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "History " + n,
      "elastic",
    );
    const pi = await db
      .selectFrom("sessions")
      .select("pi_session_id")
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    const items = [];
    let parent = null;
    for (let i = 1; i <= n + 1; i++) {
      const id = "entry-" + i;
      items.push({
        kind: "entry",
        lane: "main",
        turnId: null,
        entry:
          i <= n
            ? {
                id,
                parentId: parent,
                seq: i,
                timestamp: i,
                type: "message",
                message: { role: "user", content: [{ type: "text", text: "old" }], timestamp: i },
              }
            : {
                id,
                parentId: parent,
                seq: i,
                timestamp: i,
                type: "compaction",
                summary: "The old work is summarized.",
                retainedTail: [],
                tokensBefore: n,
              },
      });
      parent = id;
    }
    await db.transaction().execute((tx) =>
      projectNativeSessionAppend(tx, {
        tenantId: tenant.tenantId,
        sessionId: pi.pi_session_id,
        appendId: crypto.randomUUID(),
        items,
      }),
    );
    const accepted = await store.acceptTurn(session.sessionId, "parent", {
        prompt: "Delegate a small task",
      }),
      worker = await createTestWorker(db);
    const entered = Promise.withResolvers(),
      finish = Promise.withResolvers();
    let grant;
    const running = worker
      .executor({
        execute: async (_r, _l, a) => {
          grant = a;
          entered.resolve();
          await finish.promise;
          return { stopReason: "stop" };
        },
      })
      .dispatchRun(accepted.runId);
    void running.catch(entered.reject);
    await entered.promise;
    try {
      const jobs = new PostgresSubagentJobProvider({
        database: db,
        nativeLanes: { childAnchor: () => parent, createChildLane: async () => {} },
      });
      const child = await jobs.start(
        {
          tenantId: tenant.tenantId,
          parentSessionId: session.sessionId,
          parentRunId: accepted.runId,
          parentExecutionReference: grant.executionReference,
          parentToolCallId: "fixture-tool",
          workflowRunId: "fixture-workflow",
          stepIndex: 0,
          agentName: "review",
          prompt: n === 10 ? "x".repeat(200_000) : "Small child task",
          contextMode: "branch",
          sandboxMode: "none",
          contextAnchor: parent,
        },
        true,
      );
      let result;
      try {
        const view = await store.getConversation(child.childSessionId);
        result = { ok: true, inheritedMessages: view.inheritedMessages.length };
        if (n === 10) {
          const admitted = await db
            .selectFrom("turns")
            .select(["id", "input_text"])
            .where("tenant_id", "=", tenant.tenantId)
            .where("session_id", "=", child.childSessionId)
            .executeTakeFirstOrThrow();
          // Queued Turns are intentionally absent from the view. Exercise the public
          // schema with its persisted prompt and the active-turn shape emitted by
          // ConversationReader, without pretending to execute the child Agent.
          let publicViewAccepted = true;
          let publicViewError;
          try {
            parseConversationDetailResource({
              ...view,
              turns: [
                {
                  runId: child.childRunId,
                  turnId: admitted.id,
                  mailboxPosition: 1,
                  prompt: admitted.input_text,
                  state: "running",
                  acceptedAt: new Date().toISOString(),
                  originSessionId: child.childSessionId,
                },
              ],
            });
          } catch (error) {
            publicViewAccepted = false;
            publicViewError = error.message;
          }
          report.inputBudget = {
            method: "real admitted prompt, public response parser with synthetic active-turn state",
            admittedPromptCharacters: admitted.input_text.length,
            publicViewAccepted,
            publicViewError,
          };
        }
      } catch (error) {
        result = { ok: false, code: error.code, message: error.message };
      }
      report.inherited.push({
        oldMessages: n,
        latestAncestor: "compaction with empty retained tail",
        result,
      });
    } finally {
      finish.resolve();
      await running;
    }
  }
  const q = await createPrivateTenant(db, {
    slug: "review-quota",
    ownerDisplayName: "Quota",
    quotas: { maximumProjects: 10, maximumSessions: 1 },
  });
  const s = new ControlPlaneStore({ database: db, ...q });
  const p = await s.createProject({ name: "Quota", source: { kind: "empty" } });
  const first = await s.createSession(p.projectId, p.workspaceId, "First", "elastic");
  await new ConversationArchiveService({ database: db }).archive(
    q.tenantId,
    "delete",
    first.sessionId,
    { archived: true },
  );
  const visible = await db
    .selectFrom("sessions")
    .select("id")
    .where("tenant_id", "=", q.tenantId)
    .where("archived_at", "is", null)
    .execute();
  let after;
  try {
    await s.createSession(p.projectId, p.workspaceId, "Second", "elastic");
    after = "accepted";
  } catch (error) {
    after = error.code;
  }
  report.quota = { maximumSessions: 1, visibleSessions: visible.length, newSession: after };
  assert.equal(report.inherited[1].result.code, "invalid_request");
  assert.equal(report.inputBudget.admittedPromptCharacters, 200_000);
  assert.equal(report.inputBudget.publicViewAccepted, false);
  assert.equal(visible.length, 0);
  assert.equal(after, "tenant_quota_exceeded");
} catch (error) {
  report.probeError = { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-review-pg.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await db.destroy();
  await sql`drop database ${sql.id(name)}`.execute(admin);
  await admin.destroy();
}
console.log(JSON.stringify(report));
