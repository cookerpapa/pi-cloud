import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { snapshotTurn } from "./lib/session-snapshot.mjs";
import {
  isDurableAgentActivity,
  readWorkerModelTimings,
  runStageTiming,
} from "./lib/live-run-timing.mjs";

if (process.env.PI_CLOUD_LIVE_FAMILY_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_FAMILY_CHECK=1 for paid Session-family acceptance");
const root = new URL("..", import.meta.url).pathname;
const environment = Object.fromEntries(
  (await readFile(new URL("../deploy/production/runtime/.env", import.meta.url), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const databaseUrl = new URL(
  (
    await readFile(
      new URL("../deploy/production/runtime/secrets/database-url", import.meta.url),
      "utf8",
    )
  ).trim(),
);
const host = ["0.0.0.0", "::"].includes(environment.PI_CLOUD_HTTP_BIND_ADDRESS)
  ? "127.0.0.1"
  : environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const base = new URL(
  `http://${host.includes(":") ? `[${host}]` : host}:${environment.PI_CLOUD_HTTP_PORT}`,
);
const request = (path, init) => fetch(new URL(String(path), base), init);
const exec = promisify(execFile);
const compose = async (...args) =>
  (
    await exec(process.execPath, ["scripts/production-compose.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout.trim();
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;
const sql = (q) =>
  compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    decodeURIComponent(databaseUrl.username),
    "-d",
    decodeURIComponent(databaseUrl.pathname.slice(1)),
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    q,
  );
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const activeStates =
  "('claimed','provisioning','restoring','running','settling','cancel_requested')";
assert.equal(
  process.env.PI_CLOUD_SUPERVISOR_CAPACITY ?? environment.PI_CLOUD_SUPERVISOR_CAPACITY,
  "2",
  "Set the acceptance Worker family capacity to 2",
);
assert.equal(
  process.env.PI_CLOUD_WORKER_MODEL_CONCURRENCY ?? environment.PI_CLOUD_WORKER_MODEL_CONCURRENCY,
  "1",
  "Set the acceptance Worker model concurrency to 1",
);
assert.equal(
  process.env.PI_CLOUD_SESSION_MODEL_CONCURRENCY ?? environment.PI_CLOUD_SESSION_MODEL_CONCURRENCY,
  "1",
);
assert.equal(
  await sql(`select count(*) from runs where state in ${activeStates}`),
  "0",
  "Start only with a quiescent deployment",
);
// A stopped boot may remain in the control-channel grace interval. Do not
// confuse its expiring registration with a second executing Worker.
await until(
  async () =>
    (await sql(
      "select count(*) from supervisor_connections where state='active' and expires_at>now()",
    )) === "1",
  "single-Worker registration convergence",
  90_000,
);
const suffix = Date.now().toString(36);
const registration = await new PiCloudApi(request).registerTenant(
  `family-${suffix}`,
  "Session family acceptance",
);
const api = new PiCloudApi(request, registration.apiToken);
const owned = [];
const runs = [];
const timings = [];
let tenantId;
const model = {
  provider: "deepseek",
  modelId: "deepseek-v4-flash",
  thinkingLevel: "low",
  fastMode: false,
};
const report = {
  accepted: false,
  checkedAt: new Date().toISOString(),
  model,
  scenarios: {},
  timings,
};

async function session(name) {
  const project = await api.createProject(`Family ${name} ${suffix}`);
  const s = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Family ${name} ${suffix}`,
    "elastic",
  );
  owned.push({ sessionId: s.sessionId, workspaceId: project.workspaceId });
  await api.updateSessionModel(s.sessionId, model);
  tenantId ??= await sql(`select tenant_id::text from sessions where id=${quote(s.sessionId)}`);
  return s;
}
async function start(s, prompt, label) {
  const before = performance.now(),
    submittedWallAt = Date.now();
  const accepted = await api.acceptTurn(s.sessionId, prompt, newIdempotencyKey("family-live"));
  runs.push({ sessionId: s.sessionId, ...accepted });
  const timing = {
    label,
    submittedWallAt,
    admissionMs: performance.now() - before,
    firstVisibleMs: null,
    completedMs: null,
  };
  timings.push(timing);
  console.log(
    JSON.stringify({
      event: "family_turn_started",
      label,
      runId: accepted.runId,
      sessionId: s.sessionId,
    }),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  let terminal,
    text = "";
  const event = (e) => {
    if (e.turnId !== accepted.turnId) return;
    if (isDurableAgentActivity(e)) timing.firstVisibleMs ??= performance.now() - before;
    if (e.type === "assistant.text.delta") {
      text += e.payload.text;
      timing.firstAssistantTextMs ??= performance.now() - before;
      timing.firstAssistantTextEmittedAtMs ??= Date.parse(e.occurredAt);
      timing.firstAssistantTextReceivedAtMs ??= Date.now();
    }
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(e.type)) {
      terminal = e;
      controller.abort();
    }
  };
  const finished = (async () => {
    try {
      await streamSessionEvents({
        sessionId: s.sessionId,
        signal: controller.signal,
        authorizationToken: registration.apiToken,
        fetchImplementation: request,
        retryDelayMs: 100,
        onStatus() {},
        onEvent: event,
        onSnapshot: (snapshot) => {
          const state = snapshotTurn(snapshot, accepted.turnId);
          text = state?.text ?? "";
          if (text) timing.firstVisibleMs ??= performance.now() - before;
          if (state?.terminal) {
            terminal = state.terminal;
            controller.abort();
          }
        },
      });
      assert(terminal, `Missing terminal: ${label}`);
      timing.completedMs = performance.now() - before;
      const transport = await readWorkerModelTimings([accepted.runId], submittedWallAt);
      timing.stages = runStageTiming(timing, transport);
      console.log(
        JSON.stringify({ event: "family_turn_finished", terminal: terminal.type, ...timing }),
      );
      return { terminal, text, run: await api.getRun(accepted.runId) };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  })();
  void finished.catch(() => {});
  return { accepted, finished };
}
const succeeded = async (promise) => {
  const result = await promise;
  assert.equal(result.terminal.type, "turn.completed", JSON.stringify(result.terminal.payload));
  return result;
};
async function owner(runId) {
  return sql(`select h.supervisor_id from runs r join run_attempts a on a.id=r.current_attempt_id
  join sandboxes h on h.id=a.sandbox_id where r.id=${quote(runId)}`);
}

try {
  const a = await session("A"),
    b = await session("B"),
    c = await session("C");
  const runningWorkers = await sql(
    "select count(*) from supervisor_connections where state='active' and expires_at>now()",
  );
  assert.equal(
    runningWorkers,
    "1",
    "Run with one Worker, family capacity=2 and model concurrency=1",
  );
  const first = await start(
    a,
    [
      "Use subagent action workflow with runs.all to launch exactly three fresh shared-workspace children in parallel.",
      "Their separate tasks: implement insertion_sort.py with unit tests; implement binary_search.py with unit tests; implement fibonacci.py with unit tests.",
      "Each child must write and test only its own file, covering empty/boundary/normal/error inputs where applicable.",
      "After tests pass, each child MUST execute bash with timeout:60 to append one line to its own marker (insertion_sort.py.done, binary_search.py.done or fibonacci.py.done) and sleep 35 seconds, then report success.",
      "Put runnable unittest tests in those exact .py files. Return all three actual results from the workflow. Afterwards run python3 insertion_sort.py && python3 binary_search.py && python3 fibonacci.py yourself and answer exactly FAMILY-A-CODING-OK only if all tests pass.",
    ].join(" "),
    "parallel-coding",
  );
  await until(
    async () =>
      Number(
        await sql(`select count(*) from subagent_executions e join runs r on r.id=e.child_run_id
    where e.parent_run_id=${quote(first.accepted.runId)} and r.state='running'`),
      ) >= 2,
    "two active child Lanes",
  );
  const ownerId = await owner(first.accepted.runId);
  const familyLease = await sql(
    `select lease_id::text from session_leases where tenant_id=${quote(tenantId)} and pi_session_id=${quote(a.sessionId)}`,
  );
  assert(familyLease);
  const second = await start(
    b,
    "Use bash with timeout:15 to sleep 5 seconds, then reply exactly FAMILY-B-OK.",
    "independent-family",
  );
  await until(
    async () => (await api.getRun(second.accepted.runId)).state === "running",
    "second family running",
  );
  const third = await start(c, "Reply exactly FAMILY-C-OK without tools.", "capacity-queue");
  await delay(200);
  assert.equal(
    (await api.getRun(third.accepted.runId)).state,
    "queued",
    "Third family bypassed a two-family limit",
  );
  const occupancy = JSON.parse(
    await sql(`select json_build_object('leases',(select count(*) from session_leases),
    'activeTasks',(select count(*) from active_execution_scopes),
    'aLeaseIds',(select count(distinct a.lease_id) from run_attempts a join runs r on r.id=a.run_id join sessions s on s.id=r.session_id
      where s.pi_session_id=${quote(a.sessionId)} and a.lease_id is not null))`),
  );
  assert.equal(occupancy.leases, 2);
  assert(occupancy.activeTasks > 2);
  assert.equal(occupancy.aLeaseIds, 1);
  await succeeded(second.finished);
  assert.equal(
    (await api.getRun(first.accepted.runId)).state,
    "running",
    "Other family did not progress during child waits",
  );
  await succeeded(third.finished);
  const aResult = await succeeded(first.finished);
  assert.match(aResult.text, /FAMILY-A-CODING-OK/);
  assert.equal(
    await sql(
      `select count(*) from subagent_executions where parent_run_id=${quote(first.accepted.runId)}`,
    ),
    "3",
  );
  for (const filename of ["insertion_sort.py", "binary_search.py", "fibonacci.py"]) {
    assert((await api.readWorkspaceFile(a.sessionId, filename)).bytes.length > 100);
    const marker = Buffer.from((await api.readWorkspaceFile(a.sessionId, filename + ".done")).bytes)
      .toString("utf8")
      .trim();
    assert.equal(marker.split(/\r?\n/).length, 1, `${filename} executed more than once`);
  }
  assert.equal(await owner(second.accepted.runId), ownerId);
  report.scenarios.fairness = {
    ...occupancy,
    oneWorker: ownerId,
    otherFamilyFinishedBeforeCodingFamily: true,
    thirdFamilyQueued: true,
  };

  const next = await start(
    a,
    "Use subagent action run with context branch and sandbox shared. Ask it to read the three algorithm files from the previous turn, run all three test suites and verify that each .done file has exactly one line. After its actual result, reply FAMILY-RESTORE-OK.",
    "multi-round-branch",
  );
  const nextResult = await succeeded(next.finished);
  assert.match(nextResult.text, /FAMILY-RESTORE-OK/);
  const nextLease = await sql(
    `select a.lease_id::text from run_attempts a join runs r on r.current_attempt_id=a.id where r.id=${quote(next.accepted.runId)}`,
  );
  assert.notEqual(nextLease, familyLease);
  report.scenarios.multiRound = { newOwnerPeriod: true, workspaceTestsRepeated: true };

  if (process.env.PI_CLOUD_LIVE_FAMILY_FAULT === "1") {
    const crash = await start(
      a,
      "Use subagent action run, context fresh, sandbox shared. Its task: run bash with timeout:90 to append exactly one line to crash-once.txt, then sleep 60. Wait for the actual child result.",
      "worker-loss",
    );
    await until(async () => {
      const directory = await api.listWorkspaceDirectory(a.sessionId);
      if (!directory.entries.some((e) => e.name === "crash-once.txt")) return false;
      const file = await api.readWorkspaceFile(a.sessionId, "crash-once.txt");
      return file && Buffer.from(file.bytes).toString("utf8").trim().split(/\r?\n/).length === 1;
    }, "actual child effect before crash");
    assert.equal(
      await sql(
        `select count(*) from runs where tenant_id<>${quote(tenantId)} and state in ${activeStates}`,
      ),
      "0",
      "Refusing to interrupt unrelated work",
    );
    await compose("kill", "--signal", "SIGKILL", "supervisor-host");
    await compose("stop", "supervisor-host");
    const failed = await crash.finished;
    assert.equal(failed.terminal.type, "turn.failed");
    await until(
      async () =>
        (await sql(`select count(*) from run_attempts a join runs r on r.id=a.run_id join sessions s on s.id=r.session_id
      where s.pi_session_id=${quote(a.sessionId)} and a.output_seal_id is not null and a.output_sealed_at is null`)) ===
        "0",
      "family closure projection",
    );
    await compose("up", "-d", "--no-deps", "--wait", "supervisor-host-1");
    const resumed = await start(
      a,
      "The previous run was interrupted. Do not repeat the old append or launch script. Do this check yourself with bash: verify crash-once.txt has exactly one line, then run python3 insertion_sort.py && python3 binary_search.py && python3 fibonacci.py. Only if every check exits successfully, write recovery-verified.txt containing FAMILY-RECOVERY-OK and reply exactly FAMILY-RECOVERY-OK. If tools fail, report the failure without the success marker; do not retry more than once.",
      "replacement-worker",
    );
    const resumedResult = await succeeded(resumed.finished);
    const detail = await api.getConversation(a.sessionId);
    const final = detail.turns
      .find((t) => t.turnId === resumed.accepted.turnId)
      ?.transcript?.items.filter((item) => item.kind === "text")
      .at(-1)?.text;
    assert.equal(final?.trim().split(/\r?\n/).at(-1), "FAMILY-RECOVERY-OK");
    assert.equal(
      Buffer.from((await api.readWorkspaceFile(a.sessionId, "recovery-verified.txt")).bytes)
        .toString("utf8")
        .trim(),
      "FAMILY-RECOVERY-OK",
    );
    assert.equal(
      Buffer.from((await api.readWorkspaceFile(a.sessionId, "crash-once.txt")).bytes)
        .toString("utf8")
        .trim()
        .split(/\r?\n/).length,
      1,
    );
    assert.notEqual(await owner(resumed.accepted.runId), ownerId);
    report.scenarios.workerLoss = {
      familyClosedBeforeReplacement: true,
      changedWorker: true,
      explicitInspectionWithoutScriptReplay: true,
    };
  }
  report.usage = JSON.parse(
    await sql(`select json_build_object('input',coalesce(sum((payload->'message'->'usage'->>'input')::bigint),0),
    'cacheRead',coalesce(sum((payload->'message'->'usage'->>'cacheRead')::bigint),0),'output',coalesce(sum((payload->'message'->'usage'->>'output')::bigint),0))
    from pi_session_entries where tenant_id=${quote(tenantId)} and type='message' and payload->'message'->>'role'='assistant'`),
  );
  report.accepted = true;
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  try {
    for (const run of runs) {
      const state = await api.getRun(run.runId).catch(() => undefined);
      if (
        state &&
        !["completed", "failed", "cancelled", "timed_out", "superseded"].includes(state.state)
      )
        await api
          .cancelTurn(run.sessionId, run.turnId, newIdempotencyKey("family-cleanup"))
          .catch(() => {});
    }
    if (tenantId)
      await until(
        async () =>
          (await sql(
            `select count(*) from runs where tenant_id=${quote(tenantId)} and state in ${activeStates}`,
          )) === "0",
        "test task cleanup",
      );
    if (tenantId)
      await until(
        async () =>
          (await sql(`select count(*) from subagent_executions
    where tenant_id=${quote(tenantId)} and state in ('preparing','queued','running')`)) === "0",
        "delegated task settlement",
      );
    for (const s of owned) {
      await api.deleteConversation(s.sessionId, newIdempotencyKey("family-cleanup"));
      await api.deleteWorkspace(s.workspaceId, newIdempotencyKey("family-cleanup"));
    }
  } catch (error) {
    report.accepted = false;
    report.cleanupFailure = error.message;
    throw error;
  } finally {
    report.fixtureTenantId = tenantId;
    await writeFile(
      new URL("../docs/reports/session-family-acceptance-latest.json", import.meta.url),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  }
}
