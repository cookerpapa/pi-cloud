// Owned acceptance: ordered Session closure without restarting its Worker process.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { requestExecutionStreamSeal } from "../packages/runtime-core/src/execution-stream-seal.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  kubectl,
  kubectlAsync,
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";
import { nativeHistory, nativeMessages } from "./lib/native-session-history.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_SAME_WORKER_RECOVERY_CHECK,
  "1",
  "Authorize the owned recovery fixture and temporary single-Worker pool",
);
serializeRelease(runtimeDirectory);
const output = resolve(
  process.argv[2] ?? runtimeDirectory + "/acceptance/same-worker-recovery.json",
);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const url = new URL((await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim());
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const pool = "statefulset/pi-cloud-pi-worker-primary-v1",
  pod = "pi-cloud-pi-worker-primary-v1-0";
const report = {
  at: new Date().toISOString(),
  runtimeRevision: JSON.parse(await readFile(runtimeDirectory + "/k3s/deployment.json", "utf8"))
    .revision,
  driverSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  accepted: false,
  cleanupConfirmed: false,
  poolRestored: false,
};
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
async function until(read, label, budget = 240000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw Error(label + " timed out");
}
async function noOtherWork(tenantId) {
  let query = db
    .selectFrom("runs")
    .select("id")
    .where("state", "in", ["queued", "running", "settling", "cancel_requested"]);
  if (tenantId) query = query.where("tenant_id", "!=", tenantId);
  assert.equal(
    (await query.limit(1).execute()).length,
    0,
    "Unrelated work is active; refusing recovery fixture",
  );
}
function processIdentity() {
  const state = JSON.parse(kubectl(["get", "pod", pod, "-o", "json"]));
  const c = state.status.containerStatuses.find((c) => c.name === "pi-worker");
  assert(c?.ready && c.state.running, "Expected the primary Worker ready");
  return {
    podUid: state.metadata.uid,
    containerId: c.containerID,
    startedAt: c.state.running.startedAt,
    restartCount: c.restartCount,
  };
}
let replicas, tenant, project, session, api, run, failure;
async function settled(id) {
  return until(async () => {
    const r = await db
      .selectFrom("runs")
      .select(["state", "lease_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return terminal(r.state) && (!r.lease_id || r.output_sealed_at);
  }, "Owned writer closure");
}
try {
  await noOtherWork();
  replicas = JSON.parse(kubectl(["get", pool, "-o", "json"])).spec.replicas;
  assert(replicas >= 1);
  report.originalReplicas = replicas;
  await save();
  // Remove scheduling ambiguity using the existing deployment, not Session affinity.
  kubectl(["scale", pool, "--replicas=1"]);
  await kubectlAsync(["rollout", "status", pool, "--timeout=240s"]);
  await until(
    () =>
      JSON.parse(
        kubectl([
          "get",
          "pods",
          "-l",
          "app.kubernetes.io/component=trusted-pi-worker",
          "-o",
          "json",
        ]),
      ).items.length === 1,
    "Idle siblings drained",
  );
  const originalProcess = processIdentity();
  report.originalProcess = originalProcess;
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-same-" + randomUUID(),
    ownerDisplayName: "Same Worker recovery",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  report.tenantId = tenant.tenantId;
  const origin = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), origin), init),
    tenant.credential.token,
  );
  project = await api.createProject("Same Worker recovery", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Recovery acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.sessionId = session.sessionId;
  report.workspaceId = project.workspaceId;
  run = await api.acceptTurn(
    session.sessionId,
    "This is an owned recovery check. Call bash exactly twice, separately and sequentially. First: printf 'ONCE\\n' >> /workspace/recovery-once.txt . Second: sleep 40 . Do not combine or background them. After they finish, reply only SAME_WORKER_RECOVERY_OK. If the system reports an interrupted or unknown Tool after recovery, also reply only SAME_WORKER_RECOVERY_OK, without retrying any Tool.",
    newIdempotencyKey("same-worker"),
    "low",
  );
  assert.equal(run.kind, "run");
  report.runId = run.runId;
  await save();
  await until(async () => {
    const r = await api.getRun(run.runId);
    assert(!terminal(r.state), "Run ended before the held Tool");
    const tools =
      (await api.getConversation(session.sessionId)).turns
        .find((t) => t.runId === run.runId)
        ?.transcript?.items.filter((i) => i.kind === "tool") ?? [];
    return tools.length === 2 && tools[0].status === "completed" && tools[1].status === "running";
  }, "Completed marker and held second Tool");
  await noOtherWork(tenant.tenantId);
  const old = await db
    .selectFrom("runs")
    .select(["worker_id", "lease_id", "fencing_token"])
    .where("id", "=", run.runId)
    .executeTakeFirstOrThrow();
  const worker = await db
    .selectFrom("workers")
    .select(["supervisor_id", "boot_id"])
    .where("id", "=", old.worker_id)
    .executeTakeFirstOrThrow();
  assert.equal(worker.supervisor_id, pod);
  report.workerId = old.worker_id;
  report.bootId = worker.boot_id;
  report.oldLease = old;
  await save();
  await db.transaction().execute(async (tx) => {
    const current = await tx
      .selectFrom("runs")
      .select(["state", "worker_id", "lease_id"])
      .where("id", "=", run.runId)
      .where("tenant_id", "=", tenant.tenantId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    assert.equal(current.state, "running");
    assert.equal(current.lease_id, old.lease_id);
    assert.equal(current.worker_id, old.worker_id);
    await requestExecutionStreamSeal(tx, {
      tenantId: tenant.tenantId,
      sessionId: session.sessionId,
      turnId: run.turnId,
      runId: run.runId,
      agentId: "root",
      recover: true,
      now: new Date(),
      eventId: randomUUID(),
    });
  });
  report.closureRequested = true;
  await save();
  const replacement = await until(async () => {
    const r = await db
      .selectFrom("runs")
      .select(["worker_id", "lease_id", "fencing_token", "state", "failure_code"])
      .where("id", "=", run.runId)
      .executeTakeFirstOrThrow();
    if (terminal(r.state) && r.lease_id === old.lease_id)
      throw Error("Old incarnation terminated instead of recovering: " + r.failure_code);
    return r.lease_id && r.lease_id !== old.lease_id ? r : false;
  }, "Same Worker re-admission");
  assert.equal(replacement.worker_id, old.worker_id);
  assert.equal(BigInt(replacement.fencing_token), BigInt(old.fencing_token) + 1n);
  assert.deepEqual(processIdentity(), originalProcess);
  const closed = await db
    .selectFrom("session_leases")
    .select(["writer_sealed_at", "released_at"])
    .where("lease_id", "=", old.lease_id)
    .executeTakeFirstOrThrow();
  assert(closed.writer_sealed_at && closed.released_at);
  report.newLease = replacement;
  report.oldWriterSealed = true;
  await save();
  const done = await until(async () => {
    const r = await api.getRun(run.runId);
    return terminal(r.state) && r;
  }, "Recovered completion");
  assert.equal(done.state, "completed", done.failure?.message);
  await settled(run.runId);
  assert.deepEqual(processIdentity(), originalProcess);
  const marker = await api.readWorkspaceFile(session.sessionId, "recovery-once.txt");
  assert.equal(
    Buffer.from(marker.bytes).toString("utf8"),
    "ONCE\n",
    "Completed Tool must not be replayed",
  );
  const messages = nativeMessages(
    await nativeHistory(db, { tenantId: tenant.tenantId, runId: run.runId }),
  );
  const text = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  assert(text.includes("SAME_WORKER_RECOVERY_OK"));
  const runs = await db
    .selectFrom("runs")
    .select("id")
    .where("session_id", "=", session.sessionId)
    .execute();
  assert.deepEqual(
    runs.map((r) => r.id),
    [run.runId],
  );
  const recoveries = await db
    .selectFrom("run_transitions")
    .select("id")
    .where("run_id", "=", run.runId)
    .where("reason", "=", "native_execution_recovery")
    .execute();
  assert.equal(recoveries.length, 1);
  report.sameProcess = true;
  report.singleRun = true;
  report.markerWrittenOnce = true;
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = { name: error.name, message: error.message };
} finally {
  try {
    if (api && session) {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settled);
      await api.deleteConversation(session.sessionId);
    }
    if (api && project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("same-worker-cleanup"));
      await until(
        async () =>
          (
            await db
              .selectFrom("workspaces")
              .select("storage_purged_at")
              .where("id", "=", project.workspaceId)
              .executeTakeFirst()
          )?.storage_purged_at,
        "Owned Volume purge",
      );
    }
    if (tenant) {
      await until(
        async () =>
          !(
            await db
              .selectFrom("outbox")
              .select("id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("published_at", "is", null)
              .limit(1)
              .execute()
          ).length,
        "Owned control publication",
      );
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
        blobs.close();
      }
    }
  } catch (error) {
    report.cleanupFailure = { name: error.name, message: error.message };
    failure ??= error;
  }
  try {
    if (replicas !== undefined) {
      kubectl(["scale", pool, "--replicas=" + replicas]);
      await kubectlAsync(["rollout", "status", pool, "--timeout=240s"]);
      report.poolRestored = true;
    }
  } catch (error) {
    report.poolFailure = { name: error.name, message: error.message };
    failure ??= error;
  }
  await save();
  await db.destroy();
  console.log(
    JSON.stringify({
      accepted: report.accepted,
      cleanupConfirmed: report.cleanupConfirmed,
      poolRestored: report.poolRestored,
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
