import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readPrivateRuntimeFile as readPrivate } from "./lib/runtime-file-policy.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { snapshotTurn } from "./lib/session-snapshot.mjs";
import { ACCEPTED_FACT_TOPIC } from "../packages/event-log/src/index.ts";
import { localWorkerProcesses } from "./lib/live-run-timing.mjs";

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

let recordsProducedWhileProjectorDown = 0;
async function replaceControlPlane() {
  if (faultMode === "kafka-broker") {
    await executeCompose(["kill", "--signal", "SIGKILL", "kafka-1"]);
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    } finally {
      await executeCompose(["start", "--wait", "kafka-1"]);
    }
    return;
  }
  const workers = await localWorkerProcesses();
  assert(workers.length > 0, "No live Worker for the fault probe");
  const boots = (processes) => processes.map(({ name, identity }) => ({ name, identity }));
  const beforeBoots = boots(workers);
  const logHead = () =>
    Number(
      execFileSync(
        workers[0].binary,
        [
          ...workers[0].execArgs,
          "node",
          "--input-type=module",
          "-e",
          `const n=await import('@confluentinc/kafka-javascript');const a=new n.default.KafkaJS.Kafka({kafkaJS:{brokers:['kafka-1:9092'],clientId:'projector-outage-check',logLevel:0}}).admin();await a.connect();const o=await a.fetchTopicOffsets(${JSON.stringify(ACCEPTED_FACT_TOPIC)});console.log(o.reduce((n,p)=>n+Number(p.high),0));await a.disconnect();`,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
  await executeCompose(["kill", "--signal", "SIGKILL", "control-plane"]);
  try {
    assert.equal(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", "pi-cloud-production-control-plane-1"],
        { encoding: "utf8" },
      ).trim(),
      "false",
      "Control Plane did not remain stopped during the outage probe",
    );
    const beforeHead = logHead();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    recordsProducedWhileProjectorDown = logHead() - beforeHead;
  } finally {
    // Restart the existing image/configuration; a fault test is not a deployment.
    await executeCompose(["start", "--wait", "control-plane"]);
  }
  assert.deepEqual(
    boots(await localWorkerProcesses()),
    beforeBoots,
    "Projector failure test restarted a Worker",
  );
  assert(recordsProducedWhileProjectorDown > 0, "Worker did not append during Projector outage");
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
const testProvider = process.env.PI_CLOUD_LIVE_FAULT_PROVIDER ?? "deepseek";
assert(["deepseek", "openai-codex"].includes(testProvider), "Unsupported fault-test Provider");
const selection =
  testProvider === "deepseek"
    ? {
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        thinkingLevel: "off",
        fastMode: false,
      }
    : { provider: "openai-codex", modelId: "gpt-5.6-luna", thinkingLevel: "low", fastMode: false };
const startedAt = performance.now();
let project, session, accepted, primaryFailure;
let cleanupCompleted = false;
async function cleanup() {
  const errors = [];
  if (session) {
    try {
      const active = (turn) => ["queued", "running", "cancelling"].includes(turn.state);
      for (const turn of (await api.getConversation(session.sessionId)).turns.filter(active))
        await api.cancelTurn(session.sessionId, turn.turnId, newIdempotencyKey("cleanup-cancel"));
      const deadline = Date.now() + 90_000;
      while ((await api.getConversation(session.sessionId)).turns.some(active)) {
        if (Date.now() > deadline) throw new Error("Fault fixture Run did not retire");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await api.deleteConversation(session.sessionId, newIdempotencyKey("cleanup-conversation"));
    } catch (error) {
      errors.push(error);
    }
  }
  if (project) {
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup-workspace"));
    } catch (error) {
      errors.push(error);
    }
  }
  cleanupCompleted = true;
  if (errors.length)
    throw new AggregateError(errors, "Fault fixture cleanup failed", { cause: errors[0] });
}

const controller = new AbortController();
const deadline = setTimeout(
  () => controller.abort(new Error("Control Plane restart acceptance timed out")),
  10 * 60_000,
);
let replacement;
function startReplacement() {
  replacement = replaceControlPlane();
  void replacement.catch((error) => controller.abort(error));
}
let firstTextSequence;
let visiblePrefixBeforeFailure;
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
      visiblePrefixBeforeFailure = text.join("");
      startReplacement();
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
  project = await api.createProject(`Control Plane restart ${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Control Plane restart continuity",
    "elastic",
    "starter",
    "/workspace",
    selection,
  );
  accepted = await api.acceptTurn(
    session.sessionId,
    [
      "Do not call tools.",
      `Start with this exact marker: ${marker}.`,
      "Then write one hundred and twenty numbered Chinese sentences about durable cloud agent execution.",
      "Each sentence must contain at least fifteen Chinese characters so the response remains streaming while infrastructure restarts.",
    ].join(" "),
    newIdempotencyKey("control-plane-restart"),
  );
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
      const partial = snapshotTurn(snapshot, accepted.turnId);
      text.splice(0, text.length, ...(partial?.text ? [partial.text] : []));
      if (partial?.text && !partial.terminal && replacement === undefined) {
        firstTextSequence = partial.throughSequence;
        visiblePrefixBeforeFailure = partial.text;
        startReplacement();
      }
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
  assert(
    replacement,
    `The model did not stream before fault injection: ${JSON.stringify(terminal?.payload)}`,
  );
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
  const conversation = await api.getConversation(session.sessionId);
  const canonical = conversation.turns.find((turn) => turn.turnId === accepted.turnId)?.transcript;
  assert(canonical, "Completed Run has no canonical transcript");
  const canonicalText = canonical.items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join("");
  assert(
    visiblePrefixBeforeFailure && canonicalText.startsWith(visiblePrefixBeforeFailure),
    "Recovery changed an already displayed text prefix",
  );
  assert.equal(
    text.join(""),
    canonicalText,
    "Reconnected live view differs from canonical history",
  );

  const report = {
    accepted: true,
    piCloudRevision: testedRevision,
    checkedAt: new Date().toISOString(),
    provider: selection.provider,
    modelId: selection.modelId,
    runId: accepted.runId,
    turnId: accepted.turnId,
    firstTextSequence,
    terminalSequence,
    sseReconnects: reconnects,
    attemptCount: run.attempts.length,
    faultMode,
    recordsProducedWhileProjectorDown,
    visiblePrefixPreserved: true,
    liveMatchesCanonical: true,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
  await cleanup();
  report.cleanupCompleted = true;
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
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  clearTimeout(deadline);
  controller.abort();
  const failures = [];
  if (replacement) {
    try {
      await replacement;
    } catch (error) {
      if (error !== primaryFailure) failures.push(error);
    }
  }
  if (!cleanupCompleted) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      [...(primaryFailure ? [primaryFailure] : []), ...failures],
      "Fault acceptance or cleanup failed",
      { cause: primaryFailure ?? failures[0] },
    );
}
