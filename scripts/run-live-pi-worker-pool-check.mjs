import { readNativeHistory, nativeMessages, runUsage } from "./lib/native-session-history.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readPrivateRuntimeFile as readPrivate } from "./lib/runtime-file-policy.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { snapshotTurn } from "./lib/session-snapshot.mjs";
import { localWorkerTargets } from "./lib/live-run-timing.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.PI_CLOUD_LIVE_WORKER_POOL_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_WORKER_POOL_CHECK=1 to acknowledge real model usage and a controlled Worker restart",
  );
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);

const environment = Object.fromEntries(
  (await readPrivate(resolve(runtimeDirectory, ".env"), 64 * 1_024, "Production environment"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const databaseUrl = new URL(
  (
    await readPrivate(
      resolve(runtimeDirectory, "secrets/database-url"),
      4_096,
      "Production database URL",
    )
  ).trim(),
);
const databaseUser = decodeURIComponent(databaseUrl.username);
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
if (
  databaseUrl.protocol !== "postgresql:" ||
  !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(databaseUser) ||
  !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(databaseName)
) {
  throw new Error("Production database identity is invalid");
}
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const token = (
  await readPrivate(resolve(runtimeDirectory, "secrets/api-token"), 4_096, "Production API token")
).trim();
let authorizationToken = token;
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);
const bootstrapApi = new PiCloudApi(fetchFromProduction, token);
let api = bootstrapApi;
const workerDeployment = "kubernetes";
const kubernetesKubeconfig = resolve(runtimeDirectory, "k3s/kubeconfig.yaml");
const kubernetesNamespace = "cube-system";
const kubernetesStatefulSet = "pi-cloud-pi-worker-primary-v1";
const kubernetesScaleDownWorker = `${kubernetesStatefulSet}-1`;

function capture(command, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 2 * 1_024 * 1_024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(`${command} failed: ${stderr.trim().slice(-2_000) || error.message}`, {
              cause: error,
            }),
          );
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function psql(query) {
  return capture(process.execPath, [
    "scripts/production-kubernetes.mjs",
    "exec",
    "postgres",
    "psql",
    "--username",
    databaseUser,
    "--dbname",
    databaseName,
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
}

async function runUsageEvidence(runId) {
  return runUsage(await readNativeHistory(psql, { runId }));
}

function wait(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    function settle() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolvePromise();
    }
    signal?.addEventListener("abort", settle, { once: true });
  });
}

async function waitForRun(runId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(
        `Run ${run.runId} ended as ${run.state}${
          run.failure === undefined
            ? ""
            : ` (${run.failure.code}: ${run.failure.message ?? "no detail"})`
        }`,
      );
    }
    await wait(100);
  }
  throw new Error(`Run ${runId} did not settle`);
}

async function waitForTerminalRun(runId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (["completed", "failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      return run;
    }
    await wait(100);
  }
  throw new Error(`Run ${runId} did not reach a terminal state`);
}

