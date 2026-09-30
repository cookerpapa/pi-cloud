import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

if (process.env.PI_CLOUD_LIVE_RUNTIME_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_RUNTIME_CHECK=1 to use Luna and a disposable Cube Workspace");
const runtime = "deploy/production/runtime";
const env = await readFile(`${runtime}/.env`, "utf8");
const port = env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const api = new PiCloudApi(
  (url, init) =>
    fetch(new URL(String(url), `http://127.0.0.1:${port}`), {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    }),
  (await readFile(`${runtime}/secrets/api-token`, "utf8")).trim(),
);
const marker = randomUUID().slice(0, 8);
const steerMarker = `STEER_${marker}`;
const queueMarker = `QUEUE_${marker}`;
const report = {
  checkedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
};
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
async function waitFor(read, predicate, label) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await pause();
  }
  throw new Error(`Timed out waiting for ${label}`);
}
let project, session, first, second, failure;
try {
  project = await api.createProject(`Runtime lifecycle acceptance ${marker}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Runtime lifecycle acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  first = await api.acceptTurn(
    session.sessionId,
    "Call bash exactly once with command: sleep 5; printf 'RUNTIME_TOOL_OK\\n'. After it completes, reply RUNTIME_FIRST. Keep the Workspace files unchanged.",
    newIdempotencyKey("turn"),
  );
  second = await api.acceptTurn(
    session.sessionId,
    `This is the next queued task. Use no tools and reply exactly ${queueMarker}.`,
    newIdempotencyKey("turn"),
  );
  await waitFor(
    () => api.getConversation(session.sessionId),
    (conversation) => {
      const t = conversation.turns.find((t) => t.turnId === first.turnId);
      return t?.transcript?.items.some((i) => i.kind === "tool" && i.status === "running");
    },
    "first Run's active Tool",
  );
  assert.equal((await api.getRun(second.runId)).state, "queued");
  report.followUpWaited = true;
  let cancellationStatus;
  try {
    await api.cancelTurn(session.sessionId, second.turnId, newIdempotencyKey("cancel"));
  } catch (error) {
    cancellationStatus = error.status;
  }
  assert.equal(cancellationStatus, 409, "Current product API must reject queued-Turn cancellation");
  report.queuedCancellationStatus = cancellationStatus;
  const delivery = await api.steerTurn(
    session.sessionId,
    first.turnId,
    `For this current task, include ${steerMarker} in your final response after the Tool completes.`,
    newIdempotencyKey("steer"),
  );
  assert.equal(delivery.state, "accepted");
  report.steerDelivered = true;
  for (const accepted of [first, second]) {
    const run = await waitFor(() => api.getRun(accepted.runId), terminal, "Run completion");
    assert.equal(run.state, "completed", JSON.stringify(run.failure));
    report.runs.push({ runId: run.runId, workerId: run.workerId, state: run.state });
  }
  const conversation = await api.getConversation(session.sessionId);
  const text = (id) =>
    conversation.turns
      .find((t) => t.turnId === id)
      ?.transcript?.items.filter((i) => i.kind === "text")
      .map((i) => i.text)
      .join("") ?? "";
  assert(text(first.turnId).includes(steerMarker));
  assert.equal(text(second.turnId).trim(), queueMarker);
  report.steerConsumed = true;
  report.followUpConsumed = true;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const accepted of [first, second].filter(Boolean)) {
    try {
      let run = await api.getRun(accepted.runId);
      if (!terminal(run)) {
        run = await waitFor(
          () => api.getRun(accepted.runId),
          (r) => terminal(r) || r.state === "running",
          "cleanup admission",
        );
        if (!terminal(run))
          await api.cancelTurn(session.sessionId, accepted.turnId, newIdempotencyKey("cancel"));
        await waitFor(() => api.getRun(accepted.runId), terminal, "cleanup completion");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    if (session) await api.deleteConversation(session.sessionId);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (project) await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
  } catch (error) {
    cleanupErrors.push(error);
  }
  report.cleanupCompleted = cleanupErrors.length === 0;
  if (failure) report.failure = failure instanceof Error ? failure.message : String(failure);
  await writeFile(
    "docs/reports/cloud-agent-runtime-live-20260926.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [failure, ...cleanupErrors].filter(Boolean),
      "Runtime live acceptance failed",
    );
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    runs: report.runs.length,
    cleanupCompleted: report.cleanupCompleted,
  }),
);
