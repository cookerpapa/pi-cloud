// Owned small-image runs verify diagnostic boundaries without user-history replay.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { localWorkerTargets } from "./lib/live-run-timing.mjs";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_PREPARATION_TIMING_CHECK,
  "1",
  "Authorize owned Luna/Cube timing acceptance",
);
const output = resolve(process.argv[2] ?? `${runtimeDirectory}/acceptance/preparation-timing.json`);
await mkdir(dirname(output), { recursive: true });
const url = new URL((await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim());
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const exec = promisify(execFile),
  startedAt = Date.now();
const report = {
  runtimeRevision: JSON.parse(await readFile(`${runtimeDirectory}/k3s/deployment.json`, "utf8"))
    .revision,
  accepted: false,
  cleanupConfirmed: false,
  runs: [],
  records: [],
};
const save = () => writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
async function until(read, label, ms = 240000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await delay(300);
  }
  throw Error(`${label} did not settle`);
}
let tenant, api, project, session, failure;
const settle = (id) =>
  until(async () => {
    const row = await db
      .selectFrom("runs")
      .select(["state", "lease_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return terminal(row.state) && (!row.lease_id || row.output_sealed_at);
  }, "writer closure");
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-timing-${randomUUID()}`,
    ownerDisplayName: "Timing acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  const origin = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), origin), init),
    tenant.credential.token,
  );
  project = await api.createProject("Preparation timing", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Preparation timing",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.resources = { tenantId: tenant.tenantId, sessionId: session.sessionId };
  await save();
  const bytes = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#2166dd" },
  })
    .png()
    .toBuffer();
  const upload = await api.uploadWorkspaceFile(
    session.sessionId,
    randomUUID(),
    new File([bytes], "timing.png", { type: "image/png" }),
    "timing.png",
  );
  for (const [index, prompt] of [
    "请简短说明图片的背景颜色，不使用任何工具。",
    "请再次说明刚才图片的背景颜色，不使用任何工具。",
  ].entries()) {
    const before = performance.now();
    const accepted = await api.acceptTurn(
      session.sessionId,
      prompt,
      newIdempotencyKey("timing"),
      "low",
      index === 0 ? [upload.id] : undefined,
    );
    assert.equal(accepted.kind, "run");
    const item = { runId: accepted.runId, ackMs: performance.now() - before };
    report.runs.push(item);
    await save();
    const result = await until(async () => {
      const value = await api.getRun(item.runId);
      return terminal(value.state) && value;
    }, "Run");
    item.state = result.state;
    assert.equal(result.state, "completed", result.failure?.message);
    await settle(item.runId);
    await save();
  }
  const ids = new Set(report.runs.map((run) => run.runId));
  for (const worker of await localWorkerTargets()) {
    const { stdout } = await exec(
      worker.binary,
      [...worker.logArgs, "--since-time", new Date(startedAt - 1000).toISOString()],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    for (const line of stdout.split("\n")) {
      if (!line.startsWith('{"timestamp"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !ids.has(record.attributes?.runId) ||
        !["run.preparation.timing", "model.preparation.timing", "model.transport.timing"].includes(
          record.event,
        )
      )
        continue;
      report.records.push({ event: record.event, ...record.attributes });
    }
  }
  for (const run of report.runs) {
    const records = report.records.filter((record) => record.runId === run.runId);
    for (const stage of [
      "writer_prepare",
      "model_grant",
      "pi_session_open",
      "pi_harness_open",
      "native_context_prepare",
      "native_request_prepare",
      "model_binding_wait",
      "model_permit_wait",
      "model_request_prepare",
    ])
      assert(
        records.some((record) => record.stage === stage && record.outcome === "completed"),
        `Missing ${stage}`,
      );
    assert(
      records.some(
        (record) =>
          record.event === "model.preparation.timing" &&
          record.httpDispatched &&
          record.afterPayloadMs >= 0,
      ),
      "Missing SDK-to-HTTP timing",
    );
    assert(
      records.some(
        (record) =>
          record.event === "model.transport.timing" &&
          record.bodyReceivedMs >= 0 &&
          record.bodyDecodeMs >= 0 &&
          record.bodyValidateMs >= 0,
      ),
      "Missing Gateway preparation timing",
    );
    assert(
      records.some((record) => record.storage_readCount > 0),
      "Missing actual storage read observations",
    );
  }
  const cold = report.records.filter((record) => record.runId === report.runs[1].runId);
  assert(
    cold.some((record) => record.image_readCount > 0 && record.imageBytes > 0),
    "Cold native context did not report image hydration",
  );
  assert(
    cold.some((record) => record.stage === "pi_harness_open" && record.reused === false),
    "Expected a cold owner after root settlement",
  );
  for (const record of report.records) {
    assert(
      !("prompt" in record) && !("content" in record) && !("apiKey" in record),
      "Payload must not enter timing logs",
    );
    if ("durationMs" in record)
      assert(Number.isFinite(record.durationMs) && record.durationMs >= 0);
  }
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
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settle);
      await api.deleteConversation(session.sessionId);
    }
    if (api && project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
      await until(
        async () =>
          (
            await db
              .selectFrom("workspaces")
              .select("storage_purged_at")
              .where("id", "=", project.workspaceId)
              .executeTakeFirst()
          )?.storage_purged_at,
        "Workspace purge",
      );
    }
    if (tenant) {
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(`${runtimeDirectory}/secrets/session-image-s3-credentials.json`, "utf8"),
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
  await save();
  await db.destroy();
  console.log(
    JSON.stringify({
      accepted: report.accepted,
      cleanupConfirmed: report.cleanupConfirmed,
      runs: report.runs,
      records: report.records.length,
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
