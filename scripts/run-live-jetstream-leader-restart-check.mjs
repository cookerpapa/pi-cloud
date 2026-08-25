import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (process.env.PI_CLOUD_LIVE_JETSTREAM_RESTART_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_JETSTREAM_RESTART_CHECK=1 to acknowledge a real model call and controlled JetStream Leader loss",
  );
}

async function readPrivate(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > maximumBytes) {
      throw new Error(`${label} is not a private bounded file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environment = Object.fromEntries(
  (await readPrivate(resolve(runtimeDirectory, ".env"), 64 * 1_024, "Production environment"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const host = ["0.0.0.0", "::"].includes(environment.PI_CLOUD_HTTP_BIND_ADDRESS)
  ? "127.0.0.1"
  : environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const baseUrl = new URL(`http://${host}:${environment.PI_CLOUD_HTTP_PORT}`);
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);

function compose(args, timeoutMs = 180_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      ["scripts/production-compose.mjs", ...args],
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 4 * 1_024 * 1_024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(stderr.trim() || error.message));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

async function agentEventStream(service = "nats-1") {
  const output = await compose([
    "exec",
    "-T",
    service,
    "wget",
    "-q",
    "-O",
    "-",
    "http://127.0.0.1:8222/jsz?streams=true",
  ]);
  const details = JSON.parse(output).account_details?.[0]?.stream_detail ?? [];
  const stream = details.find((candidate) => candidate.name === "PI_CLOUD_AGENT_EVENTS");
  if (stream === undefined) throw new Error("Agent event Stream is unavailable");
  return stream;
}

async function agentEventLeader() {
  const leader = (await agentEventStream()).cluster?.leader;
  if (!/^nats-[123]$/u.test(leader ?? "")) throw new Error("Agent event Stream Leader is invalid");
  return leader;
}

async function replaceLeader() {
  const previous = await agentEventLeader();
  await compose(["kill", "--signal", "SIGKILL", previous]);
  await compose(["up", "--detach", "--wait", previous]);
  const deadline = Date.now() + 60_000;
  let replacement;
  while (Date.now() < deadline) {
    replacement = await agentEventLeader().catch(() => undefined);
    if (replacement !== undefined && replacement !== previous) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  if (replacement === undefined || replacement === previous) {
    throw new Error("JetStream did not elect a replacement Leader");
  }
  const recovered = await (async () => {
    while (Date.now() < deadline) {
      const stream = await agentEventStream(replacement).catch(() => undefined);
      const replicas = stream?.cluster?.replicas ?? [];
      if (
        stream?.cluster?.leader === replacement &&
        replicas.length === 2 &&
        replicas.every((replica) => replica.current)
      ) {
        return replicas;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    throw new Error("JetStream did not restore all R=3 Agent-event replicas");
  })();
  return { previous, replacement, recoveredReplicas: recovered.length };
}

async function waitForCompletedRun(api, runId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try {
      const run = await api.getRun(runId);
      if (run.state === "completed") return run;
      if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
        throw new Error(`Run ended as ${run.state}: ${JSON.stringify(run.failure ?? {})}`);
      }
    } catch (error) {
      if (!(error instanceof PiCloudApiError) || error.status !== 0) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error("Run did not settle after JetStream Leader loss");
}

const suffix = Date.now().toString(36);
const marker = `JETSTREAM-LEADER-${suffix.toUpperCase()}`;
const registrationResponse = await fetch(new URL("/v1/registrations", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    tenantSlug: `jetstream-leader-${suffix}`,
    displayName: "JetStream Leader acceptance",
  }),
});
const registration = await registrationResponse.json();
if (registrationResponse.status !== 201 || typeof registration.apiToken !== "string") {
  throw new Error(`Registration failed with HTTP ${String(registrationResponse.status)}`);
}
const api = new PiCloudApi(fetchFromProduction, registration.apiToken);
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real");
const project = await api.createProject(`JetStream Leader ${suffix}`);
const session = await api.createSession(
  project.projectId,
  project.workspaceId,
  "Leader continuity",
);
const accepted = await api.acceptTurn(
  session.sessionId,
  [
    "Do not call tools.",
    `Start with this exact marker: ${marker}.`,
    "Then write forty numbered Chinese sentences about durable cloud agent execution.",
  ].join(" "),
  newIdempotencyKey("jetstream-leader"),
  "off",
);
const startedAt = performance.now();
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 10 * 60_000);
let replacement;
let firstTextSequence;
let terminal;
let reconnects = 0;
const text = [];
try {
  const cursor = await streamSessionEvents({
    sessionId: session.sessionId,
    afterSequence: 0,
    signal: controller.signal,
    authorizationToken: registration.apiToken,
    fetchImplementation: fetchFromProduction,
    retryDelayMs: 100,
    onStatus(status) {
      if (status.phase === "reconnecting") reconnects += 1;
    },
    onEvent(event) {
      if (event.turnId !== accepted.turnId) return;
      if (event.type === "assistant.text.delta") {
        text.push(event.payload.text);
        if (replacement === undefined) {
          firstTextSequence = event.seq;
          replacement = replaceLeader();
        }
      }
      if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
        terminal = event;
        controller.abort();
      }
    },
  });
  const leaders = await replacement;
  assert.equal(terminal?.type, "turn.completed", JSON.stringify(terminal?.payload));
  assert(firstTextSequence < cursor);
  assert(text.join("").includes(marker));
  const run = await waitForCompletedRun(api, accepted.runId);
  assert.equal(run.attempts.length, 1);
  const report = {
    accepted: true,
    piCloudRevision: testedRevision,
    checkedAt: new Date().toISOString(),
    provider: model.provider,
    modelId: model.modelId,
    previousLeader: leaders.previous,
    replacementLeader: leaders.replacement,
    recoveredReplicas: leaders.recoveredReplicas,
    runId: accepted.runId,
    firstTextSequence,
    terminalSequence: terminal.seq,
    sseReconnects: reconnects,
    attemptCount: run.attempts.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
  const reportDirectory = resolve(repositoryRoot, "docs/reports");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    resolve(reportDirectory, "jetstream-leader-restart-acceptance-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    resolve(reportDirectory, "jetstream-leader-restart-acceptance-latest.md"),
    `# JetStream Leader restart acceptance\n\n- Leader: ${report.previousLeader} → ${report.replacementLeader}\n- Restored followers: ${String(report.recoveredReplicas)}/2\n- First/terminal sequence: ${String(report.firstTextSequence)} / ${String(report.terminalSequence)}\n- SSE reconnects: ${String(report.sseReconnects)}\n- Run Attempts: ${String(report.attemptCount)}\n- Elapsed: ${String(report.elapsedMs)} ms\n`,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  clearTimeout(deadline);
  controller.abort();
  await replacement?.catch(() => undefined);
}
