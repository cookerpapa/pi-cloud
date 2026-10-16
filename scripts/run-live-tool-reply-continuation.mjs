import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";
import { kubectl, serviceAddress, runtimeDirectory } from "./lib/production-kubernetes.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import {
  installOwnedReplyFault,
  armOwnedReplyFault,
  readOwnedReplyFault,
  restoreOwnedReplyFault,
  singleReadyCubelet,
} from "./lib/live-tool-reply-fault.mjs";

if (process.argv[2] === "--restore") {
  assert(process.argv[3], "Pass the private adapter restore receipt");
  await restoreOwnedReplyFault(resolve(process.argv[3]));
  process.exit(0);
}
assert.equal(
  process.env.PI_CLOUD_LIVE_TOOL_REPLY_CHECK,
  "1",
  "Opt in with PI_CLOUD_LIVE_TOOL_REPLY_CHECK=1: Luna, disposable Cube, scoped reply loss and owned Cubelet crash",
);
const output = resolve(process.argv[2] ?? "dist/tool-reply-continuation.json");
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const receiptPath = `${output}.adapter-restore.json`;
const secret = async (name) =>
  (await readFile(resolve(runtimeDirectory, "secrets", name), "utf8")).trim();
const port = (await readFile(resolve(runtimeDirectory, ".env"), "utf8")).match(
  /^PI_CLOUD_HTTP_PORT=(\d+)$/m,
)?.[1];
assert(port);
const base = `http://127.0.0.1:${port}`,
  suffix = Date.now().toString(36),
  title = `Reply ${suffix}`;
