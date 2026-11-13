import { nativeCubeLifecycleOptions } from "./lib/cube-native-lifecycle-options.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { newIdempotencyKey } from "@pi-cloud/session-client";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { BoxLiteRuntimeClient } from "../packages/sandbox-control/src/boxlite-runtime-client.ts";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";
import {
  kubectl,
  serviceAddress,
  runtimeDirectory,
  runtimeEnvironment,
} from "./lib/production-kubernetes.mjs";
import { nativeHistory } from "./lib/native-session-history.mjs";
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
  "Opt in with PI_CLOUD_LIVE_TOOL_REPLY_CHECK=1: Luna, disposable Cube, scoped reply loss and owned allocation removal",
);
const scope = process.env.PI_CLOUD_REPLY_ACCEPTANCE_SCOPE ?? "all";
assert(
  ["all", "vm", "history"].includes(scope),
  "Select complete acceptance, the owned VM fault, or lost-result history",
);
const faultTarget = process.env.PI_CLOUD_REPLY_FAULT_TARGET ?? "vm";
assert(["vm", "cubelet"].includes(faultTarget), "Select an owned VM or an otherwise empty Cubelet");
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
const runtimeProvider = runtimeEnvironment().PI_CLOUD_SANDBOX_PROVIDER ?? "cubesandbox";
assert(["cubesandbox", "boxlite"].includes(runtimeProvider), "Unknown serving runtime provider");
assert(
  faultTarget !== "cubelet" || runtimeProvider === "cubesandbox",
  "Cubelet fault requires Cube compute",
);
const nativeCube = new OfficialCubeSandboxRuntimeClient({
  ...(runtimeProvider === "cubesandbox" ? nativeCubeLifecycleOptions() : {}),
  apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
  apiKey: await secret("cubesandbox-api-key"),
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: "10.255.255.254",
});
const cube =
  runtimeProvider === "cubesandbox"
    ? nativeCube
    : new BoxLiteRuntimeClient({
        url: `http://${JSON.parse(kubectl(["get", "service", "pi-cloud-boxlite", "-o", "json"])).spec.clusterIP}:8091`,
        nodeId: JSON.parse(await readFile(resolve(runtimeDirectory, "k3s/boxlite.json"), "utf8"))
          .nodeId,
        token: await secret("sandbox-control-token"),
        volumes: nativeCube,
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
  runtimeProvider,
  scope,
  accepted: false,
  cleanupConfirmed: false,
  cases: [],
};
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function until(check, label, ms = 600000, pollMs = 250) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(pollMs);
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
    detail.turns.find((t) => t.runId === id)?.transcript?.items.filter((i) => i.kind === "tool") ??
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
    "不要调用任何工具，用几段文字解释排序算法。",
    newIdempotencyKey("stop-bootstrap"),
    "low",
  );
  const beforeStop = await until(
    async () => {
      const row = await db
        .selectFrom("runs")
        .select(["state", "output_first_offset"])
        .where("id", "=", active.runId)
        .executeTakeFirstOrThrow();
      return row.state === "running" ? row : undefined;
    },
    "claimed Run before early Stop",
    10000,
    10,
  );
  await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("stop-bootstrap"));
  assert.equal(
    (await waitRun(active.runId)).state,
    "cancelled",
    "Early Stop did not settle normally",
  );
  assert.equal((await turnTools(active.runId)).length, 0, "Early Stop executed a Tool");
  assert.equal(
    (await cube.list()).filter((v) => v.metadata["picloud.tenant_id"] === tenant.tenantId).length,
    0,
  );
  report.cases.push({
    kind: "early-stop",
    state: "cancelled",
    beforeFirstOutput: beforeStop.output_first_offset === null,
    toolCalls: 0,
    cubeActivations: 0,
  });
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
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
  if (scope !== "vm") {
    const unknownTurns = [];
    receipt = await installOwnedReplyFault(receiptPath);
    for (const dropProbe of scope === "history" ? [false] : [false, true]) {
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
      let observedWaiting = false;
      if (dropProbe) {
        await until(
          async () => {
            const current = await api.getRun(active.runId);
            assert(
              !terminal(current),
              "Run ended instead of retaining its environment-recovery wait",
            );
            return (await turnTools(active.runId)).some(
              (tool) => tool.toolName === "bash" && tool.status === "unknown",
            );
          },
          "native UNKNOWN before environment recovery",
          240000,
        );
        await delay(15000);
        assert(!terminal(await api.getRun(active.runId)), "Missing readiness ended logical work");
        observedWaiting = true;
        await api.cancelTurn(
          session.sessionId,
          active.turnId,
          newIdempotencyKey("stop-unconfirmed-environment"),
        );
      }
      const run = await waitRun(active.runId),
        calls = await turnTools(active.runId);
      const state = readOwnedReplyFault(receipt);
      assert.equal(
        state?.nonce,
        nonce,
        `No matching reply-loss evidence; Run ${run.state}: ${JSON.stringify(run.failure)}`,
      );
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
        assert.equal(run.state, "cancelled", JSON.stringify(run.failure));
        assert(observedWaiting, "Missing readiness was not kept as an interruptible wait");
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
      unknownTurns.push({ turnId: active.turnId, toolCallId: bash[0].toolCallId, marker });
      report.cases.push({
        turnId: active.turnId,
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
    // Final callback retries resend bytes; they never run Bash again. A completed
    // background process also must not be killed because its first ACK was lost.
    if (scope === "all") {
      const ackMarker = `ACK_LOSS_${suffix}`;
      const ackNonce = armOwnedReplyFault(receipt, tenant.tenantId, ackMarker, false, true);
      const ackCommand = `nohup sleep 180 </dev/null >/dev/null 2>&1 & echo $! > ack-background.pid; printf 'once\\n' >> ack-count.txt; printf '${ackMarker}\\n'`;
      active = await api.acceptTurn(
        session.sessionId,
        `只调用一次 bash，command 精确使用 ${JSON.stringify(ackCommand)}，然后简短回复。不要重试命令或调用其他工具。`,
        newIdempotencyKey("callback-ack-loss"),
        "low",
      );
      assert.equal((await waitRun(active.runId)).state, "completed");
      const ackRunId = active.runId;
      const ackState = await until(
        () => {
          const value = readOwnedReplyFault(receipt);
          return value?.nonce === ackNonce && value.results.length >= 2 && value;
        },
        "identical callback resend after lost ACK",
        30000,
      );
      assert.equal(new Set(ackState.results.map((row) => row.operationId)).size, 1);
      assert.equal(
        (await turnTools(active.runId)).filter((tool) => tool.toolName === "bash").length,
        1,
      );
      assert.equal(
        Buffer.from(
          (await api.readWorkspaceFile(session.sessionId, "ack-count.txt")).bytes,
        ).toString(),
        "once\n",
      );
      active = await api.acceptTurn(
        session.sessionId,
        '只调用一次 bash，执行 kill -0 "$(cat ack-background.pid)" && printf BACKGROUND_PRESERVED，然后简短回复。不要其他工具。',
        newIdempotencyKey("callback-background-check"),
        "low",
      );
      assert.equal((await waitRun(active.runId)).state, "completed");
      const background = await turnTools(active.runId);
      assert.equal(background.length, 1);
      assert.equal(background[0].status, "completed");
      report.cases.push({
        kind: "lost-callback-ack",
        runId: ackRunId,
        deliveries: ackState.results.length,
        executions: 1,
        backgroundPreserved: true,
      });
    }
    await restoreOwnedReplyFault(receiptPath);
    report.adapterRestored = true;
    // Inspect canonical history independently of the live view before opening
    // a fresh browser. A rendering failure must not hide a storage regression.
    for (const expected of unknownTurns) {
      const restored = await api.getConversation(session.sessionId, {
        turnId: expected.turnId,
        toolCallId: expected.toolCallId,
      });
      const tool = restored.turns
        .find((turn) => turn.turnId === expected.turnId)
        ?.transcript?.items.find(
          (item) => item.kind === "tool" && item.toolCallId === expected.toolCallId,
        );
      assert.equal(tool?.status, "unknown", "Canonical history lost the UNKNOWN result");
    }
    report.canonicalUnknownRestored = true;
    await withChromePage({}, async (page) => {
      try {
        await page.send("Network.setExtraHTTPHeaders", {
          headers: { Authorization: `Bearer ${tenant.credential.token}` },
        });
        await page.navigate(`${base}/?session=${session.sessionId}`);
        await page.waitFor(
          `Array.from(document.querySelectorAll('.product-conversation-row > button:first-child')).some(b=>b.querySelector('strong')?.textContent===${JSON.stringify(title)}&&!b.disabled)`,
        );
        await page.evaluate(
          `Array.from(document.querySelectorAll('.product-conversation-row > button:first-child')).find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(title)}).click()`,
        );
        await page.waitFor(
          "document.querySelector('.product-conversation-row.active > button:first-child')?.disabled===false && document.querySelector('.product-history-search-toggle')?.disabled===false && Number(document.querySelector('[data-history-rows]')?.dataset.historyRows)>0",
        );
        await page.evaluate(
          "(()=>{const b=document.querySelector('.product-tool-group-display-toggle');if(b.getAttribute('aria-pressed')!=='true')b.click()})()",
        );
        // Search jumps use the actual history cursor. Blind scrollTop changes can
        // be undone by tail following or evict the very row being inspected.
        for (const expected of unknownTurns) {
          const matches = await api.searchConversation(session.sessionId, expected.marker);
          const index = matches.results.findIndex(
            (hit) => hit.turnId === expected.turnId && hit.kind === "tool",
          );
          assert(index >= 0, "Owned UNKNOWN tool was absent from searchable history");
          await page.evaluate("document.querySelector('.product-history-search-toggle').click()");
          await page.evaluate(
            `(()=>{const i=document.querySelector('.product-history-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(expected.marker)});i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
          );
          await page.evaluate(
            "document.querySelector('.product-history-search form').requestSubmit()",
          );
          await page.waitFor(`document.querySelectorAll('.product-history-hit').length > ${index}`);
          await page.evaluate(
            `document.querySelectorAll('.product-history-hit')[${index}].click()`,
          );
          await page.waitFor(
            `Array.from(document.querySelectorAll('.product-tool-unknown')).some(e=>e.closest('[data-conversation-turn-id]')?.getAttribute('data-conversation-turn-id')===${JSON.stringify(expected.turnId)})`,
          );
        }
        report.browserUnknownRestored = true;
      } catch (error) {
        await page.screenshot(`${output}.browser.png`).catch(() => {});
        report.browserDiagnostic = await page
          .evaluate(
            `({
          path:location.pathname+location.search,
          rows:document.querySelector('[data-history-rows]')?.getAttribute('data-history-rows'),
          tools:Array.from(document.querySelectorAll('.product-tool')).map(e=>({
            status:e.className,turn:e.closest('[data-conversation-turn-id]')?.getAttribute('data-conversation-turn-id')
          })),
          alerts:Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.textContent.slice(0,300))
        })`,
          )
          .catch(() => null);
        throw error;
      }
    });
  } // Complete callback fault scope.
  if (scope !== "history") {
    await excludeOtherWork();
    const instances = await cube.list();
    const owned = instances.filter((vm) => vm.metadata["picloud.tenant_id"] === tenant.tenantId);
    assert.equal(owned.length, 1, "Expected one owned fault VM");
    const unrelated = instances
      .filter((vm) => vm.metadata["picloud.tenant_id"] !== tenant.tenantId)
      .map((vm) => vm.sandboxId);
    if (faultTarget === "cubelet")
      assert.equal(instances.length, 1, "Cubelet crash requires exactly the owned VM");
    const before = faultTarget === "cubelet" ? singleReadyCubelet() : undefined;
    const allocation = await db
      .selectFrom("workspace_runtimes")
      .select(["workspace_runtime_id", "runtime_name"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("workspace_id", "=", project.workspaceId)
      .where("runtime_name", "=", owned[0].sandboxId)
      .where("allocation_closed", "=", false)
      .executeTakeFirstOrThrow();
    active = await api.acceptTurn(
      session.sessionId,
      "只调用一次 bash，timeout 设为 90，执行 printf 'started\\n' > reply-crash-started.txt; sleep 60。不要其他工具、搜索或委派。",
      newIdempotencyKey("owned-runtime-loss"),
      "low",
    );
    await until(
      async () => (await turnTools(active.runId)).some((c) => c.status === "running"),
      "running Tool before owned runtime loss",
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
      "actual guest effect before owned runtime loss",
      30000,
    );
    await excludeOtherWork();
    if (faultTarget === "cubelet") {
      kubectl(
        ["delete", "pod", before.metadata.name, "--grace-period=0", "--force", "--wait=false"],
        {
          timeout: 30000,
        },
      );
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
    } else {
      // A physical fault outside PiCloud's desired-state tables, confined to this
      // fixture allocation. This does not pause or delete any user's machine.
      await cube.destroy(allocation.runtime_name);
      await until(
        async () =>
          (await cube.observe(owned[0].sandboxId, owned[0].nodeId, owned[0])).presence === "absent",
        "native provider deletion evidence",
        120000,
      );
    }
    const interrupted = await waitRun(active.runId);
    assert.equal(
      interrupted.state,
      "completed",
      "The original Run did not continue after verified recovery",
    );
    const interruptedCalls = await turnTools(active.runId);
    assert.equal(
      interruptedCalls.filter((call) => call.toolName === "bash").length,
      1,
      "Original command was executed again",
    );
    assert(
      interruptedCalls.every((call) => ["completed", "failed", "unknown"].includes(call.status)),
      "Unsettled physical reply",
    );
    report.cases.push({
      kind: faultTarget === "cubelet" ? "cubelet-loss" : "owned-allocation-loss",
      runId: active.runId,
      state: interrupted.state,
      replacedPod: faultTarget === "cubelet",
      originalCalls: 1,
    });
    if (faultTarget === "vm") {
      const history = await nativeHistory(db, { tenantId: tenant.tenantId, runId: active.runId });
      assert(
        history.some((row) => row.entry.kind === "pi-cloud.sandbox_reset"),
        "Physical replacement was not recorded before model continuation",
      );
      const current = await cube.list();
      for (const id of unrelated)
        assert(
          current.some((vm) => vm.sandboxId === id),
          "An unrelated VM was removed",
        );
      assert(
        current.some(
          (vm) =>
            vm.metadata["picloud.tenant_id"] === tenant.tenantId &&
            vm.sandboxId !== owned[0].sandboxId &&
            vm.state === "running",
        ),
      );
      report.environmentResetRecorded = true;
    }
  }
  report.accepted = true;
} catch (error) {
  receipt ??= error.replyFaultReceipt;
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 700);
  if (receipt) {
    try {
      report.failedFaultEvidence = readOwnedReplyFault(receipt);
    } catch {}
  }
  if (active) {
    const run = await api.getRun(active.runId).catch(() => undefined);
    if (run) report.failedRun = { runId: active.runId, state: run.state, failure: run.failure };
    report.failedToolStates = (await turnTools(active.runId).catch(() => [])).map((tool) => ({
      name: tool.toolName,
      status: tool.status,
    }));
    report.environmentEntries = (
      await nativeHistory(db, { tenantId: tenant.tenantId, runId: active.runId }).catch(() => [])
    )
      .map((row) => row.entry.kind)
      .filter((kind) => kind?.startsWith("pi-cloud."));
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
      const blobs = new S3AttachmentBlobStore({
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
