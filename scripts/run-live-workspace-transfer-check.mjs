import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "kysely";
import { Upload } from "tus-js-client";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { newIdempotencyKey } from "@pi-cloud/session-client";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import { WORKSPACE_TRANSFER_CHUNK_BYTES } from "../packages/protocol/src/workspace-file-transfer.ts";
import { serviceAddress, runtimeDirectory } from "./lib/production-kubernetes.mjs";
import { assertLiveContract } from "./lib/live-contract.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";

if (process.env.PI_CLOUD_LIVE_WORKSPACE_TRANSFER_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_WORKSPACE_TRANSFER_CHECK=1 for owned Cube/large-file/browser acceptance",
  );
const output = process.argv[2] ?? "/tmp/pi-cloud-workspace-transfers-live.json";
const scope = process.argv[3] ?? "all";
assert(["all", "elastic", "machine"].includes(scope), "Use all, elastic or machine");
const env = await readFile(`${runtimeDirectory}/.env`, "utf8");
const base = `http://127.0.0.1:${env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1]}`;
const endpoint = new URL(
  (await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 3 });
const blobs = new S3AttachmentBlobStore({
  endpoint: `http://${serviceAddress("session-images")}:8333`,
  region: "us-east-1",
  bucket: "pi-cloud-session-images",
  ...JSON.parse(
    await readFile(`${runtimeDirectory}/secrets/session-image-s3-credentials.json`, "utf8"),
  ),
});
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-transfer-acceptance-"));
const report = {
  at: new Date().toISOString(),
  scope,
  model: "gpt-6-luna",
  accepted: false,
  resources: [],
  transfers: [],
  runs: [],
  peaks: {
    driverRss: process.memoryUsage().rss,
    browserJsHeap: 0,
    browserProcessTreeRss: 0,
    browserPrivateBytes: 0,
    controlPlaneRss: 0,
    samplingIntervalMs: 1000,
  },
};
const sessions = [],
  workspaces = [],
  machines = [];
