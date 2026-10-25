import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { serviceAddress } from "./lib/production-kubernetes.mjs";
import { sql } from "kysely";
import { crashOwnedWorker } from "./lib/owned-worker-crash.mjs";
import { checkNativeLiveProgress } from "./lib/live-native-progress.mjs";
import { watchNativeRecoveryObservations } from "./lib/live-native-observations.mjs";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

if (process.env.PI_CLOUD_LIVE_NATIVE_INPUT_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_NATIVE_INPUT_CHECK=1 for schema 199 matched Luna/Cube acceptance and an owned Worker crash",
  );
const runtime = "deploy/production/runtime",
  env = await readFile(`${runtime}/.env`, "utf8");
const base = `http://127.0.0.1:${env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1]}`;
const pg = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pg.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
const report = {
  checkedAt: new Date().toISOString(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  nativeProgressSha256: createHash("sha256")
    .update(await readFile(new URL("./lib/live-native-progress.mjs", import.meta.url)))
    .digest("hex"),
  nativeObservationsSha256: createHash("sha256")
    .update(await readFile(new URL("./lib/live-native-observations.mjs", import.meta.url)))
    .digest("hex"),
  model: "gpt-6-luna",
  accepted: false,
  cases: [],
};
const sessions = [];
const observationWatchers = [];
let tenant, api, project, failure;
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
async function until(read, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} timed out`);
}
async function finished(id) {
  const run = await until(async () => {
    const r = await api.getRun(id);
    return terminal(r.state) && r;
  }, "Run settlement");
  await until(async () => {
    const r = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !r.output_seal_id || r.output_sealed_at;
  }, "Native output seal");
  return run;
}

try {
  const schema = await db
    .selectFrom("kysely_migration")
    .select("name")
    .orderBy("name", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
  assert.equal(schema.name, "199_conversation_commands", "Deploy the matched schema/app first");
  tenant = await createPrivateTenant(db, {
    slug: `native-input-${randomUUID()}`,
    ownerDisplayName: "Native input acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = new PiCloudApi(async (url, init) => {
    try {
      return await fetch(new URL(String(url), base), init);
    } catch (error) {
      report.transportFailure = { name: error.name, code: error.cause?.code };
      throw error;
    }
  }, tenant.credential.token);
  report.tenantId = tenant.tenantId;
  project = await api.createProject("Native input acceptance", { kind: "empty" });
  report.workspaceId = project.workspaceId;
  const createSession = async (scenario) => {
    const session = await api.createSession(
      project.projectId,
      project.workspaceId,
      `Native ${scenario}`,
      "elastic",
      "starter",
      "/workspace",
      { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
    );
    sessions.push(session);
    return session;
  };
  for (const scenario of ["consume", "stop", "recover"]) {
    console.log(JSON.stringify({ phase: "native-input", scenario }));
    const session = await createSession(scenario);
    const root = await api.acceptTurn(
      session.sessionId,
      "Run bash exactly once: sleep 20. After that, answer briefly. Subsequent messages may change your instructions.",
      newIdempotencyKey("turn"),
    );
    assert.equal(root.kind, "run");
    const observations =
      scenario === "recover"
        ? watchNativeRecoveryObservations({
            sessionId: session.sessionId,
            turnId: root.turnId,
            runId: root.runId,
            authorizationToken: tenant.credential.token,
            fetchImplementation: (url, init) => fetch(new URL(String(url), base), init),
            until,
          })
        : undefined;
    if (observations) observationWatchers.push(observations);
    await until(async () => {
      const r = await api.getRun(root.runId);
      if (terminal(r.state))
        throw new Error(`Run ended before Bash: ${r.state} ${r.failure?.code ?? ""}`);
      return (await api.getConversation(session.sessionId)).turns
        .find((t) => t.runId === root.runId)
        ?.transcript?.items.some((i) => i.kind === "tool" && i.status === "running");
    }, "Bash started");
    const key = newIdempotencyKey("turn"),
      text = "Without using tools, reply ORIGINAL_INPUT_MARKER.";
    const input = await api.acceptTurn(session.sessionId, text, key);
    assert.equal(input.kind, "input");
    assert.equal(input.runId, root.runId);
    // Retry as if the preceding HTTP confirmation was lost.
    const replay = await api.acceptTurn(session.sessionId, text, key);
    assert.equal(replay.inputId, input.inputId);
    assert.equal(replay.replayed, true);
    let queue = await until(async () => {
      const q = await api.getInputQueue(session.sessionId);
      return q.items.some((i) => i.inputId === input.inputId) && q;
    }, "First native input projection");
    const editedText =
      scenario === "recover"
        ? "After recovery, run bash exactly once: sleep 35; printf RECOVERY_OBSERVATION_OK. Then reply EDITED_INPUT_MARKER."
        : "Without using tools, reply EDITED_INPUT_MARKER.";
    await api.mutateQueuedInput(
      session.sessionId,
      input.inputId,
      {
        action: "edit",
        text: editedText,
        revision: queue.revision,
      },
      newIdempotencyKey("edit"),
    );
    const second = await api.acceptTurn(
      session.sessionId,
      "Without using tools, reply SECOND_INPUT_MARKER.",
      newIdempotencyKey("turn"),
    );
    assert.equal(second.kind, "input");
    queue = await until(async () => {
      const q = await api.getInputQueue(session.sessionId);
      return (
        q.items.some((i) => i.inputId === second.inputId) &&
        q.items.some(
          (i) => i.inputId === input.inputId && i.text.includes("EDITED_INPUT_MARKER"),
        ) &&
        q
      );
    }, "Second native input projection");
    queue = (
      await api.mutateQueuedInput(
        session.sessionId,
        second.inputId,
        { action: "move", direction: "up", revision: queue.revision },
        newIdempotencyKey("move"),
      )
    ).queue;
    queue = (
      await api.mutateQueuedInput(
        session.sessionId,
        second.inputId,
        { action: "steer", revision: queue.revision },
        newIdempotencyKey("steer"),
      )
    ).queue;
    assert.equal(queue.items[0].inputId, second.inputId);
    await until(async () => {
      const values =
        await sql`select c.body from pi_durable_current c join pi_durable_records r using(tenant_id,session_id,id)
        where c.tenant_id=${tenant.tenantId}::uuid and c.session_id=${session.sessionId}
          and r.fields->>'nativeKind'=${JSON.stringify("pi-cloud.human-inputs")}`.execute(db);
      return values.rows.some(
        (r) => r.body.includes("EDITED_INPUT_MARKER") && !r.body.includes("ORIGINAL_INPUT_MARKER"),
      );
    }, "Latest-only input body");
    const old = await sql`select 1 from pi_durable_log where tenant_id=${tenant.tenantId}::uuid
      and session_id=${session.sessionId} and (record_kind='submission' or body like '%ORIGINAL_INPUT_MARKER%') limit 1`.execute(
      db,
    );
    assert.equal(old.rows.length, 0, "Input edits must not enter retained native history");
    let crash, observationRecovery, previousGeneration;
    if (scenario === "recover") {
      previousGeneration = await observations.beforeCrash();
      crash = await crashOwnedWorker(db, tenant.tenantId, root.runId);
    }
    if (scenario === "stop") {
      await api.cancelTurn(session.sessionId, root.turnId, newIdempotencyKey("cancel"));
      await finished(root.runId);
      const returned = await until(async () => {
        const page = await api.getReturnedInputs(session.sessionId);
        return page.requestId && !page.pending && page;
      }, "Returned inputs");
      assert.deepEqual(
        returned.items.map((i) => i.inputId),
        [second.inputId, input.inputId],
      );
      assert.equal(returned.items[1].text, "Without using tools, reply EDITED_INPUT_MARKER.");
      await api.acknowledgeReturnedInputs(session.sessionId, returned.requestId);
    } else {
      const outcome = await finished(root.runId);
      if (outcome.state !== "completed")
        report.runFailure = {
          scenario,
          runId: root.runId,
          state: outcome.state,
          failureCode: outcome.failure?.code,
        };
      assert.equal(outcome.state, "completed");
      const history = await api.getConversation(session.sessionId);
      assert.equal(history.turns.length, 1);
      assert.deepEqual(
        history.turns[0].transcript.items.filter((i) => i.kind === "user").map((i) => i.inputId),
        [second.inputId, input.inputId],
      );
      assert.equal((await api.getInputQueue(session.sessionId)).items.length, 0);
      const replayAfter = await api.acceptTurn(session.sessionId, text, key);
      assert.equal(replayAfter.runId, root.runId);
      assert.equal(replayAfter.replayed, true);
      if (crash) {
        const recovered = await db
          .selectFrom("run_transitions")
          .select("id")
          .where("run_id", "=", root.runId)
          .where("reason", "=", "native_execution_recovery")
          .execute();
        assert(recovered.length > 0, "Queued inputs require an actual recovered Run");
        observationRecovery = await observations.afterRecovery(previousGeneration);
      }
    }
    const runs = await db
      .selectFrom("runs")
      .select("id")
      .where("tenant_id", "=", tenant.tenantId)
      .where("session_id", "=", session.sessionId)
      .execute();
    assert.equal(runs.length, 1);
    report.cases.push({
      scenario,
      oneRun: true,
      stableRetryIdentity: true,
      editedNativeInput: true,
      noRetainedEditBodies: true,
      ...(crash ? { crash } : {}),
      ...(observationRecovery ? { observationRecovery } : {}),
    });
    await observations?.close();
  }
  report.cases.push(
    ...(await checkNativeLiveProgress({
      database: db,
      tenantId: tenant.tenantId,
      api,
      authorizationToken: tenant.credential.token,
      fetchImplementation: (url, init) => fetch(new URL(String(url), base), init),
      createSession,
      until,
      finished,
      onUnexpectedEnd: (diagnostic) => {
        report.streamingFailure = diagnostic;
      },
    })),
  );
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 600);
} finally {
  const errors = [];
  const clean = async (work) => {
    try {
      await work();
    } catch (error) {
      errors.push(error);
    }
  };
  for (const watcher of observationWatchers) await clean(() => watcher.close());
  for (const session of sessions)
    await clean(async () => {
      const runs = await db
        .selectFrom("runs")
        .select(["id", "turn_id"])
        .where("tenant_id", "=", tenant.tenantId)
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, runs, finished);
      for (const run of runs) await finished(run.id);
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
        "Physical Workspace cleanup",
      );
    });
  if (tenant)
    await clean(() =>
      db
        .updateTable("tenant_api_credentials")
        .set({ revoked_at: new Date() })
        .where("credential_id", "=", tenant.credential.credentialId)
        .execute(),
    );
  if (tenant && errors.length === 0)
    await clean(async () => {
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(`${runtime}/secrets/session-image-s3-credentials.json`, "utf8"),
        ),
      });
      report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      report.cleanupConfirmed = true;
    });
  report.cleanupRequested = errors.length === 0;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-native-input-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "Native input acceptance failed",
    );
}
console.log(JSON.stringify(report));
