import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { sql } from "kysely";
const load = (p) => import(new URL(p, pathToFileURL(process.cwd() + "/")));
const { createDatabase } = await load("packages/database/src/index.ts");
const { createPrivateTenant } = await load("packages/control-plane/src/tenant-administration.ts");
const { PiCloudApi, newIdempotencyKey } = await load("packages/web-ui/src/api.ts");
const { runtimeDirectory, serviceAddress, runtimeEnvironment } = await load(
  "scripts/lib/production-kubernetes.mjs",
);
const { crashOwnedWorker } = await load("scripts/lib/owned-worker-crash.mjs");
const { purgeOwnedAcceptanceTenant, settleOwnedAcceptanceRuns } = await load(
  "scripts/lib/owned-acceptance-cleanup.mjs",
);
const { nativeHistory } = await load("scripts/lib/native-session-history.mjs");
const { S3ImageBlobStore } = await load("packages/session-attachments/src/s3.ts");
const { DurablePostgresProjection, materializeNativeDocument } = await load(
  "packages/pi-session-postgres/src/durable/postgres-projection.ts",
);
assert.equal(process.env.PI_CLOUD_LIVE_CHILD_RECOVERY_CHECK, "1");
const output = process.argv[2] ?? "/tmp/pi-cloud-child-worker-recovery.json";
const url = new URL((await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim());
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 3 });
const base = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
const report = {
  at: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
};
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const phase = (name) => {
  report.phase = name;
  console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
};
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, budget = 240000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(label + " timed out");
}
let tenant, api, project, session, run, failure;
async function finished(id) {
  return until(
    async () => {
      const r = await api.getRun(id);
      return terminal(r) && r;
    },
    "Run completion",
    360000,
  );
}
async function configHash(conversationId) {
  const projection = new DurablePostgresProjection(db, {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
  });
  const docs = await projection.scan(
    { kind: "document", fields: { nativeKind: JSON.stringify("pi.agent") } },
    128,
  );
  const row = docs.find(
    (r) => r.value.scope.kind === "conversation" && r.value.scope.conversationId === conversationId,
  );
  assert(row);
  const head = await projection.head();
  const revisions = await projection.revisions(row.value.id, head.seq);
  const doc = materializeNativeDocument(row.value, revisions);
  return {
    id: row.value.id,
    sha256: createHash("sha256").update(JSON.stringify(doc.value)).digest("hex"),
    revisions: revisions.length,
  };
}
async function receipt(conversationId) {
  const { rows } =
    await sql`select id::text from pi_durable_records where tenant_id=${tenant.tenantId}::uuid and session_id=${session.sessionId} and kind='submission' and fields->>'conversation'=${String(conversationId)} and fields->>'request'=${JSON.stringify(run.runId)}`.execute(
      db,
    );
  assert.equal(rows.length, 1);
  return rows[0].id;
}
try {
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-child-recovery-" + Date.now().toString(36),
    ownerDisplayName: "Owned child recovery acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), base), init),
    tenant.credential.token,
  );
  project = await api.createProject("Owned child Worker recovery", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Child Worker recovery",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
    workspaceId: project.workspaceId,
  };
  await save();
  phase("start one native child");
  run = await api.acceptTurn(
    session.sessionId,
    "Use subagent exactly once, with context fresh, sandbox shared, tools bash and read. Give the child this exact task: Run bash exactly once with timeout 90: printf 'ONCE\\n' >> /workspace/child-recovery-once.txt; sleep 60; printf 'CHILD_FINISHED\\n'. A runtime restart may interrupt that command. Never repeat the append. After an interruption, use read to verify the existing file has one line, then finish with CHILD_RECOVERY_OK. Parent: wait for this same child; if an outcome is uncertain, use subagent_control to list and inspect the existing child, never start another. After the child ends, call subagent_control with action list and verify that exactly one child exists in this Run. Then finish with CHILD_RECOVERY_OK. Do not use web search.",
    newIdempotencyKey("child-recovery"),
    "low",
  );
  report.runId = run.runId;
  await save();
  const child = await until(async () => {
    const parent = await api.getRun(run.runId);
    if (terminal(parent))
      throw Error(
        "Parent ended before child effect: " + parent.state + " " + (parent.failure?.code ?? ""),
      );
    const row = await db
      .selectFrom("subagent_conversations as v")
      .innerJoin("sessions as s", "s.id", "v.child_session_id")
      .select(["v.id", "v.child_session_id", "s.pi_conversation_id"])
      .where("v.root_run_id", "=", run.runId)
      .executeTakeFirst();
    if (!row?.pi_conversation_id) return false;
    let listing;
    try {
      listing = await api.listWorkspaceDirectory(session.sessionId, "");
    } catch (error) {
      if (error.code === "unavailable") return false;
      throw error;
    }
    if (!listing.entries.some((e) => e.name === "child-recovery-once.txt")) return false;
    const bytes = Buffer.from(
      (await api.readWorkspaceFile(session.sessionId, "child-recovery-once.txt")).bytes,
    ).toString("utf8");
    if (bytes === "") return false;
    assert.equal(bytes, "ONCE\n");
    return row;
  }, "Committed child and one physical effect");
  const id = Number(child.pi_conversation_id),
    beforeConfig = await configHash(id),
    beforeReceipt = await receipt(id);
  report.before = {
    childConversationId: id,
    childSessionId: child.child_session_id,
    receiptId: beforeReceipt,
    config: beforeConfig,
  };
  await save();
  phase("replace the owned Worker during the child Tool");
  report.crash = await crashOwnedWorker(db, tenant.tenantId, run.runId);
  await save();
  const outcome = await finished(run.runId);
  report.outcome = { state: outcome.state, failureCode: outcome.failure?.code };
  await save();
  assert.equal(outcome.state, "completed", outcome.failure?.code);
  const after = await db
    .selectFrom("subagent_conversations as v")
    .innerJoin("sessions as s", "s.id", "v.child_session_id")
    .select([
      "v.id",
      "v.parent_tool_call_id",
      "v.source_record_id",
      "v.source_sequence",
      "v.child_session_id",
      "s.pi_conversation_id",
    ])
    .where("v.root_run_id", "=", run.runId)
    .execute();
  report.afterChildren = after;
  await save();
  assert.equal(after.length, 1);
  assert.equal(Number(after[0].pi_conversation_id), id);
  assert.equal(await receipt(id), beforeReceipt);
  assert.deepEqual(await configHash(id), beforeConfig);
  assert.equal(
    Buffer.from(
      (await api.readWorkspaceFile(session.sessionId, "child-recovery-once.txt")).bytes,
    ).toString("utf8"),
    "ONCE\n",
  );
  const transitions = await db
    .selectFrom("run_transitions")
    .select("id")
    .where("run_id", "=", run.runId)
    .where("reason", "=", "native_execution_recovery")
    .execute();
  assert(transitions.length > 0);
  const rows = await db
    .selectFrom("runs")
    .select("id")
    .where("tenant_id", "=", tenant.tenantId)
    .execute();
  assert.equal(rows.length, 1);
  const history = await nativeHistory(db, {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
  });
  const parentMessages = history
    .filter((row) => row.entry.conversationId === 1)
    .flatMap((row) => row.entry.model ?? []);
  const delegations = parentMessages.filter(
    (m) => m.role === "toolResult" && m.toolName === "subagent",
  );
  assert.equal(delegations.length, 1, "Recovered native caller must settle once");
  assert.equal(delegations[0].isError, false);
  assert(JSON.stringify(delegations[0]).includes("CHILD_RECOVERY_OK"));
  const listed = parentMessages.filter(
    (m) => m.role === "toolResult" && m.toolName === "subagent_control" && !m.isError,
  );
  assert(
    listed.some((m) => JSON.stringify(m.content).includes(after[0].id)),
    "Target-free discovery must return the original child",
  );
  const refs = await sql`select body from pi_durable_log where tenant_id=${tenant.tenantId}::uuid
      and session_id=${session.sessionId} and record_kind='document.create'`.execute(db);
  assert(
    refs.rows.some((r) => JSON.parse(r.body).record.kind === "pi-cloud.tool-recovery"),
    "Replacement must publish a native recovery reference",
  );
  report.canonicalDelegationResults = delegations.length;
  report.originalChildDiscovered = true;
  report.accepted = true;
  report.sameRun = true;
  report.sameChild = true;
  report.sameReceipt = true;
  report.configurationUnchanged = true;
  report.oneAppend = true;
  phase("accepted; clean owned physical resources");
} catch (error) {
  failure = error;
  report.failure = {
    name: error.name,
    code: error.code,
    status: error.status,
    message: String(error.message).slice(0, 300),
    stack: String(error.stack).slice(0, 1800),
  };
} finally {
  const errors = [];
  const clean = async (action) => {
    try {
      await action();
    } catch (e) {
      errors.push({ name: e.name, message: String(e.message).slice(0, 300) });
    }
  };
  if (session)
    await clean(async () => {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id"])
        .where("tenant_id", "=", tenant.tenantId)
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, finished);
      await until(
        async () =>
          !(
            await db
              .selectFrom("runs")
              .select("id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("output_seal_id", "is not", null)
              .where("output_sealed_at", "is", null)
              .execute()
          ).length,
        "writer seals",
      );
      const evidence = await nativeHistory(db, {
        tenantId: tenant.tenantId,
        sessionId: session.sessionId,
      });
      await writeFile(
        output.replace(".json", ".native.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600 },
      );
      await api.deleteConversation(session.sessionId);
    });
  if (project)
    await clean(async () => {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup"));
      await until(
        async () =>
          Boolean(
            (
              await db
                .selectFrom("workspaces")
                .select("storage_purged_at")
                .where("id", "=", project.workspaceId)
                .executeTakeFirst()
            )?.storage_purged_at,
          ),
        "physical Workspace purge",
      );
    });
  if (tenant && errors.length === 0)
    await clean(async () => {
      const blobs = new S3ImageBlobStore({
        endpoint: "http://" + serviceAddress("session-images") + ":8333",
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(runtimeDirectory + "/secrets/session-image-s3-credentials.json", "utf8"),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
        report.cleanupConfirmed = true;
      } finally {
        await blobs.close();
      }
    });
  report.cleanupErrors = errors;
  await save();
  await db.destroy();
  if (failure || errors.length)
    throw new Error("Owned child recovery acceptance did not pass; inspect private report");
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    cleanupConfirmed: report.cleanupConfirmed,
    sameRun: true,
    sameChild: true,
    sameReceipt: true,
    configurationUnchanged: true,
    oneAppend: true,
  }),
);