let tenant, api, failure;
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
const exec = promisify(execFile);
async function browserMemory(page) {
  const { stdout } = await exec("ps", ["-eo", "pid=,ppid=,rss="]);
  const processes = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([page.browserPid]);
  let size;
  do {
    size = descendants.size;
    for (const [pid, parent] of processes) if (descendants.has(parent)) descendants.add(pid);
  } while (size !== descendants.size);
  const owned = processes.filter(([pid]) => descendants.has(pid));
  const privateBytes = await Promise.all(
    owned.map(async ([pid]) => {
      const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => "");
      return [...rollup.matchAll(/^Private_(?:Clean|Dirty):\s+(\d+)\s+kB/gm)].reduce(
        (sum, match) => sum + Number(match[1]) * 1024,
        0,
      );
    }),
  );
  return {
    rss: owned.reduce((sum, [, , rss]) => sum + rss * 1024, 0),
    privateBytes: privateBytes.reduce((a, b) => a + b, 0),
  };
}
let readingMetrics = false;
const metricsUrl = `http://${serviceAddress("session-api")}:9464/metrics`;
const metricsToken = (await readFile(`${runtimeDirectory}/secrets/metrics-token`, "utf8")).trim();
const timer = setInterval(() => {
  report.peaks.driverRss = Math.max(report.peaks.driverRss, process.memoryUsage().rss);
  if (readingMetrics) return;
  readingMetrics = true;
  void fetch(metricsUrl, {
    headers: { authorization: `Bearer ${metricsToken}` },
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => response.text())
    .then((text) => {
      const value = /^process_resident_memory_bytes(?:\{[^\n]*\})?\s+([0-9.e+-]+)/m.exec(text)?.[1];
      if (value)
        report.peaks.controlPlaneRss = Math.max(report.peaks.controlPlaneRss, Number(value));
    })
    .catch(() => undefined)
    .finally(() => {
      readingMetrics = false;
    });
}, 1000);
timer.unref();
async function until(read, label, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out`);
}
async function fixtureFile(size) {
  const name = `weights-${size}.bin`,
    path = join(directory, name);
  const handle = await open(path, "w");
  try {
    const header = Buffer.from(`PiCloud upload ${randomUUID()}\n`);
    await handle.truncate(size);
    await handle.write(header, 0, header.length, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { name, path, byteLength: size, sha256: hash.digest("hex") };
}
async function settled(id) {
  const run = await until(
    async () => {
      const value = await api.getRun(id);
      return terminal(value.state) && value;
    },
    "Run settlement",
    600000,
  );
  await until(async () => {
    const row = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !row.output_seal_id || row.output_sealed_at;
  }, "Ordered closure");
  return run;
}
async function verifyRun(session, runId, source) {
  const run = await settled(runId);
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  const turn = await until(
    async () =>
      (await api.getConversation(session.sessionId)).turns.find(
        (value) => value.runId === runId && value.transcript?.terminalSequence,
      ),
    "Projected Tool result",
  );
  const tools = turn.transcript.items.filter((item) => item.kind === "tool");
  assert(
    tools.some(
      (tool) =>
        tool.toolName === "bash" &&
        tool.status === "completed" &&
        JSON.stringify(tool.output).includes(source.sha256),
    ),
    "Canonical Bash result did not verify source digest",
  );
  const row = await db
    .selectFrom("runs")
    .select(["input_text", "input_uploads", "model_id"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(row.model_id, report.model);
  assert.deepEqual(row.input_uploads, []);
  assert(Buffer.byteLength(row.input_text) < 4096, "File bytes entered native input");
  assert(!/s3:|attachment_ref|bucket|object_key/i.test(row.input_text));
  report.runs.push({
    runId,
    digestVerifiedByBash: true,
    inputBytes: Buffer.byteLength(row.input_text),
  });
  await save();
}
function tus(source, resource, pauseAfter = 0) {
  return new Promise((resolve, reject) => {
    let paused = false;
    const stream = createReadStream(source.path);
    const upload = new Upload(stream, {
      uploadUrl: `${base}/v1/sessions/${resource.sessionId}/workspace-files/${resource.id}/content`,
      chunkSize: WORKSPACE_TRANSFER_CHUNK_BYTES,
      retryDelays: [],
      storeFingerprintForResuming: false,
      headers: { authorization: `Bearer ${tenant.credential.token}` },
      onChunkComplete: (_chunk, bytes) => {
        if (pauseAfter && bytes >= pauseAfter && !paused) {
          paused = true;
          void upload.abort().then(() => {
            stream.destroy();
            resolve({ paused: true, offset: bytes });
          }, reject);
        }
      },
      onError: (error) => {
        stream.destroy();
        reject(error);
      },
      onSuccess: () => {
        stream.destroy();
        if (!paused) resolve({ paused: false, offset: source.byteLength });
      },
    });
    upload.start();
  });
}
async function noOriginals() {
  const counts = (
    await sql`select
    (select count(*) from session_uploads where tenant_id=${tenant.tenantId}::uuid)::int as uploads,
    (select count(*) from session_attachment_objects where tenant_id=${tenant.tenantId}::uuid)::int as originals`.execute(
      db,
    )
  ).rows[0];
  assert.deepEqual(counts, { uploads: 0, originals: 0 });
}
async function selectConversation(page, title) {
  await page.waitFor("document.querySelector('.product-conversation-row')");
  await page.evaluate(
    `(()=>{const row=[...document.querySelectorAll('.product-conversation-row')].find(node=>node.textContent.includes(${JSON.stringify(title)}));if(!row)throw Error('Fixture chat missing');(row.matches('button')?row:row.querySelector('button')).click();})()`,
  );
  await page.waitFor(
    `document.querySelector('.product-topbar-title strong')?.textContent===${JSON.stringify(title)} && document.querySelector('.product-composer textarea') && !document.querySelector('.product-composer textarea').disabled`,
  );
}
async function selectFile(page, selector, path) {
  const doc = await page.send("DOM.getDocument");
  const node = await page.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  assert(node.nodeId, "File picker missing");
  await page.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [path] });
}
try {
  report.contract = await assertLiveContract(db, runtimeDirectory, { modelRuntimeSnapshot: 1 });
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-transfer-${randomUUID()}`,
    ownerDisplayName: "Workspace transfer acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  report.tenantId = tenant.tenantId;
  await save();
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), base), init),
    tenant.credential.token,
  );
  const model = {
    provider: "openai-codex",
    modelId: report.model,
    thinkingLevel: "low",
    fastMode: false,
  };
  if (["all", "elastic"].includes(scope)) {
    const project = await api.createProject("Elastic transfer fixture", { kind: "empty" });
    workspaces.push(project.workspaceId);
    const session = await api.createSession(
      project.projectId,
      project.workspaceId,
      "Elastic transfer fixture",
      "elastic",
      "starter",
      "/workspace",
      model,
    );
    sessions.push(session.sessionId);
    report.resources.push({
      kind: "elastic",
      sessionId: session.sessionId,
      workspaceId: project.workspaceId,
    });
    await save();
    const source = await fixtureFile(5 * 1024 ** 3),
      id = randomUUID();
    const started = performance.now();
    const resource = await api.createWorkspaceFileTransfer(session.sessionId, id, {
      workspaceId: project.workspaceId,
      workingDirectory: "/workspace",
      name: source.name,
      byteLength: source.byteLength,
      sha256: source.sha256,
    });
    const paused = await tus(source, resource, 2 * WORKSPACE_TRANSFER_CHUNK_BYTES);
    assert(paused.paused);
    const progress = await api.workspaceFileTransfer(session.sessionId, id);
    assert.equal(progress.offset, paused.offset);
    assert.equal(progress.state, "uploading");
    assert.equal(
      (await db.selectFrom("runs").select("id").where("tenant_id", "=", tenant.tenantId).execute())
        .length,
      0,
    );
    assert.equal(
      (
        await sql`select count(*)::int n from workspace_runtimes where tenant_id=${tenant.tenantId}::uuid`.execute(
          db,
        )
      ).rows[0].n,
      0,
    );
    await tus(source, progress);
    const completed = await api.workspaceFileTransfer(session.sessionId, id);
    assert.equal(completed.state, "ready");
    assert.equal(completed.offset, source.byteLength);
    await noOriginals();
    report.transfers.push({
      kind: "elastic",
      byteLength: source.byteLength,
      resumedAt: progress.offset,
      durationMs: performance.now() - started,
      sha256: source.sha256,
      vmFreeUntilTool: true,
    });
    await save();
    const accepted = await api.acceptTurn(
      session.sessionId,
      `Use bash exactly once to run sha256sum ${JSON.stringify(completed.path)}. Return the resulting digest. Do not edit files, search, or delegate.`,
      newIdempotencyKey("turn"),
      "low",
    );
    assert.equal(accepted.kind, "run");
    await verifyRun(session, accepted.runId, source);
  }
  if (["all", "machine"].includes(scope)) {
    const machine = await api.createDevelopmentEnvironment(
      "Machine transfer fixture",
      "starter",
      newIdempotencyKey("machine"),
    );
    machines.push(machine.environmentId);
    workspaces.push(machine.workspaceId);
    await until(
      async () =>
        (await api.listDevelopmentEnvironments()).environments.find(
          (value) => value.environmentId === machine.environmentId && value.state === "running",
        ),
      "Owned machine activation",
      600000,
    );
    const title = "Browser transfer fixture";
    const session = await api.createSession(
      machine.projectId,
      machine.workspaceId,
      title,
      "development_environment",
      "starter",
      "/home/user",
      model,
    );
    sessions.push(session.sessionId);
    report.resources.push({
      kind: "machine",
      environmentId: machine.environmentId,
      sessionId: session.sessionId,
      workspaceId: machine.workspaceId,
    });
    await save();
    const source = await fixtureFile(1024 ** 3);
    const started = performance.now();
    await withChromePage({ width: 1280, height: 900 }, async (page) => {
      await page.send("Network.setExtraHTTPHeaders", {
        headers: { Authorization: `Bearer ${tenant.credential.token}` },
      });
      await page.send("Performance.enable");
      let measuring = false;
      const measure = setInterval(() => {
        if (measuring) return;
        measuring = true;
        void page
          .send("Performance.getMetrics")
          .then((value) => {
            report.peaks.browserJsHeap = Math.max(
              report.peaks.browserJsHeap,
              value.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0,
            );
            return browserMemory(page);
          })
          .then((result) => {
            report.peaks.browserProcessTreeRss = Math.max(
              report.peaks.browserProcessTreeRss,
              result.rss,
            );
            report.peaks.browserPrivateBytes = Math.max(
              report.peaks.browserPrivateBytes,
              result.privateBytes,
            );
          })
          .catch(() => undefined)
          .finally(() => {
            measuring = false;
          });
      }, 1000);
      measure.unref();
      try {
        await page.navigate(base);
        await selectConversation(page, title);
        report.browserBaseline = await browserMemory(page);
        await page.evaluate("document.querySelector('.product-composer textarea').focus()");
        await page.send("Input.insertText", {
          text: "Use bash exactly once to run sha256sum on the uploaded file. Return its digest. Do not edit files, search, or delegate.",
        });
        await selectFile(page, ".product-composer input[type=file]", source.path);
        await page.waitFor(
          "document.querySelector('.product-composer-shell>.upload-cards select')",
        );
        await page.evaluate(
          "(()=>{const select=document.querySelector('.product-composer-shell>.upload-cards select');select.value='workspace';select.dispatchEvent(new Event('change',{bubbles:true}));})()",
        );
        assert.equal(
          (
            await db
              .selectFrom("workspace_file_transfers")
              .select("id")
              .where("session_id", "=", session.sessionId)
              .execute()
          ).length,
          0,
        );
        await page.evaluate("document.querySelector('.product-send-button').click()");
        const row = await until(
          () =>
            db
              .selectFrom("workspace_file_transfers")
              .selectAll()
              .where("session_id", "=", session.sessionId)
              .executeTakeFirst(),
          "Browser upload admission",
          180000,
        );
        const partial = await until(
          async () => {
            const value = await api.workspaceFileTransfer(session.sessionId, row.id);
            return (
              value.offset >= WORKSPACE_TRANSFER_CHUNK_BYTES &&
              value.offset < source.byteLength &&
              value
            );
          },
          "Browser partial transfer",
          180000,
        );
        assert.equal(
          (
            await db
              .selectFrom("runs")
              .select("id")
              .where("session_id", "=", session.sessionId)
              .execute()
          ).length,
          0,
        );
        await page.navigate(base);
        await selectConversation(page, title);
        await page.waitFor(
          "document.querySelector('.product-composer-shell>.upload-cards input[type=file]') && document.querySelector('.product-composer textarea').value.includes('sha256sum')",
        );
        await page.screenshot(`${output}.restored.png`);
        await selectFile(
          page,
          ".product-composer-shell>.upload-cards input[type=file]",
          source.path,
        );
        await page.evaluate("document.querySelector('.product-send-button').click()");
        const run = await until(
          () =>
            db
              .selectFrom("runs")
              .select("id")
              .where("session_id", "=", session.sessionId)
              .executeTakeFirst(),
          "Browser upload and input acceptance",
          1800000,
        );
        await verifyRun(session, run.id, source);
        const completed = await api.workspaceFileTransfer(session.sessionId, row.id);
        assert.equal(completed.state, "ready");
        assert.equal(completed.sha256, source.sha256);
        await noOriginals();
        // File-panel uploads are independent of sending a message and keep the
        // selected nested directory after their tree refresh.
        await page.evaluate(
          "[...document.querySelectorAll('.product-topbar button')].find(b=>['Workspace','工作区'].includes(b.textContent.trim())).click()",
        );
        await page.waitFor(
          "document.querySelector('.workspace-upload-panel') && document.querySelector('.workspace-tree-directory')",
        );
        await page.evaluate(
          "[...document.querySelectorAll('.workspace-tree-directory')].find(b=>b.textContent.includes('uploads')).click()",
        );
        await page.waitFor(
          `document.querySelector('.workspace-upload-panel select option[value="uploads/${row.id}"]')`,
        );
        await page.evaluate(
          `(()=>{const select=document.querySelector('.workspace-upload-panel select');select.value='uploads/${row.id}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        const panelPath = join(directory, "panel.txt");
        await writeFile(panelPath, "Workspace panel fixture\n");
        await selectFile(page, ".workspace-upload-panel>input[type=file]", panelPath);
        await page.waitFor("document.querySelector('.workspace-upload-panel .upload-card')");
        await page.evaluate(
          "[...document.querySelectorAll('.workspace-upload-panel>button')].find(b=>['Start upload','开始上传'].includes(b.textContent.trim())).click()",
        );
        const panel = await until(
          () =>
            db
              .selectFrom("workspace_file_transfers")
              .select(["relative_path", "state"])
              .where("session_id", "=", session.sessionId)
              .where("name", "=", "panel.txt")
              .where("state", "=", "ready")
              .executeTakeFirst(),
          "File-panel upload",
        );
        assert.equal(panel.relative_path, `uploads/${row.id}/panel.txt`);
        await page.waitFor(
          `document.querySelector('.workspace-upload-panel select').value==='uploads/${row.id}'`,
        );
        await page.evaluate(
          "[...document.querySelectorAll('.workspace-upload-panel>button')].find(b=>b.textContent.includes('panel.txt')).click()",
        );
        await page.waitFor(
          `document.querySelector('.product-composer textarea').value.includes('/home/user/uploads/${row.id}/panel.txt')`,
        );
        assert.equal(
          (
            await db
              .selectFrom("runs")
              .select("id")
              .where("session_id", "=", session.sessionId)
              .execute()
          ).length,
          1,
        );
        report.filePanel = { nestedDirectoryRetained: true, referenceWithoutNewRun: true };
        report.transfers.push({
          kind: "machine-browser",
          byteLength: source.byteLength,
          browserReloadAt: partial.offset,
          sameTransferId: row.id,
          durationMs: performance.now() - started,
          sha256: source.sha256,
        });
        await save();
      } finally {
        clearInterval(measure);
      }
    });
  }
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = { name: error.name, message: error.message };
} finally {
  clearInterval(timer);
  const errors = [];
  if (api && tenant) {
    for (const id of sessions)
      try {
        const runs = await db
          .selectFrom("runs")
          .select(["id", "turn_id"])
          .where("session_id", "=", id)
          .execute();
        await settleOwnedAcceptanceRuns(api, id, runs, settled);
        await until(async () => {
          try {
            await api.deleteConversation(id);
            return true;
          } catch (error) {
            if (error.status === 404) return true;
            if (error.status === 409) return false;
            throw error;
          }
        }, "Owned Session deletion");
      } catch (error) {
        errors.push(error);
      }
    for (const id of machines)
      try {
        await api.developmentEnvironmentAction(id, "release", newIdempotencyKey("release"));
      } catch (error) {
        errors.push(error);
      }
    for (const id of workspaces)
      try {
        const current = await db
          .selectFrom("workspaces")
          .select(["deleted_at", "storage_purged_at"])
          .where("id", "=", id)
          .executeTakeFirst();
        if (current && !current.deleted_at)
          await api.deleteWorkspace(id, newIdempotencyKey("delete"));
        await until(
          async () => {
            const row = await db
              .selectFrom("workspaces")
              .select(["deleted_at", "storage_purged_at"])
              .where("id", "=", id)
              .executeTakeFirst();
            return !row || (row.deleted_at && row.storage_purged_at);
          },
          "Owned physical Volume cleanup",
          600000,
        );
      } catch (error) {
        errors.push(error);
      }
    if (!errors.length)
      try {
        await until(
          async () =>
            Number(
              (
                await sql`select count(*)::int n from outbox where tenant_id=${tenant.tenantId}::uuid and published_at is null`.execute(
                  db,
                )
              ).rows[0].n,
            ) === 0,
          "Owned control propagation",
        );
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } catch (error) {
        errors.push(error);
      }
  }
  report.cleanupSucceeded = errors.length === 0;
  if (errors.length)
    report.cleanupErrors = errors.map((error) => ({ name: error.name, message: error.message }));
  await save();
  blobs.close();
  await db.destroy();
  await rm(directory, { recursive: true, force: true });
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Workspace transfer acceptance failed",
    );
}
console.log(JSON.stringify(report));
