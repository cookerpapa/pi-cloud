import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { SessionApi, newIdempotencyKey } from "@pi-cloud/session-client";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import { nativeHistory, nativeMessages, runUsage } from "./lib/native-session-history.mjs";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  kubectl,
  namespace,
} from "./lib/production-kubernetes.mjs";
import { assertLiveContract } from "./lib/live-contract.mjs";
import { writeRuntimeFileAtomically } from "./lib/runtime-file-policy.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_LOCAL_CHECK,
  "1",
  "Opt into owned local execution and Worker replacement acceptance",
);
assert(process.argv[2], "Supply a new private report path");
const output = resolve(process.argv[2]),
  directory = resolve(dirname(output), "local-" + randomUUID());
await mkdir(directory, { recursive: true, mode: 0o700 });
const secret = async (name) =>
  (await readFile(resolve(runtimeDirectory, "secrets", name), "utf8")).trim();
const dbUrl = new URL(await secret("database-url"));
dbUrl.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: dbUrl.toString(), maxConnections: 4 });
const base = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const apiFor = (token) => new PiCloudApi((path, init) => fetch(new URL(path, base), init), token);
const admin = apiFor(await secret("api-token"));
const blobs = new S3AttachmentBlobStore({
  endpoint: `http://${serviceAddress("session-images")}:8333`,
  bucket: "pi-cloud-session-images",
  region: "us-east-1",
  ...JSON.parse(await secret("session-image-s3-credentials.json")),
});
const targetId = randomUUID(),
  devicesPath = resolve(runtimeDirectory, "secrets/device-link-devices.json");
const report = {
  at: new Date().toISOString(),
  accepted: false,
  cleanupConfirmed: false,
  targetId,
  model: "gpt-6-luna",
  runs: [],
};
const save = () => writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function until(read, label, milliseconds = 180_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(300);
  }
  throw new Error(`Timed out: ${label}`);
}
async function deviceCredentials(change) {
  const data = JSON.parse(await readFile(devicesPath, "utf8"));
  change(data);
  await writeRuntimeFileAtomically(devicesPath, JSON.stringify(data, null, 2) + "\n");
  kubectl(["apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "pi-cloud-device-link-credentials", namespace },
      type: "Opaque",
      stringData: { "devices.json": JSON.stringify(data) },
    }),
    stdio: ["pipe", "ignore", "pipe"],
  });
}
let tenant,
  api,
  project,
  session,
  run,
  local,
  localExit,
  failure,
  enrolled = false;
const aborts = [],
  streams = [];
