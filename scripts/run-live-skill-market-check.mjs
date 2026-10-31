import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";
import { nativeHistory, nativeMessages } from "./lib/native-session-history.mjs";

if (process.env.PI_CLOUD_LIVE_SKILLS_CHECK !== "1")
  throw Error("Set PI_CLOUD_LIVE_SKILLS_CHECK=1 for an owned real Luna/Cube Skill check");
const output = resolve(process.argv[2] ?? `${runtimeDirectory}/acceptance/skills.json`);
await mkdir(dirname(output), { recursive: true });
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const url = new URL((await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim());
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const report = { sourceRevision, cases: [], cleanupConfirmed: false };
const save = () => writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
async function until(check, label, ms = 240000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(300);
  }
  throw Error(`${label} did not settle`);
}
let tenant, api, project, session, failure;
const settled = async (id) =>
  until(async () => {
    const row = await db
      .selectFrom("runs")
      .select(["state", "lease_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return terminal(row.state) && (!row.lease_id || row.output_sealed_at);
  }, "Run closure");
async function run(prompt, expectedTools, whenBusy = "follow_up") {
  const start = performance.now();
  const accepted = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("skills"),
    "low",
    undefined,
    whenBusy,
  );
  assert.equal(accepted.kind, "run");
  const sample = { runId: accepted.runId, ackMs: performance.now() - start, whenBusy };
  report.cases.push(sample);
  await save();
  const result = await until(async () => {
    const r = await api.getRun(accepted.runId);
    return terminal(r.state) && r;
  }, "Model Run");
  sample.state = result.state;
  sample.elapsedMs = performance.now() - start;
  await save();
  assert.equal(result.state, "completed", result.failure?.message);
  await settled(accepted.runId);
  const rows = await nativeHistory(db, { tenantId: tenant.tenantId, runId: accepted.runId });
  const replies = nativeMessages(rows).filter((message) => message.role === "toolResult");
  sample.tools = replies.map((message) => ({ name: message.toolName, isError: message.isError }));
  for (const tool of expectedTools)
    assert(
      sample.tools.some((v) => v.name === tool && !v.isError),
      `Missing successful ${tool}`,
    );
  assert(
    sample.tools.every((v) => !v.isError),
    "Skill acceptance had a failed Tool",
  );
  await save();
  return accepted;
}
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-skills-${randomUUID()}`,
    ownerDisplayName: "Skill acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  const base = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), base), init),
    tenant.credential.token,
  );
  project = await api.createProject("Skill acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Skill acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.resources = { tenantId: tenant.tenantId, sessionId: session.sessionId };
  await save();
  const first = await api.importSkill({
    label: "live-git",
    requirements: { tools: ["bash", "read"], runtime: "linux", software: ["node"] },
    source: {
      kind: "github",
      repository: "cookerpapa/pi-cloud",
      ref: sourceRevision,
      path: "examples/skills/workspace-readiness",
    },
  });
  assert.equal(first.source.commit, sourceRevision);
  const installed = await api.installSkill(first.packageId, {
    scope: { kind: "personal" },
    versionId: first.versionId,
    enabled: true,
    revision: null,
  });
  const pure = await run(
    "使用 read_skill 的 list 查找 workspace-readiness，再用 read_skill 阅读它的 SKILL.md。本轮只读取说明，不准备 Workspace，不调用 bash/read/prepare_skill。最后简短回复 SKILL_TEXT_OK。",
    ["read_skill"],
  );
  const allocated = await db
    .selectFrom("workspace_runtimes")
    .select("id")
    .where("tenant_id", "=", tenant.tenantId)
    .execute();
  assert.equal(allocated.length, 0, "Instruction-only reading started a VM");
  report.textOnlyWithoutVm = true;
  await run(
    "使用刚安装的 workspace-readiness Skill：调用 read_skill list 取得本轮固定版本，调用 prepare_skill 复制文件，然后用 bash 执行返回目录中的 scripts/inspect.mjs（node 命令，cwd 为当前 Workspace）。不要写文件或安装软件。最后简短报告输出。",
    ["read_skill", "prepare_skill", "bash"],
  );
  const content = await api.exportSkill(first.versionId);
  const files = content.files.map((file) =>
    file.path === "SKILL.md"
      ? {
          ...file,
          base64: Buffer.from(
            Buffer.from(file.base64, "base64").toString("utf8") +
              "\nVersion two marker: SKILL_VERSION_TWO\n",
          ).toString("base64"),
        }
      : file,
  );
  const second = await api.importSkill({
    packageId: first.packageId,
    label: "live-v2",
    requirements: first.requirements,
    source: { kind: "files", files },
  });
  await api.installSkill(first.packageId, { ...installed, versionId: second.versionId });
  const latest = await run(
    "使用 read_skill list 查询本轮版本，再用 read_skill 阅读 workspace-readiness 的 SKILL.md，报告末尾版本标记。无需 prepare_skill 或其他工具。",
    ["read_skill"],
    "steer",
  );
  const selections =
    await sql`select run_id,versions from run_skill_catalogs where run_id in (${pure.runId}::uuid,${latest.runId}::uuid)`.execute(
      db,
    );
  assert.deepEqual(selections.rows.find((row) => row.run_id === pure.runId).versions, [
    first.versionId,
  ]);
  assert.deepEqual(selections.rows.find((row) => row.run_id === latest.runId).versions, [
    second.versionId,
  ]);
  report.versionSelectionPreserved = true;
  report.idleSteerStartsRun = true;
  await save();
} catch (error) {
  failure = error;
  report.failure = { name: error.name, message: error.message };
} finally {
  try {
    if (api && session) {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settled);
      await api.deleteConversation(session.sessionId);
    }
    if (api && project) {
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
        "Physical Workspace purge",
      );
    }
    if (tenant) {
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(`${runtimeDirectory}/secrets/session-image-s3-credentials.json`, "utf8"),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
        report.cleanupConfirmed = true;
      } finally {
        blobs.close();
      }
    }
  } catch (error) {
    report.cleanupFailure = { name: error.name, message: error.message };
    failure ??= error;
  }
  await save();
  await db.destroy();
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
