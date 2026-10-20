import { serviceAddress, kubectl, kubectlAsync, podFor } from "./lib/production-kubernetes.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash, randomUUID, randomInt } from "node:crypto";
import sharp from "sharp";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import {
  createInitialSessionView,
  sessionViewReducer,
} from "../packages/web-ui/src/session-view.ts";
import { createDatabase } from "../packages/database/src/index.ts";
import { sql } from "kysely";
if (process.env.PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK=1 for a disposable Luna/Cube Run and control-plane replacement",
  );
const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = resolve(
  root,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const reportPath = process.argv[2] ?? "/tmp/pi-cloud-cube-handoff-restart.json";
const exec = promisify(execFile);
const port = (await readFile(runtime + "/.env", "utf8")).match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)[1];
const authorizationToken = (await readFile(runtime + "/secrets/api-token", "utf8")).trim();
const fetchImplementation = (url, init) =>
  fetch(new URL(String(url), `http://127.0.0.1:${port}`), init);
const api = new PiCloudApi(fetchImplementation, authorizationToken);
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function waitFor(fn, label, ms = 120000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await delay(300);
  }
  throw Error("Timed out: " + label);
}
let project, session, turn, error, child, streamAbort, streaming, streamFailure;
let view = createInitialSessionView(),
  observedText = "",
  lastTextAt,
  maxTextGapMs = 0,
  textEvents = 0;
const scenario = process.env.PI_CLOUD_LIVE_HANDOFF_SCENARIO ?? "cube";
assert(["cube", "child", "stream-image"].includes(scenario));
const imageCode = String(randomInt(100000, 999999));
function observeText() {
  const text =
    view.turns
      .find((item) => item.turnId === turn?.turnId)
      ?.items.filter((item) => item.kind === "text")
      .map((item) => item.text)
      .join("") ?? "";
  if (text.length > observedText.length) {
    const now = Date.now();
    if (lastTextAt !== undefined) maxTextGapMs = Math.max(maxTextGapMs, now - lastTextAt);
    lastTextAt = now;
    observedText = text;
    textEvents++;
  }
}
async function nativeQuery(query) {
  const url = new URL((await readFile(runtime + "/secrets/database-url", "utf8")).trim());
  url.hostname = serviceAddress("postgres");
  const db = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
  try {
    return (await query.execute(db)).rows;
  } finally {
    await db.destroy();
  }
}
const faultMode = process.env.PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_MODE ?? "pod";
assert(["pod", "process", "rolling"].includes(faultMode));
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  faultMode,
  scenario,
  accepted: false,
};
async function assertOnlyOwnedRun() {
  const url = new URL((await readFile(runtime + "/secrets/database-url", "utf8")).trim());
  url.hostname = serviceAddress("postgres");
  const db = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
  try {
    const { rows } =
      await sql`select id from runs where state not in ('completed','failed','cancelled','timed_out')`.execute(
        db,
      );
    assert.deepEqual(
      rows.map((r) => r.id),
      [turn.runId],
      "Refuse fault injection while another Run is active",
    );
  } finally {
    await db.destroy();
  }
}

