import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { newIdempotencyKey } from "@pi-cloud/session-client";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_RESOURCE_ADMISSION_CHECK,
  "1",
  "Opt in to owned Cube/Luna resource admission acceptance",
);
assert(process.argv[2], "Supply a private report path");
const output = resolve(process.argv[2]);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const secret = async (name) =>
  (await readFile(resolve(runtimeDirectory, "secrets", name), "utf8")).trim();
const pg = new URL(await secret("database-url"));
pg.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
const base = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const blobs = new S3AttachmentBlobStore({
  endpoint: `http://${serviceAddress("session-images")}:8333`,
  region: "us-east-1",
  bucket: "pi-cloud-session-images",
  ...JSON.parse(await secret("session-image-s3-credentials.json")),
});
const report = {
  checkedAt: new Date().toISOString(),
  accepted: false,
  cleanupConfirmed: false,
  model: "gpt-6-luna",
  cases: [],
};
let tenant, api, session, creating, failure;
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function until(read, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
}
async function settled(id) {
  return until(async () => {
    const run = await api.getRun(id);
    if (!terminal(run)) return;
    const state = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at", "recovery_requested_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !state.recovery_requested_at && (!state.output_seal_id || state.output_sealed_at) && run;
  }, "native Run settlement");
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-resource-${Date.now().toString(36)}`,
    ownerDisplayName: "Resource admission acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  report.tenantId = tenant.tenantId;
  api = new PiCloudApi((path, init) => fetch(new URL(path, base), init), tenant.credential.token);
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  const key = newIdempotencyKey("first-machine");
  creating = api.createDevelopmentEnvironment("First admission fixture", "starter", key, 1);
  void creating.catch(() => {});
  const pending = await until(
    async () => {
      const values = (await api.listDevelopmentEnvironments()).environments;
      return values.find((machine) => machine.creationPending);
    },
    "visible pending machine",
    30000,
  );
  assert.equal(pending.creationPending, true);
  for (const action of ["pause", "release"])
    await assert.rejects(
      api.developmentEnvironmentAction(pending.environmentId, action, newIdempotencyKey(action)),
      (error) => error.code === "development_environment_creation_pending",
    );
  await assert.rejects(
    api.createDevelopmentEnvironment(
      "Rejected second fixture",
      "starter",
      newIdempotencyKey("second-machine"),
      1,
    ),
    (error) => error.code === "development_environment_creation_pending",
  );
  report.cases.push({
    kind: "pending-admission",
    lifecycleRejected: true,
    secondApplicationRejected: true,
  });
  const first = await creating;
  await until(
    async () =>
      (await api.listDevelopmentEnvironments()).environments.some(
        (m) =>
          m.environmentId === first.environmentId && m.state === "running" && !m.creationPending,
      ),
    "first machine ready",
  );
  const replay = await api.createDevelopmentEnvironment(
    "First admission fixture",
    "starter",
    key,
    1,
  );
  assert.equal(replay.environmentId, first.environmentId);
  const second = await api.createDevelopmentEnvironment(
    "Second ready fixture",
    "starter",
    newIdempotencyKey("next-machine"),
    1,
  );
  await until(
    async () =>
      (await api.listDevelopmentEnvironments()).environments.some(
        (m) =>
          m.environmentId === second.environmentId && m.state === "running" && !m.creationPending,
      ),
    "second machine ready",
  );
  assert.equal((await api.listDevelopmentEnvironments()).environments.length, 2);
  report.cases.push({ kind: "resolved-admission", replaySameMachine: true, readyMachines: 2 });
  session = await api.createSession(
    first.projectId,
    first.workspaceId,
    "Resource Stop acceptance",
    "development_environment",
    "starter",
    "/home/user",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  const run = await api.acceptTurn(
    session.sessionId,
    "只调用一次 bash，执行 printf 'RESOURCE_ADMISSION_READY\\n'; sleep 45，timeout 设为 90。不要其他工具或委派。命令结束后简短回复。",
    newIdempotencyKey("resource-work"),
    "low",
  );
  await until(async () => {
    const current = await api.getRun(run.runId);
    assert(!terminal(current), "Model ended before the live occupancy check");
    return (await api.getConversation(session.sessionId)).turns
      .find((t) => t.runId === run.runId)
      ?.transcript?.items.some((i) => i.kind === "tool" && i.status === "running");
  }, "running native Tool");
  await assert.rejects(
    api.developmentEnvironmentAction(
      first.environmentId,
      "release",
      newIdempotencyKey("busy-release"),
    ),
    (error) => error.code === "conflict",
  );
  await api.cancelTurn(session.sessionId, run.turnId, newIdempotencyKey("stop"));
  assert.equal((await settled(run.runId)).state, "cancelled");
  await until(async () => {
    const machine = await db
      .selectFrom("development_environments")
      .select(["agent_activation_id", "terminal_active"])
      .where("id", "=", first.environmentId)
      .executeTakeFirstOrThrow();
    return !machine.agent_activation_id && !machine.terminal_active;
  }, "native owner and resource binding retirement");
  await api.developmentEnvironmentAction(
    first.environmentId,
    "release",
    newIdempotencyKey("settled-release"),
  );
  await until(
    async () =>
      !(await api.listDevelopmentEnvironments()).environments.some(
        (m) => m.environmentId === first.environmentId,
      ),
    "first machine release",
  );
  assert(
    (await api.listDevelopmentEnvironments()).environments.some(
      (m) => m.environmentId === second.environmentId && m.state === "running",
    ),
  );
  report.cases.push({
    kind: "stop-and-release",
    activeRunRejected: true,
    nativeStopSettled: true,
    otherMachinePreserved: true,
  });
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 700);
} finally {
  try {
    await creating?.catch(() => {});
    if (session) {
      const runs = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, runs, settled);
      await api.deleteConversation(session.sessionId);
    }
    if (tenant) {
      // Resolve accepted creation before cleanup. Never bypass the product gate
      // by deleting PG ownership records for an uncertain provider request.
      await until(
        async () =>
          !(await api.listDevelopmentEnvironments()).environments.some((m) => m.creationPending),
        "owned creation resolution",
        300000,
      );
      const machines = await db
        .selectFrom("development_environments")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute();
      for (const machine of machines)
        await api.developmentEnvironmentAction(
          machine.id,
          "release",
          newIdempotencyKey("cleanup-machine"),
        );
      await until(
        async () => {
          const workspaces = await db
            .selectFrom("workspaces")
            .select("id")
            .where("tenant_id", "=", tenant.tenantId)
            .where((eb) =>
              eb.or([eb("deleted_at", "is", null), eb("storage_purged_at", "is", null)]),
            )
            .execute();
          const controls = await db
            .selectFrom("outbox")
            .select("id")
            .where("tenant_id", "=", tenant.tenantId)
            .where("published_at", "is", null)
            .execute();
          return workspaces.length === 0 && controls.length === 0;
        },
        "owned physical Workspace cleanup",
        300000,
      );
      report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      report.cleanupConfirmed = true;
    }
  } catch (error) {
    report.cleanupFailure = String(error?.message ?? error).slice(0, 700);
    failure ??= error;
  }
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  await blobs.close();
  await db.destroy();
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