try {
  await assertLiveContract(db, runtimeDirectory);
  assert(
    runtimeEnvironment().PI_CLOUD_DEVICE_COMPLETION_ADDRESS,
    "Configure the external HTTPS completion route",
  );
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-local-" + randomUUID().slice(0, 8),
    ownerDisplayName: "Owned local acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = apiFor(tenant.credential.token);
  project = await api.createProject("Local transport acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Cloud loop and local project",
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
  await mkdir(resolve(directory, "project"), { mode: 0o700 });
  const { default: sharp } = await import("sharp");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } })
    .png()
    .toFile(resolve(directory, "project/sample.png"));
  const deviceToken = randomBytes(32).toString("hex"),
    receiverToken = randomBytes(32).toString("hex");
  await writeFile(resolve(directory, "device-token"), deviceToken, { mode: 0o600 });
  await writeFile(resolve(directory, "receiver-token"), receiverToken, { mode: 0o600 });
  await deviceCredentials((data) => {
    assert(!data[targetId]);
    data[targetId] = deviceToken;
  });
  enrolled = true;
  const portServer = createServer();
  await new Promise((done) => portServer.listen(0, "127.0.0.1", done));
  const port = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  const config = {
    targetId,
    project: resolve(directory, "project"),
    port,
    gatewayUrl: base.replace("http:", "ws:") + "/v1/device-links/" + targetId,
    deviceTokenFile: resolve(directory, "device-token"),
    receiverTokenFile: resolve(directory, "receiver-token"),
  };
  await writeFile(resolve(directory, "local.json"), JSON.stringify(config), { mode: 0o600 });
  let connected = false,
    localLog = "";
  local = spawn(
    process.execPath,
    ["--import", "tsx", "packages/local-executor/src/launch.ts", resolve(directory, "local.json")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  local.stdout.on("data", (bytes) => {
    const text = bytes.toString();
    localLog = (localLog + text).slice(-8192);
    if (text.includes('"state":"connected"')) connected = true;
  });
  local.stderr.on("data", (bytes) => {
    localLog = (localLog + bytes.toString()).slice(-8192);
  });
  localExit = new Promise((done) => {
    local.once("exit", (code) => done(code));
    local.once("error", () => done(-1));
  });
  await until(() => {
    assert(local.exitCode === null, "Local receiver exited: " + localLog);
    return connected;
  }, "outbound device connection");
  await admin.registerResourceDevice({
    tenantId: tenant.tenantId,
    device: {
      targetId,
      name: "Owned Linux fixture",
      endpoint: `http://device-link:8090/targets/${targetId}`,
    },
  });
  const selection = await api.getSessionExecutionTarget(session.sessionId);
  await api.bindExecutionTarget(session.sessionId, targetId, selection.revision);
  assert.equal(
    (await api.listExecutionTargets()).targets.find((target) => target.targetId === targetId)
      .computeBilling,
    "external",
  );
  const counters = [
    { snapshots: 0, events: 0 },
    { snapshots: 0, events: 0 },
  ];
  for (const counter of counters) {
    const controller = new AbortController();
    aborts.push(controller);
    const client = new SessionApi(fetch, tenant.credential.token, base);
    streams.push(
      client
        .streamSession({
          sessionId: session.sessionId,
          signal: controller.signal,
          onSnapshot() {
            counter.snapshots++;
          },
          onEvent() {
            counter.events++;
          },
          onStatus() {},
        })
        .catch((error) => {
          if (!controller.signal.aborted) throw error;
        }),
    );
  }
  await until(
    () => counters.every((counter) => counter.snapshots > 0),
    "two independent chat readers",
  );
  const command =
    "printf 'ONCE\\n' >> /workspace/once.txt; while [ ! -f /workspace/release ]; do sleep 0.2; done; printf 'LOCAL_CONTINUED\\n'";
  run = await api.acceptTurn(
    session.sessionId,
    `Validate the connected local Linux project. Use local_write to write /workspace/note.txt with text before, then local_edit to replace before with after, then local_read to confirm it. Use local_read on /workspace/sample.png and remember its main color. Finally call local_bash exactly once with timeout 300 and command ${JSON.stringify(command)}. The operator will release this same waiting command; do not repeat it or start any subagent. After it returns, answer LOCAL_OK, the image color and the file contents.`,
    newIdempotencyKey("turn"),
    "low",
  );
  report.runs.push(run.runId);
  await save();
  await until(async () => {
    const current = await api.getRun(run.runId);
    assert(
      !terminal(current),
      "Run ended before the held local command: " + JSON.stringify(current.failure),
    );
    try {
      return (await readFile(resolve(directory, "project/once.txt"), "utf8")) === "ONCE\n";
    } catch {
      return false;
    }
  }, "held local command");
  aborts[0].abort();
  await streams[0];
  const before = await api.getRun(run.runId);
  assert(!terminal(before));
  const other =
    await sql`select 1 from runs where state not in ('completed','failed','cancelled','timed_out') and id<>${run.runId}::uuid limit 1`.execute(
      db,
    );
  assert.equal(other.rows.length, 0, "Do not replace a Worker while an unrelated Run is active");
  const {
    rows: [worker],
  } = await sql`select supervisor_id from workers where id=${before.workerId}::uuid`.execute(db);
  const pod = JSON.parse(kubectl(["get", "pod", worker.supervisor_id, "-o", "json"]));
  const container = pod.status.containerStatuses.find(
    (candidate) => candidate.name === "pi-worker",
  );
  assert(/^containerd:\/\/[0-9a-f]{64}$/.test(container.containerID));
  execFileSync(
    "/usr/local/bin/k3s",
    [
      "ctr",
      "-n",
      "k8s.io",
      "tasks",
      "kill",
      "--signal",
      "SIGKILL",
      container.containerID.slice("containerd://".length),
    ],
    { stdio: "ignore" },
  );
  const recovered = await until(async () => {
    const current = await api.getRun(run.runId);
    assert(!terminal(current), "Run ended before original reply recovery");
    return current.workerId && current.workerId !== before.workerId && current;
  }, "replacement Worker");
  report.workerReplaced = before.workerId !== recovered.workerId;
  await writeFile(resolve(directory, "project/release"), "continue");
  const done = await until(
    async () => {
      const current = await api.getRun(run.runId);
      return terminal(current) && current;
    },
    "original Run completion",
    300_000,
  );
  assert.equal(done.state, "completed", JSON.stringify(done.failure));
  assert.equal(await readFile(resolve(directory, "project/once.txt"), "utf8"), "ONCE\n");
  assert.equal(await readFile(resolve(directory, "project/note.txt"), "utf8"), "after");
  assert(counters[1].events > 0);
  const history = await nativeHistory(db, { tenantId: tenant.tenantId, runId: run.runId });
  const messages = nativeMessages(history);
  const results = messages.filter((message) => message.role === "toolResult");
  for (const name of ["local_write", "local_edit", "local_read", "local_bash"])
    assert(
      results.some((message) => message.toolName === name && !message.isError),
      `Missing successful canonical ${name}`,
    );
  const answer = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert(
    answer.includes("LOCAL_OK") && /red|红/i.test(answer),
    "The model did not confirm the local image and completion",
  );
  report.answer = answer.slice(-4096);
  const {
    rows: [counts],
  } = await sql`select
    (select count(*)::int from workspace_runtimes where tenant_id=${tenant.tenantId}::uuid) as vms,
    (select count(*)::int from resource_metering_events where tenant_id=${tenant.tenantId}::uuid and resource_kind='compute') as charges`.execute(
    db,
  );
  assert.deepEqual(counts, { vms: 0, charges: 0 });
  report.readers = counters;
  report.onePhysicalEffect = true;
  report.noCloudComputeOrCharge = true;
  report.usage = runUsage(history);
  report.accepted = true;
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.message : "Acceptance failed";
} finally {
  for (const abort of aborts) abort.abort();
  await Promise.allSettled(streams);
  try {
    if (local) await writeFile(resolve(directory, "project/release"), "cleanup");
    if (api && session) {
      if (run)
        await settleOwnedAcceptanceRuns(
          api,
          session.sessionId,
          [{ id: run.runId, turn_id: run.turnId }],
          (id) =>
            until(async () => {
              const current = await api.getRun(id);
              return terminal(current) && current;
            }, "owned Run settlement"),
        );
      await until(
        async () => {
          try {
            const selection = await api.getSessionExecutionTarget(session.sessionId);
            if (selection.target)
              await api.bindExecutionTarget(session.sessionId, null, selection.revision);
            return true;
          } catch {
            return false;
          }
        },
        "device binding retirement",
        90_000,
      );
      await sql`delete from execution_targets where id=${targetId}::uuid and tenant_id=${tenant.tenantId}::uuid and bound_session_id is null and not exists(select 1 from execution_target_bindings where target_id=${targetId}::uuid)`.execute(
        db,
      );
      await api.deleteConversation(session.sessionId);
    }
    if (api && project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
      await until(async () => {
        const row = await db
          .selectFrom("workspaces")
          .select("storage_purged_at")
          .where("id", "=", project.workspaceId)
          .executeTakeFirst();
        return row?.storage_purged_at;
      }, "owned Workspace deletion");
    }
    if (tenant) {
      await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      report.cleanupConfirmed = true;
    }
  } catch (error) {
    report.cleanupError = error instanceof Error ? error.message : "Cleanup failed";
    failure ??= error;
  }
  if (local && local.exitCode === null) {
    local.kill("SIGTERM");
    const killed = setTimeout(() => local.kill("SIGKILL"), 10_000);
    try {
      await localExit;
    } finally {
      clearTimeout(killed);
    }
  }
  if (enrolled)
    await deviceCredentials((data) => {
      delete data[targetId];
    });
  await save();
  await blobs.close();
  await db.destroy();
  if (report.cleanupConfirmed) await rm(directory, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    cleanupConfirmed: report.cleanupConfirmed,
    report: output,
  }),
);
if (failure) process.exitCode = 1;