try {
  project = await api.createProject("Cube handoff restart " + Date.now());
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Cube handoff restart",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  let uploadIds;
  if (scenario === "stream-image") {
    const png = await sharp(
      Buffer.from(
        `<svg width="600" height="240"><rect width="600" height="240" fill="white"/><text x="300" y="150" text-anchor="middle" font-family="sans-serif" font-size="85">${imageCode}</text></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const upload = await api.uploadWorkspaceFile(
      session.sessionId,
      randomUUID(),
      new Blob([png], { type: "image/png" }),
      "handoff-image.png",
    );
    uploadIds = [upload.id];
  }
  const task =
    "Use bash exactly once with this command: printf 'started\\n' >> once.txt; sleep 45; printf 'finished\\n' >> once.txt; printf 'CUBE_HANDOFF_SURVIVED'. Set timeout to 120 seconds. Do not use other tools or delegate. After completion reply CUBE_HANDOFF_SURVIVED.";
  const prompt =
    scenario === "child"
      ? `Call subagent exactly once with context:fresh, sandbox:shared and tools:["bash"]. Give it this exact task: ${task} Wait for that child's result and then reply CUBE_HANDOFF_SURVIVED. Do not use workflow, start another child, or use Bash yourself.`
      : scenario === "stream-image"
        ? "Read the six digits in the attached image directly and put them on the first line. Then write a thorough 4000-word technical tutorial in English about browser rendering, HTML parsing, CSS layout, painting, compositing, animation and performance measurement. Use numbered sections and concrete examples. This is also a streaming acceptance test, so develop each section fully instead of giving a short outline. Start the tutorial immediately after the digits. Do not use any tools."
        : task;
  turn = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("handoff"),
    "low",
    uploadIds,
  );
  report.runId = turn.runId;
  console.log(JSON.stringify({ phase: "handoff-start", scenario, runId: turn.runId }));
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  if (scenario === "stream-image") {
    streamAbort = new AbortController();
    streaming = streamSessionEvents({
      sessionId: session.sessionId,
      authorizationToken,
      fetchImplementation,
      signal: streamAbort.signal,
      onStatus() {},
      onSnapshot(snapshot) {
        view = sessionViewReducer(view, {
          type: "conversation.loaded",
          conversation: snapshot.conversation,
        });
        observeText();
      },
      onEvent(event) {
        view = sessionViewReducer(view, { type: "stream.event", event });
        observeText();
      },
    }).catch((failure) => {
      if (!streamAbort.signal.aborted) streamFailure = failure;
    });
  }
  await waitFor(
    async () => {
      if (streamFailure) throw streamFailure;
      const r = await api.getRun(turn.runId);
      if (terminal(r)) {
        const detail = (await api.getConversation(session.sessionId)).turns.find(
          (item) => item.runId === turn.runId,
        );
        const text =
          detail?.transcript.items
            .filter((item) => item.kind === "text")
            .map((item) => item.text)
            .join("") ?? "";
        report.beforeFaultEnd = {
          state: r.state,
          failure: r.failure,
          canonicalCharacters: text.length,
          observedCharacters: observedText.length,
          textEvents,
        };
        throw Error("Run ended before fault " + JSON.stringify(report.beforeFaultEnd));
      }
      if (scenario === "stream-image") return observedText.length >= 300;
      try {
        return (
          Buffer.from(
            (await api.readWorkspaceFile(session.sessionId, "once.txt")).bytes,
          ).toString() === "started\n"
        );
      } catch {
        return false;
      }
    },
    scenario === "stream-image" ? "live image answer" : "native Bash start",
  );
  const observedPrefix = observedText.slice(0, 150);
  if (scenario === "child") {
    const children =
      await nativeQuery(sql`select e.child_session_id, s.pi_session_id=ps.pi_session_id as same_session,
      not exists(select 1 from runs cr where cr.session_id=e.child_session_id) as no_child_run
      from subagent_executions e join sessions s on s.id=e.child_session_id
      join runs r on r.id=e.root_run_id join sessions ps on ps.id=r.session_id
      where e.root_run_id=${turn.runId}::uuid`);
    assert.equal(children.length, 1);
    child = children[0];
    assert(child.same_session && child.no_child_run);
    report.nativeChildOnly = true;
  }
  const before = await api.getRun(turn.runId);
  report.workerId = before.workerId;
  await assertOnlyOwnedRun();
  const targetPod = podFor("control-plane");
  console.log(JSON.stringify({ phase: "replace-control-plane", scenario }));
  const faultStartedAt = Date.now();
  const charactersBeforeRoll = observedText.length;
  if (faultMode === "process") {
    const beforePod = JSON.parse(kubectl(["get", "pod", targetPod, "-o", "json"]));
    const count = beforePod.status.containerStatuses[0].restartCount;
    const containerId = beforePod.status.containerStatuses[0].containerID;
    assert(
      /^containerd:\/\/[0-9a-f]{64}$/.test(containerId),
      "Expected the local K3s containerd task",
    );
    await exec("/usr/local/bin/k3s", [
      "ctr",
      "-n",
      "k8s.io",
      "tasks",
      "kill",
      "--signal",
      "SIGKILL",
      containerId.slice("containerd://".length),
    ]);
    await waitFor(
      async () => {
        const status = JSON.parse(kubectl(["get", "pod", targetPod, "-o", "json"])).status
          .containerStatuses[0];
        if (!(status.restartCount > count && status.ready && status.state.running)) return false;
        assert.equal(
          status.lastState?.terminated?.exitCode,
          137,
          "Process did not exit through SIGKILL",
        );
        report.processExitCode = status.lastState.terminated.exitCode;
        report.restartCountIncreased = true;
        return true;
      },
      "process restarted and Ready",
      180000,
    );
  } else if (faultMode === "rolling") {
    const beforeDeployment = JSON.parse(
      kubectl(["get", "deployment/pi-cloud-control-plane", "-o", "json"]),
    );
    assert.equal(beforeDeployment.spec.strategy.type, "RollingUpdate");
    const images = beforeDeployment.spec.template.spec.containers.map(
      (container) => container.image,
    );
    await kubectlAsync(["rollout", "restart", "deployment/pi-cloud-control-plane"]);
    await kubectlAsync([
      "rollout",
      "status",
      "deployment/pi-cloud-control-plane",
      "--timeout=180s",
    ]);
    const afterDeployment = JSON.parse(
      kubectl(["get", "deployment/pi-cloud-control-plane", "-o", "json"]),
    );
    assert.deepEqual(
      afterDeployment.spec.template.spec.containers.map((container) => container.image),
      images,
    );
    assert.notEqual(podFor("control-plane"), targetPod);
    report.compatibleRollingReplacement = true;
    report.artifactsUnchanged = true;
  } else {
    await kubectlAsync(["delete", "pod", targetPod, "--grace-period=0", "--force", "--wait=true"]);
    await kubectlAsync([
      "rollout",
      "status",
      "deployment/pi-cloud-control-plane",
      "--timeout=180s",
    ]);
  }
  report.replacementMs = Date.now() - faultStartedAt;
  report.charactersBeforeRoll = charactersBeforeRoll;
  report.charactersAtReady = observedText.length;
  const readyAt = Date.now();
  const finished = await waitFor(
    async () => {
      try {
        const r = await api.getRun(turn.runId);
        return terminal(r) ? r : undefined;
      } catch {
        return undefined;
      }
    },
    "Run completion",
    scenario === "stream-image" ? 360000 : 180000,
  );
  report.completionAfterReadyMs = Date.now() - readyAt;
  report.completionState = finished.state;
  if (finished.failure) report.failure = finished.failure;
  assert.equal(finished.state, "completed", JSON.stringify(finished.failure));
  assert.equal(finished.workerId, before.workerId);
  const transcript = (await api.getConversation(session.sessionId)).turns.find(
    (t) => t.runId === turn.runId,
  ).transcript;
  const tools = transcript.items.filter((i) => i.kind === "tool");
  if (scenario === "stream-image") {
    assert.equal(tools.length, 0);
    const text = transcript.items
      .filter((item) => item.kind === "text")
      .map((item) => item.text)
      .join("");
    assert(text.includes(imageCode), "Image digits were not retained");
    assert(text.includes(observedPrefix), "Pre-roll visible text was lost");
    assert(text.length > observedPrefix.length);
    assert(textEvents > 1, "No incremental text observations");
    report.imageVerified = true;
    report.preservedPrefixSha256 = createHash("sha256").update(observedPrefix).digest("hex");
    report.textEvents = textEvents;
    report.maxObservedTextGapMs = maxTextGapMs;
    report.finalCharacters = text.length;
  } else {
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, "completed");
    if (child) {
      assert.equal(tools[0].toolName, "subagent");
      const childTurns = (await api.getConversation(child.child_session_id)).turns;
      const childTools = childTurns
        .flatMap((turn) => turn.transcript.items)
        .filter((item) => item.kind === "tool");
      assert.equal(childTools.length, 1);
      assert.equal(childTools[0].toolName, "bash");
      assert.equal(childTools[0].status, "completed");
      report.controlToolReplyRecovered = true;
    }
    assert.equal(
      Buffer.from((await api.readWorkspaceFile(session.sessionId, "once.txt")).bytes).toString(),
      "started\nfinished\n",
    );
    report.executionCount = 1;
    report.cubeCompletedAcrossControlPlaneLoss = true;
  }
  report.accepted = true;
  report.workerUnchanged = true;
} catch (e) {
  error = e;
} finally {
  streamAbort?.abort();
  await streaming;
  const cleanup = [];
  if (turn && session) {
    try {
      const r = await api.getRun(turn.runId);
      if (!terminal(r)) {
        await api.cancelTurn(session.sessionId, turn.turnId, newIdempotencyKey("cleanup"));
        await waitFor(async () => terminal(await api.getRun(turn.runId)), "cancel");
      }
    } catch (e) {
      cleanup.push(e);
    }
  }
  if (session) await api.deleteConversation(session.sessionId).catch((e) => cleanup.push(e));
  if (project)
    await api
      .deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup-workspace"))
      .catch((e) => cleanup.push(e));
  if (project) {
    try {
      await waitFor(async () => {
        const [row] = await nativeQuery(
          sql`select deleted_at is not null and storage_purged_at is not null as purged from workspaces where id=${project.workspaceId}::uuid`,
        );
        return !row || row.purged;
      }, "physical Workspace purge");
      report.physicalCleanupConfirmed = true;
    } catch (failure) {
      cleanup.push(failure);
    }
  }
  report.cleanupCompleted = cleanup.length === 0;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  if (error || cleanup.length)
    throw new AggregateError([...(error ? [error] : []), ...cleanup], "Handoff restart failed");
}
