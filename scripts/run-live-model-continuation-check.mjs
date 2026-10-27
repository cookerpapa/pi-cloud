// Owned image/Tool continuation and cold-owner reopening on the deployed stack.
import assert from "node:assert/strict";
import sharp from "sharp";
import { readWorkerModelTimings } from "./lib/live-run-timing.mjs";
import { ensureProviderWebsocketAccounts } from "./lib/provider-websocket-policy.mjs";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  kubectl,
} from "./lib/production-kubernetes.mjs";
import { nativeHistory, nativeMessages, imageReferences } from "./lib/native-session-history.mjs";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_MODEL_CONTINUATION_CHECK,
  "1",
  "Authorize the owned Luna/Cube fixture",
);
const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/live-model-continuation",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const origin = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const report = {
  at: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
};
let tenant, api, project, session, run, failure;
const terminal = (r) => ["completed", "cancelled", "failed", "timed_out"].includes(r.state);
async function until(read, label, budget = 600000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw Error(label + " timed out");
}
try {
  report.providerPolicy = await ensureProviderWebsocketAccounts({
    baseUrl: `http://${serviceAddress("cli-proxy-api")}:8317`,
    managementKey: (
      await readFile(`${runtimeDirectory}/secrets/cli-proxy-management-key`, "utf8")
    ).trim(),
    verifyOnly: true,
  });
  assert(report.providerPolicy.codexAccounts > 0);
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-ws-${randomUUID()}`,
    ownerDisplayName: "Model continuation acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  report.tenantId = tenant.tenantId;
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), origin), init),
    tenant.credential.token,
  );
  project = await api.createProject("Model continuation acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Model continuation",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.sessionId = session.sessionId;
  report.workspaceId = project.workspaceId;
  const selected = randomInt(3),
    color = ["RED", "GREEN", "BLUE"][selected];
  const pixels = randomBytes(1024 * 1024 * 3);
  for (let i = 0; i < pixels.length; i++)
    pixels[i] = i % 3 === selected ? 208 + (pixels[i] % 48) : pixels[i] % 24;
  const png = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } })
    .png()
    .toBuffer();
  const upload = await api.uploadWorkspaceFile(
    session.sessionId,
    randomUUID(),
    new Blob([png]),
    "continuation-fixture.png",
  );
  report.imageBytes = png.length;
  report.rounds = [];
  for (const round of [1, 2]) {
    const trafficBefore = providerTraffic();
    const started = Date.now();
    run = await api.acceptTurn(
      session.sessionId,
      `这是传输验收第 ${round} 轮。${round === 1 ? "图片已经直接附在输入中。" : "沿用上一轮的图片。"}请严格依次调用 bash 执行两条命令：printf 'CONTINUATION_A\\n'，然后 printf 'CONTINUATION_B\\n'。收到前一条结果才执行下一条。不要调用其他工具，不读取或改动图片。最后只用英文回答图片的主色 RED/GREEN/BLUE 中的一种，并附上 CONTINUATION_OK。`,
      newIdempotencyKey("continuation"),
      "low",
      round === 1 ? [upload.id] : undefined,
    );
    assert.equal(run.kind, "run");
    const settled = await until(async () => {
      const value = await api.getRun(run.runId);
      return terminal(value) && value;
    }, "Image/Tool Run");
    assert.equal(settled.state, "completed", JSON.stringify(settled.failure));
    await until(
      async () =>
        !(
          await db
            .selectFrom("session_leases")
            .select("lease_id")
            .where("tenant_id", "=", tenant.tenantId)
            .where("released_at", "is", null)
            .execute()
        ).length,
      "Retire native owner",
    );
    const history = await nativeHistory(db, { runId: run.runId });
    const messages = nativeMessages(history);
    const tools = messages.filter((m) => m.role === "toolResult");
    assert.equal(tools.length, 2);
    assert(tools.every((m) => m.toolName === "bash" && !m.isError));
    const answer = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ");
    assert(
      answer.includes(color) && answer.includes("CONTINUATION_OK"),
      "Retained image recall failed",
    );
    const timings = await readWorkerModelTimings([run.runId], started);
    const ws = timings.filter(
      (t) => t.transport === "websocket" && t.terminalEvent === "response.completed",
    );
    assert(ws.length >= 2, "Need native model/tool continuation through WebSocket");
    assert.equal(ws[0].incremental, false, "A new native owner must send full context");
    assert(
      ws[0].requestBytes > 512 * 1024,
      "The initial request must include the large retained image",
    );
    const deltas = ws.filter((t) => t.incremental);
    assert(deltas.length >= 1, "Native Pi did not reuse its response context");
    assert(
      deltas.every((t) => t.connectionReused && t.requestBytes < ws[0].requestBytes / 4),
      "A continuation retransmitted the large image body",
    );
    const trafficAfter = providerTraffic();
    assert.equal(
      trafficAfter.boot,
      trafficBefore.boot,
      "Provider process changed during traffic measurement",
    );
    const providerBytesSent = trafficAfter.sent - trafficBefore.sent;
    assert(
      providerBytesSent > ws[0].requestBytes * 0.8,
      "Traffic must include the initial provider upload",
    );
    assert(
      providerBytesSent < ws[0].requestBytes * 1.6,
      "Proxy expanded continuation into repeated full upstream uploads",
    );
    report.rounds.push({
      runId: run.runId,
      workerId: settled.workerId,
      imageRecall: true,
      providerBytesSent,
      tools: tools.length,
      retainedImages: imageReferences(history).length,
      requests: timings.map((t) => ({
        transport: t.transport,
        terminalEvent: t.terminalEvent,
        requestBytes: t.requestBytes,
        incremental: t.incremental,
        connectionReused: t.connectionReused,
        firstByteMs: t.firstByteMs,
        elapsedMs: t.elapsedMs,
        modelOutcome: t.modelOutcome,
      })),
    });
    await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  }
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + tenant.credential.token },
    });
    await page.navigate(origin + "/?session=" + session.sessionId);
    await page.waitFor("document.querySelector('.product-composer textarea')");
    assert.equal(
      await page.evaluate(
        "[...document.querySelectorAll('button')].some(b=>['Cloud phone','云手机'].includes(b.textContent.trim()))",
      ),
      false,
    );
    report.phoneEntryRemoved = true;
  });
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 1200);
} finally {
  try {
    if (run && !terminal(await api.getRun(run.runId))) {
      await api.cancelTurn(session.sessionId, run.turnId, newIdempotencyKey("continuation-stop"));
      await until(async () => terminal(await api.getRun(run.runId)), "Stop owned Run");
    }
    if (session) {
      await until(
        async () =>
          !(
            await db
              .selectFrom("session_leases")
              .select("lease_id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("released_at", "is", null)
              .execute()
          ).length,
        "Writer closure",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("continuation-cleanup"));
      await until(
        async () =>
          (
            await db
              .selectFrom("workspaces")
              .select("storage_purged_at")
              .where("id", "=", project.workspaceId)
              .executeTakeFirst()
          )?.storage_purged_at,
        "Physical Workspace purge",
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
        "Control cleanup",
      );
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(
            resolve(runtimeDirectory, "secrets/session-image-s3-credentials.json"),
            "utf8",
          ),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } finally {
        blobs.close();
      }
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    failure ??= error;
    report.cleanupFailure = String(error?.message ?? error).slice(0, 700);
  }
  await db.destroy();
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
if (failure) throw failure;

// One-provider local acceptance only. Byte counters include encrypted upstream
// traffic and downstream replies; they never inspect prompts or image contents.
function providerTraffic() {
  const pod = JSON.parse(kubectl(["get", "pod", "cli-proxy-api-0", "-o", "json"]));
  const counters = kubectl(["exec", "cli-proxy-api-0", "--", "cat", "/proc/net/dev"]);
  const row = counters.split("\n").find((line) => /^\s*eth0:/.test(line));
  assert(row, "Provider interface counters unavailable");
  const values = row.split(":")[1].trim().split(/\s+/);
  return { boot: pod.status.containerStatuses[0].containerID, sent: Number(values[8]) };
}