async function runTurn(sessionId, prompt) {
  const submittedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("pool"), "off");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Worker-pool live turn timed out")),
    10 * 60_000,
  );
  const text = [];
  let terminal;
  const observeEvent = (event) => {
    if (event.turnId !== accepted.turnId) return;
    if (event.type === "assistant.text.delta") text.push(event.payload.text);
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      terminal = event;
      controller.abort();
    }
  };
  try {
    await streamSessionEvents({
      sessionId,
      signal: controller.signal,
      authorizationToken,
      fetchImplementation: fetchFromProduction,
      retryDelayMs: 100,
      onStatus() {},
      onSnapshot(snapshot) {
        const restored = snapshotTurn(snapshot, accepted.turnId);
        text.splice(0, text.length, ...(restored?.text ? [restored.text] : []));
        if (restored?.terminal) {
          terminal = restored.terminal;
          controller.abort();
        }
      },
      onEvent: observeEvent,
    });
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    await waitForRun(accepted.runId);
    const usage = await runUsageEvidence(accepted.runId);
    assert(usage.requests > 0);
    assert(usage.inputTokens > 0);
    assert(usage.outputTokens > 0);
    return {
      ...accepted,
      text: text.join(""),
      usage,
      settledMs: Math.round(performance.now() - submittedAt),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function runEvidence(runId) {
  const row = await psql(
    `select s.supervisor_id
       from runs r
       join sandboxes s on s.id = r.sandbox_id
      where r.id = ${sqlLiteral(runId)}`,
  );
  const supervisorId = row;
  assert(supervisorId, `Run ${runId} has no Supervisor assignment`);
  return { supervisorId };
}

async function activeWorkers() {
  const output = await psql(
    `select distinct supervisor_id || '|' || boot_id::text || '|' || accepting_assignments::text
       from supervisor_connections
      where state = 'active'
        and expires_at > now()
      order by 1`,
  );
  const connected =
    output.length === 0
      ? []
      : output.split("\n").map((row) => {
          const [supervisorId, bootId, acceptingAssignments] = row.split("|");
          assert.equal(
            acceptingAssignments,
            "false",
            `${supervisorId} still exposes the superseded WebSocket matcher`,
          );
          return { supervisorId, workerIdentity: `${supervisorId}/${bootId}` };
        });
  return connected.map(({ supervisorId }) => supervisorId);
}

async function waitForWorkers(expectedCount) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const workers = await activeWorkers();
    if (workers.length === expectedCount) return workers;
    await wait(250);
  }
  throw new Error(`Worker pool did not converge to ${String(expectedCount)} active Workers`);
}

async function stopWorker(supervisorId) {
  assert.equal(
    supervisorId,
    kubernetesScaleDownWorker,
    "The selected Kubernetes failover owner must be StatefulSet ordinal 1",
  );
  await capture("/usr/local/bin/k3s", [
    "kubectl",
    "--kubeconfig",
    kubernetesKubeconfig,
    "--namespace",
    kubernetesNamespace,
    "scale",
    "statefulset",
    kubernetesStatefulSet,
    "--replicas=1",
  ]);
  return { mode: "kubernetes" };
}

async function killWorker(supervisorId) {
  assert.equal(
    Number(
      await psql(`select count(*) from runs where tenant_id <> ${sqlLiteral(registration.tenantId)}
    and state not in ('completed','failed','cancelled','timed_out','superseded')`),
    ),
    0,
    "Refusing Worker fault injection while another tenant has unfinished work",
  );

  const kubectlArgs = ["--kubeconfig", kubernetesKubeconfig, "--namespace", kubernetesNamespace];
  const readState = async () => {
    const pod = JSON.parse(
      await capture("/usr/local/bin/k3s", [
        "kubectl",
        ...kubectlArgs,
        "get",
        "pod",
        supervisorId,
        "--output",
        "json",
      ]),
    );
    return pod.status.containerStatuses.find((container) => container.name === "pi-worker");
  };
  const before = await readState();
  // Kill the actual Node Agent Runner, not PID 1 (the tsx launcher). Kubernetes
  // restarts this container automatically; scaling it down would test SIGTERM.
  const killScript = `const fs=require('node:fs');const pids=fs.readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p)&&p!=='1').filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes('/app/packages/supervisor-host/src/main.ts')}catch(e){if(e.code==='ENOENT')return false;throw e}});if(pids.length!==1)throw Error('Expected one Agent Runner');process.kill(Number(pids[0]),'SIGKILL')`;
  let injectionError;
  try {
    await capture("/usr/local/bin/k3s", [
      "kubectl",
      ...kubectlArgs,
      "exec",
      supervisorId,
      "--",
      "node",
      "-e",
      killScript,
    ]);
  } catch (error) {
    // The exec channel can close with the container. Require independent
    // kubelet termination evidence before accepting this as a successful kill.
    injectionError = error;
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await readState();
    const terminated = state.lastState?.terminated;
    if (state.restartCount > before.restartCount && terminated && terminated.exitCode !== 0) {
      return {
        mode: "kubernetes-crash",
        supervisorId,
        exitCode: terminated.exitCode,
        restartCount: state.restartCount,
      };
    }
    await wait(250);
  }
  throw new Error("Kubelet did not confirm an abnormal Worker process exit", {
    cause: injectionError,
  });
}

