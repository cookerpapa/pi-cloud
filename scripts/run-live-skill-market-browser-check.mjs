import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createDatabase } from "../packages/database/src/index.ts";
import {
  createPrivateTenant,
  issuePrivateTenantCredential,
} from "../packages/control-plane/src/tenant-administration.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";
if (process.env.PI_CLOUD_LIVE_SKILL_BROWSER_CHECK !== "1")
  throw Error(
    "Set PI_CLOUD_LIVE_SKILL_BROWSER_CHECK=1 for owned organization Skill browser acceptance",
  );
const output = resolve(process.argv[2] ?? `${runtimeDirectory}/acceptance/skill-browser.json`);
await mkdir(dirname(output), { recursive: true });
const endpoint = new URL(
  (await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 }),
  base = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  accepted: false,
  cleanupCompleted: false,
  cases: [],
};
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const apiFor = (token) =>
  new PiCloudApi(
    (path, init = {}) =>
      fetch(new URL(String(path), base), {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30000),
      }),
    token,
  );
let tenant, failure;
try {
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-skill-ui-${randomUUID().slice(0, 8)}`,
    ownerDisplayName: "Skill UI owner",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  const memberId = randomUUID();
  await db
    .insertInto("users")
    .values({ id: memberId, tenant_id: tenant.tenantId, display_name: "Skill UI member" })
    .execute();
  const member = await issuePrivateTenantCredential(db, {
    tenant: tenant.tenantId,
    userId: memberId,
    label: "Skill UI acceptance",
    role: "member",
  });
  const ownerApi = apiFor(tenant.credential.token),
    memberApi = apiFor(member.token);
  const name = `team-check-${randomUUID().slice(0, 8)}`;
  let pack, firstVersion, latestVersion;
  report.resources = { tenantId: tenant.tenantId, memberId };
  await save();
  async function browser(token, work) {
    await withChromePage({}, async (page) => {
      await page.send("Network.setExtraHTTPHeaders", {
        headers: { Authorization: "Bearer " + token },
      });
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: "localStorage.setItem('pi-cloud:ui-language','zh-CN')",
      });
      const open = async () => {
        await page.navigate(base);
        await page.waitFor(
          "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Skills'))",
        );
        await page.evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Skills')).click()",
        );
        await page.waitFor(
          "document.querySelector('.skill-market') && !document.querySelector('.skill-loading')",
        );
      };
      const click = (text, root = "document") =>
        page.evaluate(
          `[...${root}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`,
        );
      const fill = async (text) => {
        await page.evaluate(
          "document.querySelector('dialog textarea').focus();document.querySelector('dialog textarea').select()",
        );
        await page.send("Input.insertText", { text });
      };
      const scope = (value) =>
        page.evaluate(
          `(()=>{const e=document.querySelector('dialog select[aria-label="使用范围"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
      const details = async () => {
        await page.evaluate(
          `document.querySelector('[data-skill="${name}"] .skill-card-content').click()`,
        );
        await page.waitFor("document.querySelector('.skill-preview')");
      };
      await open();
      await work({ page, click, fill, scope, details, open });
    });
  }
  await browser(tenant.credential.token, async ({ page, click, fill, scope, details }) => {
    await click("＋ 分享 Skill");
    await page.waitFor("document.querySelector('dialog textarea')");
    await fill(
      `---\nname: ${name}\ndescription: 团队检查流程\n---\n\n# 团队检查\n\n先阅读任务，再检查项目约定。\n`,
    );
    await click("分享到组织");
    await page.waitFor(
      `!document.querySelector('dialog') && document.querySelector('[data-skill="${name}"]')`,
    );
    pack = (await ownerApi.listSkills()).packages.find((p) => p.versions[0].name === name);
    assert(pack);
    firstVersion = pack.versions[0].versionId;
    await details();
    await scope("tenant");
    await click("安装", "document.querySelector('dialog')");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='已启用'");
    await page.evaluate("document.querySelector('.skill-more').open=true");
    await click("分享新版本");
    await page.waitFor("document.querySelector('dialog textarea')");
    await fill(
      `---\nname: ${name}\ndescription: 团队检查流程第二版\n---\n\n# 团队检查第二版\n\n检查后附上验证结果。\n`,
    );
    await click("分享到组织");
    await page.waitFor(
      "!document.querySelector('dialog') && !document.querySelector('.skill-loading')",
    );
    pack = (await ownerApi.listSkills()).packages.find((p) => p.packageId === pack.packageId);
    latestVersion = pack.versions[0].versionId;
    assert.notEqual(latestVersion, firstVersion);
    assert.equal(pack.installations.find((i) => i.scope.kind === "tenant").versionId, firstVersion);
    await page.screenshot(resolve(dirname(output), "organization-skills.png"));
    report.cases.push(
      "owner publishes locally and shared installation retains its selected version",
    );
    await save();
  });
  await browser(member.token, async ({ page, click, scope, details, open }) => {
    await page.waitFor(`document.querySelector('[data-skill="${name}"]')`);
    await details();
    assert.equal(
      await page.evaluate("document.querySelector('dialog select[aria-label=使用范围]').value"),
      "tenant",
    );
    assert.equal(
      await page.evaluate("document.querySelector('dialog .skill-primary').disabled"),
      true,
    );
    assert.equal(
      await page.evaluate(
        "document.querySelector('.skill-preview').textContent.includes('先阅读任务')",
      ),
      true,
    );
    await scope("personal");
    await click("安装", "document.querySelector('dialog')");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='已启用'");
    const installed = (await memberApi.listSkills()).packages.find(
      (p) => p.packageId === pack.packageId,
    );
    assert.equal(
      installed.installations.find((i) => i.scope.kind === "personal").versionId,
      latestVersion,
    );
    assert.equal(
      installed.installations.find((i) => i.scope.kind === "tenant").versionId,
      firstVersion,
    );
    assert.equal(
      (await ownerApi.listSkills()).packages
        .find((p) => p.packageId === pack.packageId)
        .installations.some((i) => i.scope.kind === "personal"),
      false,
    );
    await open();
    await click("已安装", "document.querySelector('.skill-market-toolbar')");
    await page.waitFor(
      `document.querySelector('[data-skill="${name}"]') && !document.querySelector('.skill-loading')`,
    );
    await details();
    assert.equal(
      await page.evaluate(
        "document.querySelector('.skill-preview').textContent.includes('检查后附上验证结果')",
      ),
      true,
    );
    await click("停用");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='启用'");
    await click("启用");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='已启用'");
    await page.evaluate("document.querySelector('.skill-more').open=true");
    await click("卸载");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='安装'");
    const remaining = (await memberApi.listSkills()).packages.find(
      (p) => p.packageId === pack.packageId,
    ).installations;
    assert.deepEqual(
      remaining.map((i) => i.scope.kind),
      ["tenant"],
    );
    report.cases.push(
      "colleague previews shared instructions, installs independently, reloads, disables, enables and removes only the personal installation",
    );
    await save();
  });
  assert.equal(
    (await db.selectFrom("runs").select("id").where("tenant_id", "=", tenant.tenantId).execute())
      .length,
    0,
  );
  assert.equal(
    (
      await db
        .selectFrom("workspaces")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute()
    ).length,
    0,
  );
  report.accepted = true;
} catch (cause) {
  failure = cause;
  report.failure = cause instanceof Error ? cause.message : String(cause);
} finally {
  const errors = [];
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
      report.cleanupCompleted = true;
    } catch (cause) {
      errors.push(cause);
    } finally {
      blobs.close();
    }
  }
  await db.destroy();
  await save();
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "Skill browser acceptance failed",
    );
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    cases: report.cases.length,
    cleanupCompleted: report.cleanupCompleted,
  }),
);
