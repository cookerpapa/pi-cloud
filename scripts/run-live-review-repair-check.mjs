// Owner-invoked release acceptance. Owns its tenant, Session and Workspace.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { workspaceVolumeId } from "../packages/sandbox-control/src/workspace-volume-gateway-contract.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import {
  serviceAddress,
  runtimeDirectory,
  runtimeEnvironment,
} from "./lib/production-kubernetes.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_REPAIR_CHECK !== "1")
  throw Error(
    "Set PI_CLOUD_LIVE_REPAIR_CHECK=1 for one owned Luna Run and streamed Workspace acceptance",
  );
const url = new URL(
  (await readFile(join(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const baseUrl = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const report = { checkedAt: new Date().toISOString(), accepted: false, model: "gpt-6-luna" };
let tenant, api, project, session, failure, upload;
const release = Promise.withResolvers();
async function until(read, label, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(label + " timed out");
}
try {
  tenant = await createPrivateTenant(db, {
    slug: "release-retry-" + Date.now().toString(36),
    ownerDisplayName: "Release retry acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), baseUrl), init),
    tenant.credential.token,
  );
  project = await api.createProject("Release retry/upload acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Release retry acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    sessionId: session.sessionId,
    workspaceId: project.workspaceId,
  };
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: `Bearer ${tenant.credential.token}` },
    });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
   const originalFetch=window.fetch.bind(window);window.releaseTurnCalls=[];let loseReply=true;
   window.fetch=async(input,init)=>{const response=await originalFetch(input,init);
    if(String(input).endsWith('/turns')&&init?.method==='POST'&&response.ok){
     const receipt=await response.clone().json();window.releaseTurnCalls.push({key:new Headers(init.headers).get('idempotency-key'),runId:receipt.runId,replayed:receipt.replayed});
     if(loseReply){loseReply=false;throw new TypeError('Acceptance discarded the committed response');}
    }return response;
   };`,
    });
    await page.navigate(`${baseUrl}/?session=${session.sessionId}`);
    await page.waitFor(
      "document.querySelector('.product-composer textarea') && !document.querySelector('.product-composer textarea').disabled",
    );
    await page.evaluate(
      `(()=>{const input=document.querySelector('.product-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'只回复 LIVE_RETRY_OK，不要调用工具。');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await page.waitFor("!document.querySelector('.product-send-button').disabled");
    await page.evaluate("document.querySelector('.product-send-button').click()");
    await page.waitFor(
      "releaseTurnCalls.length===1 && !document.querySelector('.product-send-button').disabled",
    );
    await page.evaluate("document.querySelector('.product-send-button').click()");
    await page.waitFor(
      "releaseTurnCalls.length===2 && document.querySelector('.product-composer textarea').value===''",
    );
    const calls = await page.evaluate("releaseTurnCalls");
    assert.equal(calls[0].key, calls[1].key);
    assert.equal(calls[0].runId, calls[1].runId);
    assert.equal(calls[1].replayed, true);
    report.browserRetry = {
      sameKey: true,
      sameRun: true,
      serverConfirmedReplay: true,
      requests: calls.length,
      runId: calls[0].runId,
    };
  });
  await until(async () => {
    const run = await api.getRun(report.browserRetry.runId);
    if (["failed", "cancelled", "timed_out"].includes(run.state))
      throw Error("Luna retry Run failed");
    return run.state === "completed";
  }, "Luna Run");
  const runs = await db
    .selectFrom("runs")
    .select(["id", "state"])
    .where("session_id", "=", session.sessionId)
    .execute();
  assert.equal(runs.length, 1);
  await api.uploadWorkspaceFile(session.sessionId, randomUUID(), new Blob(["ready"]), "seed.txt");
  const id = randomUUID(),
    bytes = Buffer.alloc(1024 * 1024, 65);
  const volume = workspaceVolumeId({ tenantId: tenant.tenantId, workspaceId: project.workspaceId });
  const temporary = join(
    runtimeDirectory,
    "state/cube-shared/volume",
    `picloud-posix-${volume}`,
    ".pi-cloud-runtime/uploads-v1/files",
  );
  let finished = false;
  upload = fetch(`${baseUrl}/v1/sessions/${session.sessionId}/uploads/${id}?name=slow.bin`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${tenant.credential.token}`,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "content-digest": `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`,
    },
    body: (async function* () {
      yield bytes.subarray(0, 65536);
      await release.promise;
      yield bytes.subarray(65536);
    })(),
    duplex: "half",
    signal: AbortSignal.timeout(90000),
  }).then(async (response) => {
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    finished = true;
    return body;
  });
  void upload.catch(() => {});
  await until(
    async () => {
      const files = await readdir(temporary).catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      });
      for (const name of files)
        if (name.startsWith(".part-") && (await stat(join(temporary, name))).size >= 65536)
          return true;
      return false;
    },
    "Partial file in the real Volume",
    30000,
  );
  const at = performance.now();
  const listing = await api.listWorkspaceDirectory(session.sessionId);
  assert(listing.entries.length > 0);
  const second = await api.uploadWorkspaceFile(
    session.sessionId,
    randomUUID(),
    new Blob(["concurrent"]),
    "quick.txt",
    AbortSignal.timeout(5000),
  );
  assert.equal(second.byteLength, 10);
  assert.equal(finished, false);
  report.concurrentUpload = {
    inProgressBytes: 65536,
    totalBytes: bytes.length,
    browseAndSecondUploadMs: performance.now() - at,
    secondUploadBeforeFirstFinished: true,
  };
  release.resolve();
  const completed = await upload;
  assert.equal(completed.byteLength, bytes.length);
  assert.deepEqual(await readdir(temporary), []);
  report.concurrentUpload.stagingEmptyAfterCompletion = true;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  release.resolve();
  await upload?.catch(() => {});
  const errors = [];
  try {
    if (session) {
      const runs = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      for (const run of runs)
        if (!["completed", "failed", "cancelled", "timed_out"].includes(run.state))
          await api.cancelTurn(session.sessionId, run.turn_id, newIdempotencyKey("cancel"));
      await until(
        async () =>
          !(
            await db
              .selectFrom("runs")
              .select("id")
              .where("session_id", "=", session.sessionId)
              .where((eb) =>
                eb.or([
                  eb("state", "in", ["queued", "running", "settling", "cancel_requested"]),
                  eb.and([
                    eb("output_seal_id", "is not", null),
                    eb("output_sealed_at", "is", null),
                  ]),
                ]),
              )
              .execute()
          ).length,
        "Owned Run seal",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
  } catch (error) {
    errors.push(error);
  }
  if (tenant)
    await db
      .updateTable("tenant_api_credentials")
      .set({ revoked_at: new Date() })
      .where("credential_id", "=", tenant.credential.credentialId)
      .execute();
  report.cleanupRequested = errors.length === 0;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-live-review-repair.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Release repair acceptance failed",
    );
}
console.log(JSON.stringify(report));
