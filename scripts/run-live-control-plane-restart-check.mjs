import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const faultMode =
  process.env.PI_CLOUD_LIVE_KAFKA_BROKER_RESTART_CHECK === "1" ? "kafka-broker" : "control-plane";
if (process.env.PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK !== "1" && faultMode !== "kafka-broker") {
  throw new Error(
    "Set PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK=1 to acknowledge a real model call and controlled Control Plane SIGKILL",
  );
}
const writeReport =
  (faultMode === "kafka-broker"
    ? process.env.PI_CLOUD_LIVE_KAFKA_BROKER_RESTART_REPORT
    : process.env.PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_REPORT) !== "0";

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
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);

function executeCompose(args, timeoutMs = 180_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      ["scripts/production-compose.mjs", ...args],
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
            new Error(`Infrastructure replacement failed: ${stderr.trim() || error.message}`),
          );
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
  });
}

async function replaceControlPlane() {
  if (faultMode === "kafka-broker") {
    await executeCompose(["kill", "--signal", "SIGKILL", "kafka-1"]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    await executeCompose(["up", "--detach", "--wait", "kafka-1"]);
    return;
  }
  await executeCompose(["kill", "--signal", "SIGKILL", "control-plane"]);
  await executeCompose(["up", "--detach", "--wait", "control-plane"]);
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
  throw new Error("Run did not settle after Control Plane replacement");
}

const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
const marker = `CONTROL-PLANE-RESTART-${suffix.toUpperCase()}`;
const registrationResponse = await fetch(new URL("/v1/registrations", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    tenantSlug: `control-plane-restart-${suffix}`,
    displayName: "Control Plane restart acceptance",
  }),
});
const registration = await registrationResponse.json();
if (
  registrationResponse.status !== 201 ||
  typeof registration.apiToken !== "string" ||
  typeof registration.tenantId !== "string"
) {
  throw new Error(`Registration failed with HTTP ${String(registrationResponse.status)}`);
}

const api = new PiCloudApi(fetchFromProduction, registration.apiToken);
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production restart check requires a real model");
const project = await api.createProject(`Control Plane restart ${suffix}`);
const session = await api.createSession(
  project.projectId,
  project.workspaceId,
  "Control Plane restart continuity",
);
const startedAt = performance.now();
const accepted = await api.acceptTurn(
  session.sessionId,
  [
    "Do not call tools.",
    `Start with this exact marker: ${marker}.`,
    "Then write forty numbered Chinese sentences about durable cloud agent execution.",
    "Each sentence must contain at least fifteen Chinese characters so the response remains streaming while infrastructure restarts.",
  ].join(" "),
  newIdempotencyKey("control-plane-restart"),
  "off",
);

const controller = new AbortController();
const deadline = setTimeout(
  () => controller.abort(new Error("Control Plane restart acceptance timed out")),
  10 * 60_000,
);
let replacement;
let firstTextSequence;
let terminal;
let snapshotTerminalSequence;
let reconnects = 0;
const text = [];
const observeEvent = (event) => {
  if (event.turnId !== accepted.turnId) return;
  if (event.type === "assistant.text.delta") {
    text.push(event.payload.text);
    if (replacement === undefined) {
      firstTextSequence = event.seq;
      replacement = replaceControlPlane();
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
    sessionId: session.sessionId,
    signal: controller.signal,
    authorizationToken: registration.apiToken,
    fetchImplementation: fetchFromProduction,
    retryDelayMs: 100,
    onStatus(status) {
      if (status.phase === "reconnecting") reconnects += 1;
    },
    onSnapshot(snapshot) {
      for (const event of snapshot.liveEvents) observeEvent(event);
      const recovered = snapshot.conversation.turns.find(
        (turn) => turn.turnId === accepted.turnId && turn.state === "completed",
      );
      if (recovered?.transcript !== undefined) {
        snapshotTerminalSequence = recovered.transcript.terminalSequence ?? undefined;
        text.splice(
          0,
          text.length,
          ...recovered.transcript.items
            .filter((item) => item.kind === "text")
            .map((item) => item.text),
        );
        controller.abort();
      }
    },
    onEvent: observeEvent,
  });
  assert(replacement, "The model did not stream before Control Plane replacement");
  await replacement;
  assert(
    terminal?.type === "turn.completed" || snapshotTerminalSequence !== undefined,
    "The replacement Gateway exposed neither a live terminal nor its canonical snapshot",
  );
  const terminalSequence = terminal?.seq ?? snapshotTerminalSequence;
  assert(
    firstTextSequence && terminalSequence && firstTextSequence < terminalSequence,
    "SSE did not advance after replacement",
  );
  assert(text.join("").includes(marker), "Replayed output omitted the expected marker");
  const run = await waitForCompletedRun(api, accepted.runId);
  assert.equal(run.attempts.length, 1, "Control Plane replacement created another Run Attempt");

  const report = {
    accepted: true,
    piCloudRevision: testedRevision,
    checkedAt: new Date().toISOString(),
    provider: model.provider,
    modelId: model.modelId,
    runId: accepted.runId,
    turnId: accepted.turnId,
    firstTextSequence,
    terminalSequence,
    sseReconnects: reconnects,
    attemptCount: run.attempts.length,
    faultMode,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
  if (writeReport) {
    const reportDirectory = resolve(repositoryRoot, "docs/reports");
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      resolve(
        reportDirectory,
        faultMode === "kafka-broker"
          ? "kafka-broker-restart-acceptance-latest.json"
          : "control-plane-restart-acceptance-latest.json",
      ),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      resolve(
        reportDirectory,
        faultMode === "kafka-broker"
          ? "kafka-broker-restart-acceptance-latest.md"
          : "control-plane-restart-acceptance-latest.md",
      ),
      [
        `# ${faultMode === "kafka-broker" ? "Kafka broker" : "Control Plane"} restart acceptance`,
        "",
        `- Checked at: ${report.checkedAt}`,
        `- Provider/model: ${report.provider} / ${report.modelId}`,
        `- First visible / terminal sequence: ${String(report.firstTextSequence)} / ${String(report.terminalSequence)}`,
        `- SSE reconnects: ${String(report.sseReconnects)}`,
        `- Run Attempts: ${String(report.attemptCount)}`,
        `- Elapsed: ${String(report.elapsedMs)} ms`,
        "",
        faultMode === "kafka-broker"
          ? "One Kafka broker received SIGKILL after the first acknowledged assistant delta. The remaining ISR preserved AcceptedFact durability, clients recovered, the broker rejoined, and the Run completed with one Attempt."
          : "The Control Plane container received SIGKILL after the first Kafka-acknowledged assistant delta. The trusted Worker continued the fenced Run while Kafka retained the AcceptedFact stream and PostgreSQL retained canonical Pi state. The replacement Gateway rebuilt the Session snapshot, SSE reconnected, and the Run completed with one Attempt.",
        "",
      ].join("\n"),
    );
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  clearTimeout(deadline);
  controller.abort();
  await replacement?.catch(() => undefined);
  await api
    .deleteConversation(session.sessionId, newIdempotencyKey("cleanup-conversation"))
    .catch(() => undefined);
  await api
    .deleteWorkspace(session.workspaceId, newIdempotencyKey("cleanup-workspace"))
    .catch(() => undefined);
}
