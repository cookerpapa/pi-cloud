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
const runtimeRevision = JSON.parse(
  await readFile(`${runtimeDirectory}/k3s/deployment.json`, "utf8"),
).revision;
const report = { sourceRevision, runtimeRevision, cases: [], cleanupConfirmed: false };
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
  sample.tools = replies.map((message) => ({
    name: message.toolName,
    isError: message.isError,
    ...(message.isError
      ? {
          error: message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .slice(0, 4096),
        }
      : {}),
  }));
  sample.skillCalls = nativeMessages(rows).flatMap((message) =>
    message.role === "assistant"
      ? message.content
          .filter((block) => block.type === "toolCall" && block.name === "read_skill")
          .map((block) => block.arguments)
      : [],
  );
  sample.skillSections = nativeMessages(rows)
    .filter((message) => message.role === "system" && message.sections?.skills)
    .map((message) => message.sections.skills);
  await save();
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
  const pureVersion = await api.importSkill({
    label: "text-v1",
    requirements: { runtime: "none", tools: [], software: [] },
    source: {
      kind: "files",
      files: [
        {
          path: "SKILL.md",
          base64: Buffer.from(
            "---\nname: team-review-format\ndescription: Use when asked for the team's review format without reading project files.\n---\nWhen using the team review format, answer with the exact marker SKILL_TEXT_OK and one brief sentence.\n",
          ).toString("base64"),
        },
      ],
    },
  });
  await api.installSkill(pureVersion.packageId, {
    scope: { kind: "personal" },
    versionId: pureVersion.versionId,
    enabled: true,
    revision: null,
  });
  const pure = await run("按已安装的团队评审格式给出一句简短结论，不查看工作区或执行命令。", [
    "read_skill",
  ]);
  const initialRows = await nativeHistory(db, { tenantId: tenant.tenantId, runId: pure.runId });
  const initialMessages = nativeMessages(initialRows);
  const systems = initialMessages.filter((message) => message.role === "system");
  assert(
    systems.some((message) => JSON.stringify(message).includes(pureVersion.versionId)),
    "Skill directory was missing from native system context",
  );
  assert(
    systems.every((message) => !JSON.stringify(message).includes("SKILL_TEXT_OK")),
    "Full Skill instructions were eagerly included in the system prompt",
  );
  const calls = initialMessages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter((block) => block.type === "toolCall")
      : [],
  );
  assert(calls.some((call) => call.name === "read_skill" && call.arguments.action === "read"));
  assert(
    calls.every((call) => call.name !== "read_skill" || call.arguments.action !== "list"),
    "Skill activation still required a discovery call",
  );
  assert(
    initialMessages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some(
          (block) => block.type === "text" && block.text.includes("SKILL_TEXT_OK"),
        ),
    ),
  );
  report.nativeCatalogAdvertised = true;
  const allocated = await db
    .selectFrom("workspace_runtimes")
    .select("workspace_id")
    .where("tenant_id", "=", tenant.tenantId)
    .execute();
  assert.equal(allocated.length, 0, "Instruction-only reading started a VM");
  report.textOnlyWithoutVm = true;
  const exampleFiles = await Promise.all(
    ["SKILL.md", "scripts/inspect.mjs", "references/verification.md"].map(async (path) => ({
      path,
      base64: (await readFile(resolve("examples/skills/workspace-readiness", path))).toString(
        "base64",
      ),
    })),
  );
  const first = await api.importSkill({
    label: "local-v1",
    requirements: { tools: ["bash", "read"], runtime: "linux", software: ["node"] },
    source: { kind: "files", files: exampleFiles },
  });
  const installed = await api.installSkill(first.packageId, {
    scope: { kind: "personal" },
    versionId: first.versionId,
    enabled: true,
    revision: null,
  });
  const execution = await run(
    "使用已安装的工作区就绪检查技能，执行其只读检查脚本并简短汇报结果，不安装软件。",
    ["read_skill", "bash"],
  );
  report.automaticExecutionFiles = true;
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
    "再次使用工作区就绪检查 Skill，读取并报告说明末尾的版本标记。本轮不用运行检查脚本。",
    ["read_skill"],
    "steer",
  );
  const latestMessages = nativeMessages(
    await nativeHistory(db, { tenantId: tenant.tenantId, runId: latest.runId }),
  );
  assert(
    latestMessages.some(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "read_skill" &&
        JSON.stringify(message.content).includes("SKILL_VERSION_TWO"),
    ),
    "Named activation did not read the current version",
  );
  const selections =
    await sql`select run_id,versions from run_skill_catalogs where run_id in (${pure.runId}::uuid,${execution.runId}::uuid,${latest.runId}::uuid)`.execute(
      db,
    );
  assert.deepEqual(selections.rows.find((row) => row.run_id === pure.runId).versions, [
    pureVersion.versionId,
  ]);
  assert.deepEqual(
    new Set(selections.rows.find((row) => row.run_id === execution.runId).versions),
    new Set([pureVersion.versionId, first.versionId]),
  );
  assert.deepEqual(
    new Set(selections.rows.find((row) => row.run_id === latest.runId).versions),
    new Set([pureVersion.versionId, second.versionId]),
  );
  const publishedName = `agent-workflow-${randomUUID().slice(0, 8)}`;
  const published = await run(
    `在 /workspace/skills/${publishedName} 创建一个 Skill：SKILL.md 使用 name: ${publishedName}，description 写清楚用于展示已验证的工作流；配套 scripts/check.mjs 仅打印 AGENT_SKILL_SCRIPT_OK。先运行这个脚本验证，再用 publish_skill 将目录分享到组织。不要替任何人安装，不要复制已有Skill。`,
    ["publish_skill", "bash"],
  );
  const market = await api.listSkills();
  const authored = market.packages.find((pack) => pack.versions[0]?.name === publishedName);
  assert(authored, "Agent publication was not visible in the organization");
  assert.equal(authored.ownerUserId, tenant.ownerUserId);
  assert.equal(authored.installations.length, 0);
  const authoredContent = await api.exportSkill(authored.versions[0].versionId);
  assert(authoredContent.files.some((file) => file.path === "scripts/check.mjs"));
  await run(
    `用 inspect_skill 查找组织中的 ${publishedName}，然后用 publish_skill 再次发布同一个 /workspace/skills/${publishedName} 目录，requirements 必须为 ${JSON.stringify(authored.versions[0].requirements)}。不要编辑任何文件，不要安装。`,
    ["inspect_skill", "publish_skill"],
  );
  const repeated = (await api.listSkills()).packages.find(
    (pack) => pack.packageId === authored.packageId,
  );
  assert.equal(repeated.versions.length, 1);
  assert.equal(repeated.versions[0].versionId, authored.versions[0].versionId);
  report.agentPublication = {
    runId: published.runId,
    packageId: authored.packageId,
    versionId: authored.versions[0].versionId,
    deduplicated: true,
  };
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
