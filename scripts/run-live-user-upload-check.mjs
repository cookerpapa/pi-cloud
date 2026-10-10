import { serviceAddress, kubectlAsync } from "./lib/production-kubernetes.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { execFile as callback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_USER_UPLOAD_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_USER_UPLOAD_CHECK=1 for disposable Workspace/Luna/browser/cold-Worker acceptance",
  );
const runtime = "deploy/production/runtime",
  execFile = promisify(callback);
const env = await readFile(`${runtime}/.env`, "utf8"),
  port = env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const baseUrl = `http://127.0.0.1:${port}`;
const pgurl = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pgurl.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: pgurl.toString(), maxConnections: 2 });
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-upload-live-"));
const report = {
  checkedAt: new Date().toISOString(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
};
let api, tenant, project, session, active, development, failure;
const machineMode = process.argv[3] === "machine";
const elasticProfile = process.env.PI_CLOUD_LIVE_SANDBOX_PROFILE ?? "starter";
assert(["starter", "standard", "performance"].includes(elasticProfile));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, budget = 600000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await wait(250);
  }
  throw new Error(`${label} timed out`);
}
async function completed(accepted, target = session.sessionId) {
  const run = await until(async () => {
    const run = await api.getRun(accepted.runId);
    return ["completed", "failed", "cancelled", "timed_out"].includes(run.state) ? run : undefined;
  }, "Run");
  assert.equal(run.state, "completed", JSON.stringify(run.failure));
  const turn = await until(
    async () =>
      (await api.getConversation(target)).turns.find(
        (t) => t.runId === run.runId && t.transcript?.terminalSequence,
      ),
    "History",
  );
  const tools = turn.transcript.items
    .filter((i) => i.kind === "tool")
    .map((i) => ({ name: i.toolName, status: i.status }));
  assert(
    tools.every((t) => t.status === "completed"),
    JSON.stringify(
      turn.transcript.items.filter((t) => t.kind === "tool" && t.status !== "completed"),
    ).slice(0, 2500),
  );
  report.runs.push({ runId: run.runId, workerId: run.workerId, tools });
  return {
    run,
    turn,
    text: turn.transcript.items
      .filter((i) => i.kind === "text")
      .map((i) => i.text)
      .join("\n"),
    tools,
  };
}
async function turn(prompt, uploadIds = []) {
  active = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("turn"),
    "low",
    uploadIds,
  );
  return completed(active);
}
async function queuedImageScenario() {
  const code = String(randomInt(100000, 999999));
  const png = await sharp(
    Buffer.from(
      `<svg width="600" height="240"><rect width="600" height="240" fill="white"/><text x="300" y="150" text-anchor="middle" font-family="sans-serif" font-size="85">${code}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const image = await api.uploadWorkspaceFile(
    session.sessionId,
    randomUUID(),
    new Blob([png]),
    "queued.png",
  );
  active = await api.acceptTurn(
    session.sessionId,
    "先用 bash 执行 sleep 12，完成后只回复 WAIT_DONE。",
    newIdempotencyKey("turn"),
    "low",
  );
  const running = active;
  await until(async () => {
    const state = await api.getRun(running.runId);
    if (["completed", "failed", "cancelled", "timed_out"].includes(state.state))
      throw new Error(
        `Run ended before the required running Tool: ${state.state} ${JSON.stringify(state.failure)}`,
      );
    return (await api.getConversation(session.sessionId)).turns
      .find((t) => t.turnId === running.turnId)
      ?.transcript?.items.some(
        (i) => i.kind === "tool" && i.toolName === "bash" && i.status === "running",
      );
  }, "Running Tool");
  const queued = await api.acceptTurn(session.sessionId, "", newIdempotencyKey("turn"), "low", [
    image.id,
  ]);
  let queue = await api.getInputQueue(session.sessionId);
  const edited = await api.mutateQueuedInput(
    session.sessionId,
    queued.inputId,
    {
      action: "edit",
      revision: queue.revision,
      text: "改为直接看这条消息附带的图片，只回复图中的六位数字，不要再调用工具。",
    },
    newIdempotencyKey("turn"),
  );
  queue = edited.queue;
  assert.deepEqual(queue.items.find((i) => i.inputId === queued.inputId)?.uploads, [image]);
  await api.mutateQueuedInput(
    session.sessionId,
    queued.inputId,
    { action: "steer", revision: queue.revision },
    newIdempotencyKey("turn"),
  );
  const result = await completed(running);
  assert(result.text.includes(code));
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["bash"],
  );
  assert.equal(queued.kind, "input");
  assert.equal(queued.runId, running.runId);
  assert.equal((await api.getInputQueue(session.sessionId)).items.length, 0);
  const { rows } =
    await sql`select count(*)::int n from pi_durable_records r join pi_durable_records e on e.tenant_id=r.tenant_id and e.session_id=r.session_id and e.id=(r.fields->>'entry')::bigint join pi_durable_log l on l.tenant_id=e.tenant_id and l.session_id=e.session_id and l.seq=e.seq and l.ordinal=e.ordinal where r.session_id=${session.sessionId} and r.kind='submission' and r.fields->>'request'=${JSON.stringify(queued.inputId)} and l.body like '%pi_cloud_image_v1%'`.execute(
      db,
    );
  assert.equal(rows[0].n, 1);
  report.queuedImageSteer = {
    imageOnlyAdmission: true,
    editPreservedAttachment: true,
    consumedExactlyOnce: true,
    directVisionWithoutRead: true,
    sameRunNativeSubmission: true,
  };
}

try {
  tenant = await createPrivateTenant(db, {
    slug: `upload-check-${Date.now().toString(36)}`,
    ownerDisplayName: "Upload acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), baseUrl), init),
    tenant.credential.token,
  );
  if (machineMode) {
    development = await api.createDevelopmentEnvironment(
      `Upload machine ${Date.now()}`,
      "standard",
      newIdempotencyKey("machine"),
    );
    await until(
      async () =>
        (await api.listDevelopmentEnvironments()).environments.find(
          (e) => e.environmentId === development.environmentId && e.state === "running",
        ),
      "Machine start",
    );
    project = { projectId: development.projectId, workspaceId: development.workspaceId };
  } else project = await api.createProject(`Upload acceptance ${Date.now()}`, { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Upload image acceptance",
    machineMode ? "development_environment" : "elastic",
    machineMode ? undefined : elasticProfile,
    machineMode ? "/home/user" : "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  if (process.argv[3] === "queue") {
    report.scenario = "queue";
    await queuedImageScenario();
  } else {
    const code = String(randomInt(100000, 999999)),
      order = ["BLUE", "GREEN", "ORANGE"];
    for (let i = 2; i > 0; i--) {
      const j = randomInt(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const colors = ["BLUE", "GREEN", "ORANGE"],
      fills = ["#2466dd", "#279249", "#f08a20"];
    const bars = colors
      .map((name, i) => {
        const height = 310 - order.indexOf(name) * 85;
        return `<rect x="${260 + i * 280}" y="${650 - height}" width="160" height="${height}" fill="${fills[i]}"/><text x="${340 + i * 280}" y="700" text-anchor="middle" font-size="35">${name}</text>`;
      })
      .join("");
    const overlay = Buffer.from(
      `<svg width="1300" height="900"><rect x="180" y="100" width="940" height="680" fill="white"/><g font-family="sans-serif" fill="black"><text x="650" y="250" text-anchor="middle" font-size="90">${code}</text>${bars}</g></svg>`,
    );
    const png = await sharp(randomBytes(3200 * 2400 * 3), {
      raw: { width: 3200, height: 2400, channels: 3 },
    })
      .composite([{ input: overlay }])
      .png()
      .toBuffer();
    assert(png.length > 16 * 1024 * 1024);
    const imageFile = join(directory, "capture.png");
    await writeFile(imageFile, png);
    const files = [imageFile];
    for (let index = 0; index < 5; index++) {
      const path = join(directory, `extra-${index}.bin`);
      await writeFile(path, Buffer.alloc(7 * 1024 * 1024, index + 65));
      files.push(path);
    }
    let uploadId;
    // Exercise the deployed composer, browser body, actual Caddy CSP and preview.
    await withChromePage({}, async (page) => {
      await page.send("Network.setExtraHTTPHeaders", {
        headers: { Authorization: `Bearer ${tenant.credential.token}` },
      });
      await page.send("Page.navigate", { url: `${baseUrl}/?session=${session.sessionId}` });
      await page.waitFor(
        'document.querySelector(".product-attach-button") && !document.querySelector(".product-attach-button").disabled',
        30000,
      );
      await page.waitFor(
        'document.querySelector(".product-topbar")?.innerText.includes("Upload image acceptance")',
        30000,
      );
      const { root } = await page.send("DOM.getDocument");
      const { nodeId } = await page.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: "input[type=file]",
      });
      await page.send("DOM.setFileInputFiles", { nodeId, files });
      await page.waitFor('document.querySelector(".upload-card img")?.naturalWidth>0', 30000);
      const upload = await until(async () => {
        const { rows } =
          await sql`select id,path,state from session_uploads where session_id=${session.sessionId}::uuid and name='capture.png'`.execute(
            db,
          );
        return rows.find((r) => r.state === "ready");
      }, "Browser upload");
      uploadId = upload.id;
      await until(async () => {
        const rows = await db
          .selectFrom("session_uploads")
          .select("id")
          .where("session_id", "=", session.sessionId)
          .where("state", "=", "ready")
          .execute();
        return rows.length === 6;
      }, "All six streamed files");
      assert(
        await page.evaluate('!document.querySelector(".product-attach-button").disabled'),
        "Composer retained a four-file quota",
      );
      report.unlimitedAttachments = {
        count: 6,
        totalBytes: png.length + 35 * 1024 * 1024,
        imageBytes: png.length,
        executionMode: machineMode ? "development_environment" : "elastic",
      };
      const prompt =
        "请直接看这条消息附带的图片，只回复图片顶端的六位数字。不要描述柱状图，不要调用任何工具。";
      await page.evaluate(
        `(() => { const node=document.querySelector('.product-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,${JSON.stringify(prompt)});node.dispatchEvent(new Event('input',{bubbles:true})); })()`,
      );
      await page.waitFor('!document.querySelector(".product-send-button").disabled');
      await page.evaluate('document.querySelector(".product-send-button").click()');
      active = await until(async () => {
        const { rows } =
          await sql`select r.id as "runId",r.turn_id as "turnId" from runs r where r.session_id=${session.sessionId}::uuid order by r.created_at desc limit 1`.execute(
            db,
          );
        return rows[0];
      }, "Browser message");
      const first = await completed(active);
      assert.equal(first.tools.length, 0);
      assert(first.text.includes(code));
      await page.send("Page.reload");
      await page.waitFor(
        'document.querySelector(".product-user-message .upload-card img")?.naturalWidth>0',
        30000,
      );
      report.browser = {
        uploadedBytes: png.length,
        previewAfterReload: true,
        originalTextSeparate: true,
        imageSeenWithoutTool: true,
      };
    });
    const { rows: sourceRows } =
      await sql`select image_reference as image,path from session_uploads where id=${uploadId}::uuid`.execute(
        db,
      );
    const source = sourceRows[0];
    const canonical =
      await sql`select max(octet_length(body))::int as bytes,count(*)::int as count from pi_durable_log where session_id=${session.sessionId} and body like '%pi_cloud_image_v1%'`.execute(
        db,
      );
    assert(canonical.rows[0].count > 0);
    assert(canonical.rows[0].bytes < 16384);
    report.referencesOnly = canonical.rows[0];
    const note = await api.uploadWorkspaceFile(
      session.sessionId,
      randomUUID(),
      new Blob(["workspace-upload-marker-78\n"]),
      "notes.txt",
    );
    const readTurn = await turn(
      "使用 read 工具读取刚附带的 notes.txt，最后只回复该文本文件的内容。不要读取图片、搜索或使用子代理。",
      [note.id],
    );
    assert(readTurn.text.includes("workspace-upload-marker-78"));
    assert.deepEqual(
      readTurn.tools.map((t) => t.name),
      ["read"],
    );
    // Separate model choices and verify the physical effect, not merely a Tool name.
    const fileTurn = await turn(
      `只调用一次 bash，原样执行这个命令：printf '%s' 'changed' > ${JSON.stringify(source.path)} && wc -c < ${JSON.stringify(source.path)}。这是本验收创建的临时文件，要求覆盖它。完成后只回复命令输出，不要读取图片或调用其他工具。`,
    );
    assert.deepEqual(
      fileTurn.tools.map((t) => t.name),
      ["bash"],
    );
    assert(source.path.startsWith(session.workingDirectory + "/"));
    const changed = await api.readWorkspaceFile(
      session.sessionId,
      source.path.slice(session.workingDirectory.length + 1),
    );
    assert.equal(Buffer.from(changed.bytes).toString(), "changed");
    const retained = await api.readInputImage({ id: uploadId, sessionId: session.sessionId });
    assert.equal(createHash("sha256").update(retained.bytes).digest("hex"), source.image.sha256);
    report.mutableSourceChanged = true;
    const { rows: counts } =
      await sql`select count(*)::int n from runs where state in ('queued','running','settling','cancel_requested')`.execute(
        db,
      );
    assert.equal(counts[0].n, 0, "Cannot restart a Worker while another Run is active");
    const { rows: owners } =
      await sql`select supervisor_id,boot_id from workers where id=${fileTurn.run.workerId}::uuid`.execute(
        db,
      );
    await kubectlAsync(["delete", "pod", owners[0].supervisor_id, "--wait=true", "--timeout=120s"]);
    const recalled = await turn(
      "不调用任何工具，不读取文件。根据最早那张图片中的柱状图，只输出三个柱子从高到低的颜色英文名称，用逗号分隔。之前没有要求你回答过这个顺序，现在请看原始图片。",
    );
    assert.equal(recalled.tools.length, 0);
    assert.deepEqual(
      (recalled.text.match(/\b(BLUE|GREEN|ORANGE)\b/gi) ?? []).map((c) => c.toUpperCase()),
      order,
    );
    assert.notEqual(recalled.run.workerId, fileTurn.run.workerId);
    report.coldRecovery = {
      previousWorker: fileTurn.run.workerId,
      nextWorker: recalled.run.workerId,
      unseenVisualAttributeCorrect: true,
    };
  }
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  try {
    if (
      api &&
      active &&
      !["completed", "failed", "cancelled", "timed_out"].includes(
        (await api.getRun(active.runId)).state,
      )
    ) {
      await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("cancel"));
      await until(
        async () =>
          ["completed", "failed", "cancelled", "timed_out"].includes(
            (await api.getRun(active.runId)).state,
          ),
        "Cancelled Run",
      );
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    if (session) await api.deleteConversation(session.sessionId);
  } catch (error) {
    errors.push(error);
  }
  try {
    if (development)
      await api.developmentEnvironmentAction(
        development.environmentId,
        "release",
        newIdempotencyKey("release"),
      );
    else if (project) await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
  } catch (error) {
    errors.push(error);
  }
  try {
    if (tenant)
      await db
        .updateTable("tenant_api_credentials")
        .set({ revoked_at: new Date() })
        .where("credential_id", "=", tenant.credential.credentialId)
        .execute();
  } catch (error) {
    errors.push(error);
  }
  await rm(directory, { recursive: true, force: true });
  report.cleanupRequested = errors.length === 0;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-user-uploads-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "User upload acceptance failed",
    );
}
console.log(JSON.stringify(report));