async function crashStreamingTurn(sessionId) {
  const marker = `PI-WORKER-CRASH-${suffix.toUpperCase()}`;
  const accepted = await api.acceptTurn(
    sessionId,
    [
      "Do not call tools.",
      `Start with this exact marker: ${marker}.`,
      "Then write eighty numbered Chinese sentences about distributed recovery.",
      "Each sentence must contain at least fifteen Chinese characters.",
    ].join(" "),
    newIdempotencyKey("worker-crash"),
    "off",
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Worker crash stream timed out")),
    10 * 60_000,
  );
  let crash;
  let terminal;
  let canonicalTerminalSeen = false;
  let firstVisibleSequence;
  const visibleText = [];
  const observeEvent = (event) => {
    if (event.turnId !== accepted.turnId) return;
    if (event.type === "assistant.text.delta") {
      visibleText.push(event.payload.text);
      if (crash === undefined) {
        firstVisibleSequence = event.seq;
        crash = runEvidence(accepted.runId).then(async (evidence) => {
          stoppedWorker = await killWorker(evidence.supervisorId);
          return { evidence, stopped: stoppedWorker };
        });
      }
    }
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      terminal = event;
      controller.abort();
    }
  };
  try {
    await streamSessionEvents({
      sessionId,
      signal: controller.signal,
      authorizationToken,
      fetchImplementation: fetchFromProduction,
      retryDelayMs: 100,
      onStatus() {},
      onSnapshot(snapshot) {
        const restored = snapshotTurn(snapshot, accepted.turnId);
        visibleText.splice(0, visibleText.length, ...(restored?.text ? [restored.text] : []));
        if (restored?.text && !restored.terminal && crash === undefined) {
          firstVisibleSequence = restored.throughSequence;
          crash = runEvidence(accepted.runId).then(async (evidence) => {
            stoppedWorker = await killWorker(evidence.supervisorId);
            return { evidence, stopped: stoppedWorker };
          });
        }
        const turn = snapshot.conversation.turns.find(
          (candidate) => candidate.turnId === accepted.turnId,
        );
        if (turn !== undefined && ["completed", "failed", "cancelled"].includes(turn.state)) {
          canonicalTerminalSeen = true;
          controller.abort();
        }
      },
      onEvent: observeEvent,
    });
    assert(crash, "The Worker crash workload did not produce an Accepted text event");
    const killed = await crash;
    stoppedWorker = killed.stopped;
    assert(firstVisibleSequence, "The Worker crash workload had no visible sequence");
    if (terminal === undefined && canonicalTerminalSeen) {
      const stored = await psql(
        `select type || '|' || seq::text
           from session_terminal_events
          where tenant_id = ${sqlLiteral(registration.tenantId)}
            and session_id = ${sqlLiteral(sessionId)}
            and turn_id = ${sqlLiteral(accepted.turnId)}`,
      );
      const [type, sequence] = stored.split("|");
      assert(type && sequence, "Canonical Worker-loss terminal evidence was unavailable");
      terminal = { type, seq: Number(sequence) };
    }
    assert(terminal, "Worker loss did not produce a terminal event");
    assert.equal(
      terminal.type,
      "turn.completed",
      "Native recovery did not complete the original input",
    );
    const run = await waitForTerminalRun(accepted.runId);
    assert.equal(run.state, "completed");
    assert(
      visibleText.join("").includes(marker),
      "The Accepted prefix before Worker loss omitted its marker",
    );
    return {
      ...accepted,
      marker,
      terminal,
      firstVisibleSequence,
      visibleText: visibleText.join(""),
      killed,
      run,
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function restoreWorker(stoppedWorker) {
  if (stoppedWorker.mode === "kubernetes") {
    await capture("/usr/local/bin/k3s", [
      "kubectl",
      "--kubeconfig",
      kubernetesKubeconfig,
      "--namespace",
      kubernetesNamespace,
      "scale",
      "statefulset",
      kubernetesStatefulSet,
      "--replicas=2",
    ]);
  }
  await waitForWorkers(2);
}

function sumUsage(results) {
  return results.reduce(
    (total, result) => ({
      requests: total.requests + result.usage.requests,
      inputTokens: total.inputTokens + result.usage.inputTokens,
      outputTokens: total.outputTokens + result.usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + result.usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + result.usage.cacheWriteTokens,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

const initialWorkers = await waitForWorkers(2);
const workerImages = (await localWorkerTargets()).map(({ name, image }) => ({ name, image }));
const testRevision = await capture("git", ["rev-parse", "HEAD"]);
const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const registration = await new PiCloudApi(fetchFromProduction).registerTenant(
  `worker-pool-${suffix}`.replaceAll(/[^a-z0-9-]/gu, "-").slice(0, 63),
  "Pi Worker pool acceptance",
);
api = new PiCloudApi(fetchFromProduction, registration.apiToken);
authorizationToken = registration.apiToken;
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must have a real model configured");
const acceptanceModel = {
  provider: "openai-codex",
  modelId: "gpt-6-luna",
  thinkingLevel: "off",
  fastMode: false,
};

let stoppedWorker;
const createdSessionIds = [];
const createdWorkspaceIds = [];
let cleanupAttempted = false;
let primaryFailure;
async function cleanup() {
  cleanupAttempted = true;
  const errors = [];
  if (stoppedWorker !== undefined) {
    try {
      await restoreWorker(stoppedWorker);
      stoppedWorker = undefined;
    } catch (error) {
      errors.push(error);
    }
  }
  for (const sessionId of createdSessionIds) {
    try {
      const active = (turn) => ["queued", "running", "cancelling"].includes(turn.state);
      for (const turn of (await api.getConversation(sessionId)).turns.filter(active))
        if (turn.state !== "cancelling")
          await api.cancelTurn(sessionId, turn.turnId, newIdempotencyKey("cancel"));
      const deadline = performance.now() + 120000;
      while ((await api.getConversation(sessionId)).turns.some(active)) {
        if (performance.now() > deadline) throw new Error("Worker fixture did not retire");
        await wait(200);
      }
      await api.deleteConversation(sessionId);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const workspaceId of createdWorkspaceIds) {
    try {
      await api.deleteWorkspace(workspaceId, newIdempotencyKey("delete"));
    } catch (error) {
      errors.push(error);
    }
  }
  const credentialId = registration.apiToken.slice(4, registration.apiToken.indexOf("."));
  try {
    await psql(`update tenant_api_credentials set revoked_at=clock_timestamp()
    where tenant_id=${sqlLiteral(registration.tenantId)} and credential_id=${sqlLiteral(credentialId)}`);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, "Worker pool acceptance cleanup failed", { cause: errors[0] });
}

try {
  const candidates = [];
  const maximumCandidates = 8;
  let selected;
  for (let index = 0; index < maximumCandidates && selected === undefined; index += 1) {
    const marker = `PI-POOL-${suffix.toUpperCase()}-${String(index + 1)}`;
    const project = await api.createProject(`Pi Worker pool acceptance ${suffix}-${index + 1}`);
    createdWorkspaceIds.push(project.workspaceId);
    const session = await api.createSession(
      project.projectId,
      project.workspaceId,
      `Pi Worker pool acceptance ${suffix}-${index + 1}`,
    );
    createdSessionIds.push(session.sessionId);
    await api.updateSessionModel(session.sessionId, acceptanceModel);
    const turn = await runTurn(
      session.sessionId,
      `Remember this marker for my next message: ${marker}. Do not call tools. Reply exactly ACK.`,
    );
    const candidate = {
      marker,
      session,
      turn,
      evidence: await runEvidence(turn.runId),
    };
    candidates.push(candidate);
    if (candidate.evidence.supervisorId === kubernetesScaleDownWorker) {
      selected = candidate;
    }
  }
  assert(selected, "No first-turn candidate ran on the removable Kubernetes Worker");
  const { marker, session, turn: first, evidence: firstEvidence } = selected;
  stoppedWorker = await stopWorker(firstEvidence.supervisorId);
  const survivingWorkers = await waitForWorkers(1);
  assert(!survivingWorkers.includes(firstEvidence.supervisorId));

  const followUp = await runTurn(
    session.sessionId,
    "What exact marker did I ask you to remember in my previous message? Do not call tools. Reply with only that marker.",
  );
  const followUpEvidence = await runEvidence(followUp.runId);
  assert.notEqual(followUpEvidence.supervisorId, firstEvidence.supervisorId);
  assert(followUp.text.includes(marker), `Restored conversation omitted marker: ${followUp.text}`);
  await restoreWorker(stoppedWorker);
  stoppedWorker = undefined;

  const crashProject = await api.createProject(`Pi Worker crash ${suffix}`);
  createdWorkspaceIds.push(crashProject.workspaceId);
  const crashSession = await api.createSession(
    crashProject.projectId,
    crashProject.workspaceId,
    `Pi Worker crash ${suffix}`,
  );
  createdSessionIds.push(crashSession.sessionId);
  await api.updateSessionModel(crashSession.sessionId, acceptanceModel);
  const crashed = await crashStreamingTurn(crashSession.sessionId);
  {
    await waitForWorkers(2);
  }
  const recovered = await runTurn(
    crashSession.sessionId,
    "The previous Run recovered. Do not call tools. Reply exactly RECOVERY-BARRIER-OK.",
  );
  assert(recovered.text.includes("RECOVERY-BARRIER-OK"));
  const recoveredAdmissions = Number(
    await psql(
      `select count(*) from run_transitions where run_id=${sqlLiteral(crashed.runId)} and reason='native_execution_recovery'`,
    ),
  );
  assert(recoveredAdmissions >= 1, "No native recovery admission followed ordered owner closure");
  const inputCount = Number(
    await psql(`select count(*) from pi_durable_records input
    where input.kind='submission' and input.session_id=${sqlLiteral(crashSession.sessionId)}
      and input.fields->>'request'=${sqlLiteral(JSON.stringify(crashed.runId))}`),
  );
  assert.equal(inputCount, 1, "Worker replacement duplicated the accepted native input");
  await restoreWorker(stoppedWorker);
  stoppedWorker = undefined;

  const concurrentResults = await Promise.allSettled(
    Array.from({ length: 4 }, async (_, index) => {
      const concurrentProject = await api.createProject(`Pi pool lane ${index + 1} ${suffix}`);
      createdWorkspaceIds.push(concurrentProject.workspaceId);
      const concurrentSession = await api.createSession(
        concurrentProject.projectId,
        concurrentProject.workspaceId,
        `Pi pool lane ${index + 1} ${suffix}`,
      );
      createdSessionIds.push(concurrentSession.sessionId);
      await api.updateSessionModel(concurrentSession.sessionId, acceptanceModel);
      const turn = await runTurn(
        concurrentSession.sessionId,
        [
          "Do not call any tool.",
          `Begin with POOL-LANE-${String(index + 1)}.`,
          "Then explain horizontal worker pools in twelve concise numbered lines.",
          "Use one complete sentence per line.",
        ].join(" "),
      );
      return { turn, evidence: await runEvidence(turn.runId) };
    }),
  );
  const concurrent = concurrentResults.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  const concurrentWorkerIds = [...new Set(concurrent.map(({ evidence }) => evidence.supervisorId))];
  assert(
    concurrentWorkerIds.every((workerId) => initialWorkers.includes(workerId)),
    "A concurrent Run was assigned outside the active Worker pool",
  );
  const observedWorkerIds = [
    ...new Set([
      ...candidates.map(({ evidence }) => evidence.supervisorId),
      followUpEvidence.supervisorId,
      ...concurrentWorkerIds,
    ]),
  ].sort();
  assert.deepEqual(observedWorkerIds, [...initialWorkers].sort());

  const allTurns = [
    ...candidates.map(({ turn }) => turn),
    followUp,
    recovered,
    ...concurrent.map(({ turn }) => turn),
  ];
  const totalUsage = sumUsage(allTurns);
  const report = {
    accepted: true,
    testRevision,
    workerImages,
    checkedAt: new Date().toISOString(),
    model: acceptanceModel,
    workerDeployment,
    workers: initialWorkers,
    failover: {
      firstWorker: firstEvidence.supervisorId,
      followUpWorker: followUpEvidence.supervisorId,
      differentWorker: firstEvidence.supervisorId !== followUpEvidence.supervisorId,
      postgresSessionRestored: followUp.text.includes(marker),
      markerRecovered: followUp.text.includes(marker),
      firstSettledMs: first.settledMs,
      followUpSettledMs: followUp.settledMs,
      candidateRuns: candidates.length,
    },
    activeCrashRecovery: {
      injection: crashed.killed.stopped,
      killedWorker: crashed.killed.evidence.supervisorId,
      terminalState: crashed.run.state,
      firstVisibleSequence: crashed.firstVisibleSequence,
      terminalSequence: crashed.terminal.seq,
      recoveredAdmissions,
      sameLogicalRun: true,
      originalInputCount: inputCount,
      recoveredRunId: crashed.runId,
      followUpRunId: recovered.runId,
    },
    concurrency: {
      runs: concurrent.length,
      workerIds: concurrent.map(({ evidence }) => evidence.supervisorId),
      distinctWorkers: concurrentWorkerIds.length,
      observedWorkerIds,
      settledMs: concurrent.map(({ turn }) => turn.settledMs),
    },
    totalUsage,
  };
  assert(totalUsage.requests >= 6 && totalUsage.inputTokens > 0 && totalUsage.outputTokens > 0);
  await cleanup();
  report.cleanupCompleted = true;

  const reportDirectory = resolve(repositoryRoot, "docs/reports");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "pi-worker-pool-acceptance-latest.json"),
    await format(JSON.stringify(report), {
      ...(await resolveConfig(import.meta.filename)),
      parser: "json",
    }),
    "utf8",
  );
  await writeFile(
    resolve(reportDirectory, "pi-worker-pool-acceptance-latest.md"),
    [
      "# Pi Worker pool production acceptance",
      "",
      `- Checked at: ${report.checkedAt}`,
      `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
      `- Worker deployment: ${report.workerDeployment}`,
      `- Active Workers: ${report.workers.join(", ")}`,
      `- Cross-Worker restore: ${report.failover.firstWorker} -> ${report.failover.followUpWorker}`,
      `- PostgreSQL Pi Session restored: ${String(report.failover.postgresSessionRestored)}`,
      `- Previous-turn marker recovered: ${String(report.failover.markerRecovered)}`,
      `- Active Worker crash terminal state: ${report.activeCrashRecovery.terminalState}`,
      `- Original input retained across native recovery: ${String(report.activeCrashRecovery.originalInputCount)}`,
      `- Native recoveries after ordered closure: ${String(report.activeCrashRecovery.recoveredAdmissions)}`,
      `- Concurrent Runs / distinct Workers: ${String(report.concurrency.runs)} / ${String(report.concurrency.distinctWorkers)}`,
      `- Concurrent assignment: ${report.concurrency.workerIds.join(", ")}`,
      `- Real requests/input/output tokens: ${String(report.totalUsage.requests)} / ${String(report.totalUsage.inputTokens)} / ${String(report.totalUsage.outputTokens)}`,
      "",
      "The owning Pi Worker was stopped after the first real-model Turn. The surviving Worker rebuilt Pi's active model context directly from PostgreSQL Durable Storage, recovered the previous-turn marker and appended the follow-up incrementally. Further concurrent real-model Runs completed through the independently ready Worker pool; allocation is reported as evidence rather than assumed to be round-robin.",
      "",
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  if (!cleanupAttempted) {
    try {
      await cleanup();
    } catch (error) {
      throw new AggregateError(
        [primaryFailure, error].filter(Boolean),
        "Worker acceptance or cleanup failed",
        { cause: primaryFailure ?? error },
      );
    }
  }
}