const pg = new URL(await secret("database-url"));
pg.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
const cluster = JSON.parse(
  await readFile(resolve(runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
);
const cube = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
  apiKey: await secret("cubesandbox-api-key"),
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: "10.255.255.254",
});
let tenant, project, session, active, receipt, failure;
const api = new PiCloudApi((path, init = {}) =>
  fetch(new URL(path, base), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      ...(tenant ? { authorization: `Bearer ${tenant.credential.token}` } : {}),
    },
  }),
);
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  cases: [],
};
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function until(check, label, ms = 600000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function waitRun(id) {
  return until(async () => {
    const run = await api.getRun(id);
    if (!terminal(run)) return;
    const row = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !row.output_seal_id || row.output_sealed_at ? run : undefined;
  }, "Run and writer settlement");
}
async function excludeOtherWork() {
  const rows = await db
    .selectFrom("runs")
    .select("id")
    .where("tenant_id", "!=", tenant.tenantId)
    .where("state", "not in", ["completed", "failed", "cancelled", "timed_out"])
    .execute();
  assert.equal(rows.length, 0, "Refuse fault injection during unrelated work");
}
async function turnTools(id) {
  const detail = await api.getConversation(session.sessionId);
  return (
    detail.turns.find((t) => t.runId === id)?.transcript.items.filter((i) => i.kind === "tool") ??
    []
  );
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-reply-${suffix}`,
    ownerDisplayName: title,
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  project = await api.createProject(title);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    title,
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  active = await api.acceptTurn(
    session.sessionId,
    "只调用一次 bash，执行 printf 'REPLY_READY'，然后简短回复。不要其他工具、搜索或委派。",
    newIdempotencyKey("reply-warmup"),
    "low",
  );
  assert.equal((await waitRun(active.runId)).state, "completed", "Warmup failed");
  const originalVm = (await cube.list()).find(
    (v) => v.metadata["picloud.tenant_id"] === tenant.tenantId,
  );
  assert(originalVm, "Warmup did not prepare the owned VM");
  await excludeOtherWork();
  receipt = await installOwnedReplyFault(receiptPath);
  for (const dropProbe of [false, true]) {
    await excludeOtherWork();
    const marker = `REPLY_LOSS_${suffix}_${Number(dropProbe)}`,
      path = `reply-${Number(dropProbe)}.txt`;
    const nonce = armOwnedReplyFault(receipt, tenant.tenantId, marker, dropProbe);
    const command = `printf 'hello\\n' >> ${path}; printf '${marker}\\n'`;
    const started = Date.now();
    active = await api.acceptTurn(
      session.sessionId,
      `严格调用一次 bash，参数 command 必须是 ${JSON.stringify(command)}，timeout 必须为 5。该命令无论返回什么，都绝对不要重复执行。如果结果未知，使用 read 读取 ${path}，确认只有一行 hello。然后简短说明检查结果。不要搜索、委派、其他修改或其他 bash。`,
      newIdempotencyKey("reply-loss"),
      "low",
    );
    const run = await waitRun(active.runId),
      calls = await turnTools(active.runId);
    const state = readOwnedReplyFault(receipt);
    assert.equal(state?.nonce, nonce);
    assert(
      state.results.some((r) => r.runId === active.runId),
      "No owned result was suppressed",
    );
    assert(state.probes.length > 0, "No guest path probe was observed");
    const bash = calls.filter((c) => c.toolName === "bash");
    assert.equal(bash.length, 1, "Original command was repeated");
    assert.equal(bash[0].input.command, command);
    assert.equal(bash[0].input.timeout, 5);
    assert.equal(bash[0].status, "unknown");
    if (dropProbe) {
      assert.equal(run.state, "failed", JSON.stringify(run.failure));
      assert.equal(calls.length, 1, "Agent continued without confirmed readiness");
      assert(state.probes.every((p) => p.suppressed));
    } else {
      assert.equal(run.state, "completed", JSON.stringify(run.failure));
      assert(calls.some((c) => c.toolName === "read" && c.status === "completed"));
      assert(state.probes.every((p) => !p.suppressed));
    }
    assert.equal(
      Buffer.from((await api.readWorkspaceFile(session.sessionId, path)).bytes).toString(),
      "hello\n",
    );
    assert(
      (await cube.list()).some(
        (v) => v.sandboxId === originalVm.sandboxId && v.state === "running",
      ),
      "Missing result/probe replaced the physical VM",
    );
    for (const probe of state.probes) {
      const { rows } = await sql`select count(*)::int as n from (
        select body from pi_durable_log where tenant_id=${tenant.tenantId}::uuid
        union all select body from pi_durable_current where tenant_id=${tenant.tenantId}::uuid
      ) native where position(${probe.operationId} in body)>0`.execute(db);
      assert.equal(rows[0].n, 0, "Probe leaked into native storage");
    }
    report.cases.push({
      kind: dropProbe ? "lost-result-and-probe" : "lost-result-then-inspect",
      runId: run.runId ?? active.runId,
      state: run.state,
      elapsedMs: Date.now() - started,
      originalExecutions: 1,
      probePackets: state.probes.length,
      probeInNativeStorage: false,
      tools: calls.map((c) => ({ name: c.toolName, status: c.status })),
    });
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  await restoreOwnedReplyFault(receiptPath);
  report.adapterRestored = true;
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: `Bearer ${tenant.credential.token}` },
    });
    await page.navigate(base);
    await page.waitFor(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes(${JSON.stringify(title)}))`,
    );
    await page.evaluate(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(title)})).click()`,
    );
    await page.waitFor("document.querySelectorAll('.product-tool-unknown').length>=2", 20000);
    report.browserUnknownRestored = true;
  });
  await excludeOtherWork();
  const instances = await cube.list();
  assert.equal(instances.length, 1, "Cubelet crash requires exactly the owned VM");
  assert.equal(instances[0].metadata["picloud.tenant_id"], tenant.tenantId);
  const before = singleReadyCubelet();
  active = await api.acceptTurn(
    session.sessionId,
    "只调用一次 bash，timeout 设为 90，执行 printf 'started\\n' > reply-crash-started.txt; sleep 60。不要其他工具、搜索或委派。",
    newIdempotencyKey("cubelet-crash"),
    "low",
  );
  await until(
    async () => (await turnTools(active.runId)).some((c) => c.status === "running"),
    "running Tool before Cubelet loss",
    90000,
  );
  await until(
    async () => {
      try {
        return (
          Buffer.from(
            (await api.readWorkspaceFile(session.sessionId, "reply-crash-started.txt")).bytes,
          ).toString() === "started\n"
        );
      } catch {
        return false;
      }
    },
    "actual guest effect before Cubelet loss",
    30000,
  );
  await excludeOtherWork();
  kubectl(["delete", "pod", before.metadata.name, "--grace-period=0", "--force", "--wait=false"], {
    timeout: 30000,
  });
  await until(
    () => {
      try {
        const after = singleReadyCubelet();
        return after.metadata.uid !== before.metadata.uid ? after : undefined;
      } catch {
        return undefined;
      }
    },
    "Cubelet replacement",
    180000,
  );
  const interrupted = await waitRun(active.runId);
  assert.notEqual(interrupted.state, "completed", "Cubelet loss fabricated a completed result");
  const interruptedCalls = await turnTools(active.runId);
  assert.equal(interruptedCalls.length, 1, "Old binding continued after Cubelet replacement");
  report.cases.push({
    kind: "cubelet-loss",
    runId: active.runId,
    state: interrupted.state,
    replacedPod: true,
    originalCalls: 1,
  });
  report.accepted = true;
} catch (error) {
  receipt ??= error.replyFaultReceipt;
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 700);
  if (active) {
    const run = await api.getRun(active.runId).catch(() => undefined);
    if (run) report.failedRun = { runId: active.runId, state: run.state, failure: run.failure };
  }
} finally {
  try {
    if (receipt) {
      await restoreOwnedReplyFault(receiptPath);
      report.adapterRestored = true;
    }
  } catch (error) {
    report.restoreFailure = String(error.message).slice(0, 500);
    failure ??= error;
  }
  try {
    if (session) {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, waitRun);
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("reply-cleanup"));
      await until(
        async () => {
          const workspace = await db
            .selectFrom("workspaces")
            .select("storage_purged_at")
            .where("id", "=", project.workspaceId)
            .executeTakeFirst();
          const pending = await db
            .selectFrom("outbox")
            .select("id")
            .where("tenant_id", "=", tenant.tenantId)
            .where("published_at", "is", null)
            .execute();
          return workspace?.storage_purged_at && !pending.length;
        },
        "owned Workspace physical cleanup",
        300000,
      );
    }
    if (tenant) {
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(await secret("session-image-s3-credentials.json")),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } finally {
        blobs.close();
      }
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    report.cleanupFailure = String(error.message).slice(0, 700);
    failure ??= error;
  }
  await cube.close();
  await db.destroy();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
