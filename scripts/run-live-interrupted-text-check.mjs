import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  INTERRUPTED_TEXT_ENTRY,
  INTERRUPTION_MARKER,
} from "../packages/sandbox-supervisor/src/durable/interrupted-text.ts";
import { nativeHistory, nativeMessages } from "./lib/native-session-history.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_INTERRUPTED_TEXT_CHECK,
  "1",
  "Authorize owned GPT/Flash interruption fixtures",
);
const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/interrupted-text",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const url = new URL((await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim());
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const blobs = new S3ImageBlobStore({
  endpoint: `http://${serviceAddress("session-images")}:8333`,
  bucket: "pi-cloud-session-images",
  region: "us-east-1",
  ...JSON.parse(
    await readFile(`${runtimeDirectory}/secrets/session-image-s3-credentials.json`, "utf8"),
  ),
});
const origin = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const report = {
  at: new Date().toISOString(),
  accepted: false,
  checks: [],
  cleanupConfirmed: false,
};
const terminal = (run) => ["completed", "cancelled", "failed", "timed_out"].includes(run.state);
const text = (messages) =>
  messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
let tenant, api, project, failure;
const sessions = [];
const streams = [];
const save = () =>
  writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
async function until(read, label, budget = 300000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw Error(label + " timed out");
}
async function settled(id) {
  const run = await until(async () => {
    const r = await api.getRun(id);
    return terminal(r) ? r : undefined;
  }, "Run settlement");
  await until(async () => {
    const r = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !r.output_seal_id || r.output_sealed_at;
  }, "writer seal");
  return run;
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-partial-${randomUUID().slice(0, 18)}`,
    ownerDisplayName: "Interrupted text acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  report.tenantId = tenant.tenantId;
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), origin), init),
    tenant.credential.token,
  );
  project = await api.createProject("Interrupted text acceptance", { kind: "empty" });
  report.workspaceId = project.workspaceId;
  await save();
  const selections = [
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
    { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "low", fastMode: false },
  ];
  for (const [selection, nextSelection] of selections.flatMap((source) =>
    selections.map((target) => [source, target]),
  )) {
    const session = await api.createSession(
      project.projectId,
      project.workspaceId,
      "Interrupted text",
      "elastic",
      "starter",
      "/workspace",
      selection,
    );
    sessions.push(session);
    const state = {
      controller: new AbortController(),
      text: "",
      turnId: undefined,
      error: undefined,
      live: false,
    };
    state.streaming = streamSessionEvents({
      sessionId: session.sessionId,
      authorizationToken: tenant.credential.token,
      signal: state.controller.signal,
      fetchImplementation: (path, init) => fetch(new URL(String(path), origin), init),
      onSnapshot() {},
      onStatus(status) {
        state.live = status.phase === "live";
      },
      onEvent(event) {
        if (
          event.type !== "assistant.text.delta" ||
          (state.turnId && event.turnId !== state.turnId)
        )
          return;
        state.text = event.payload.replace ? event.payload.text : state.text + event.payload.text;
      },
    }).catch((error) => {
      state.error = error;
    });
    streams.push(state);
    await until(() => {
      if (state.error) throw state.error;
      return state.live;
    }, "SSE attachment");
    const run = await api.acceptTurn(
      session.sessionId,
      "这是中断恢复验收。不要调用工具。第一行自行创造一个由八个大写英文字母组成的暗号，严格写成 CODE:XXXXXXXX（用你创造的字母替换，不要使用XXXXXXXX）。然后立即写一篇至少五千字的中文文章解释为什么你打算把一个游戏做成纯前端。不要提问，不要使用代码块。",
      newIdempotencyKey("partial"),
      "low",
    );
    assert.equal(run.kind, "run");
    state.turnId = run.turnId;
    await until(async () => {
      if (state.error) throw state.error;
      const r = await api.getRun(run.runId);
      if (terminal(r)) throw Error("Run completed before the intended interruption: " + r.state);
      return /CODE\s*[:：]\s*([A-Z]{8})/u.test(state.text) && state.text.length >= 120;
    }, "visible unfinished text");
    const code = state.text.match(/CODE\s*[:：]\s*([A-Z]{8})/u)[1];
    assert.notEqual(code, "XXXXXXXX");
    await api.cancelTurn(session.sessionId, run.turnId, newIdempotencyKey("stop"));
    assert.equal((await settled(run.runId)).state, "cancelled");
    state.controller.abort();
    await state.streaming;
    const rows = await nativeHistory(db, { runId: run.runId });
    const source = rows.find(
      (row) =>
        row.entry.kind === "pi.assistant" &&
        row.entry.model?.some(
          (m) => m.stopReason === "aborted" && JSON.stringify(m.content).includes(code),
        ),
    );
    assert(source, "Interrupted source must be stored with its true outcome");
    const edits = rows.filter(
      (row) =>
        row.entry.kind === INTERRUPTED_TEXT_ENTRY &&
        row.entry.edits?.some((edit) => edit.target === source.entry.id),
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].entry.model, undefined);
    assert(JSON.stringify(edits[0].entry.edits).includes(INTERRUPTION_MARKER));
    assert.equal(
      nativeMessages(rows)
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.content)
        .filter((c) => c.type === "toolCall").length,
      0,
    );
    if (selection.modelId !== nextSelection.modelId)
      await api.updateSessionModel(session.sessionId, nextSelection);
    const follow = await api.acceptTurn(
      session.sessionId,
      "你刚才说要做纯前端，但我需要后端。只回复你刚才自己写出的八字母暗号，然后一个空格和 BACKEND_REQUIRED。不要调用工具。",
      newIdempotencyKey("correction"),
      "low",
    );
    assert.equal((await settled(follow.runId)).state, "completed");
    const answer = text(nativeMessages(await nativeHistory(db, { runId: follow.runId })));
    assert(answer.includes(code), "The model lost its own interrupted words");
    assert(answer.includes("BACKEND_REQUIRED"));
    const snapshot = await api.getConversation(session.sessionId);
    const interrupted = snapshot.turns.find((turn) => turn.runId === run.runId);
    assert(interrupted);
    assert(
      !JSON.stringify(interrupted.transcript).includes(INTERRUPTION_MARKER),
      "Context marker leaked into browser history",
    );
    report.checks.push({
      model: selection.modelId,
      followUpModel: nextSelection.modelId,
      sessionId: session.sessionId,
      stoppedRun: run.runId,
      followUpRun: follow.runId,
      sourceAborted: true,
      contextEdits: 1,
      ownTextRecalled: true,
      contextMarkerHiddenFromBrowser: true,
    });
    await save();
  }
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error);
} finally {
  for (const state of streams) {
    state.controller.abort();
    await state.streaming;
  }
  try {
    for (const session of sessions) {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settled);
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
      await until(
        async () =>
          (
            await db
              .selectFrom("workspaces")
              .select("storage_purged_at")
              .where("id", "=", project.workspaceId)
              .executeTakeFirst()
          )?.storage_purged_at,
        "Workspace purge",
      );
    }
    if (tenant) {
      await until(
        async () =>
          !(
            await db
              .selectFrom("outbox")
              .select("id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("published_at", "is", null)
              .execute()
          ).length,
        "fixture controls",
      );
      await purgeOwnedAcceptanceTenant(db, tenant, blobs);
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    report.cleanupFailure = String(error);
    failure ??= error;
  }
  await save();
  blobs.close();
  await db.destroy();
}
console.log(JSON.stringify(report));
if (failure) throw failure;
