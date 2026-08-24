import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (process.env.PI_CLOUD_LIVE_BROWSER_UI_CHECK !== "1") {
  throw new Error("Set PI_CLOUD_LIVE_BROWSER_UI_CHECK=1 to acknowledge real model and Cube usage");
}

function parseEnvironment(value) {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error("Production environment file is invalid");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environment = parseEnvironment(await readFile(resolve(runtimeDirectory, ".env"), "utf8"));
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

class BrowserCookieFetch {
  #cookie;

  fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (this.#cookie !== undefined) headers.set("cookie", this.#cookie);
    const response = await fetch(new URL(String(input), baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(300_000),
    });
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const match = /(?:^|[,;]\s*)(pi_cloud_session=[^;]*)/.exec(value);
      if (match !== null) this.#cookie = match[1];
    }
    return response;
  };
}

async function waitFor(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined && result !== false && result !== null) return result;
    await wait(150);
  }
  throw new Error(`${label} timed out`);
}

const suffix = Date.now().toString(36);
const username = `browser.acceptance.${suffix}`.slice(0, 48);
const password = `Browser acceptance ${suffix} 9!`;
const cookieFetch = new BrowserCookieFetch();
const api = new PiCloudApi(cookieFetch.fetch);
await api.registerAccount(username, "Browser Acceptance", password);

const clicked = [];
const record = (name) => {
  clicked.push(name);
  process.stdout.write(`[browser-ui-check] ${name}\n`);
};
const screenshotPath = resolve("/tmp", "pi-cloud-browser-ui-latest.png");
const transcriptScreenshotPath = resolve("/tmp", "pi-cloud-browser-ui-transcript-latest.png");
const directoryScreenshotPath = resolve("/tmp", "pi-cloud-directory-picker-latest.png");

function selectorExpression(selector) {
  return `document.querySelector(${JSON.stringify(selector)})`;
}

let acceptanceError;
try {
  await withChromePage(
    { profilePrefix: "pi-cloud-browser-ui-", width: 1_440, height: 960 },
    async (page) => {
      async function click(selector, name) {
        const clickedElement = await page.evaluate(
          `(()=>{const element=${selectorExpression(selector)};if(!element)return false;element.click();return true})()`,
        );
        assert.equal(clickedElement, true, `${name} button was unavailable`);
        record(name);
      }

      async function clickText(selector, text, name) {
        const clickedElement = await page.evaluate(
          `(()=>{const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(candidate=>candidate.textContent.includes(${JSON.stringify(text)}));if(!element)return false;element.click();return true})()`,
        );
        assert.equal(clickedElement, true, `${name} button was unavailable`);
        record(name);
      }

      async function setValue(selector, value) {
        const changed = await page.evaluate(
          `(()=>{const element=${selectorExpression(selector)};if(!element)return false;element.focus();const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,${JSON.stringify(value)});element.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:${JSON.stringify(value)}}));element.dispatchEvent(new Event("change",{bubbles:true}));return element.value===${JSON.stringify(value)}})()`,
        );
        assert.equal(changed, true, `Could not set ${selector}`);
        await page.wait(50);
      }

      await page.navigate(baseUrl.toString(), 800);
      await page.evaluate('localStorage.setItem("pi-cloud:ui-language","zh-CN")');
      await page.send("Page.reload", { ignoreCache: true });
      await page.waitFor('document.querySelector(".product-auth-card")');
      await clickText(".product-auth-tabs button", "注册", "auth.registerTab");
      await page.waitFor('document.querySelector("input[autocomplete=name]")');
      await clickText(".product-auth-tabs button", "登录", "auth.loginTab");
      await setValue('input[autocomplete="username"]', username);
      await setValue('input[type="password"]', password);
      await click('.product-auth-card button[type="submit"]', "auth.login");
      await page.waitFor('document.querySelector(".product-shell")', 30_000);
      const brandVisible = await page.evaluate(
        'document.querySelector(".product-sidebar-brand")?.textContent.includes("πPiCloud")===true',
      );
      assert.equal(brandVisible, true, "PiCloud sidebar brand was unavailable");
      record("sidebar.brand");

      await page.evaluate(
        `(()=>{const select=document.querySelector(".product-account .product-language-select");select.value="en-US";select.dispatchEvent(new Event("change",{bubbles:true}))})()`,
      );
      await page.waitFor('document.body.innerText.includes("New chat")');
      record("account.languageEnglish");
      await page.evaluate(
        `(()=>{const select=document.querySelector(".product-account .product-language-select");select.value="zh-CN";select.dispatchEvent(new Event("change",{bubbles:true}))})()`,
      );
      await page.waitFor('document.body.innerText.includes("新对话")');
      record("account.languageChinese");

      await click(".product-sidebar > .product-panel-collapse", "sidebar.collapse");
      await click(".product-sidebar > .product-panel-collapse", "sidebar.expand");
      await click(".product-tree-panel > .product-panel-collapse", "tree.collapse");
      await click(".product-tree-panel > .product-panel-collapse", "tree.expand");

      await click(".product-new-chat", "conversation.new");
      await page.waitFor('document.querySelector(".product-workspace-modal")');
      await click(
        '.product-execution-mode-choice input[type="radio"]:first-of-type',
        "conversation.elasticMode",
      );
      await setValue(".product-progressive-options > label input", `UI acceptance ${suffix}`);
      await setValue('input[placeholder*="order-service"]', `ui-workspace-${suffix}`);
      await click(
        ".product-resource-profiles button:last-child",
        "conversation.performanceProfile",
      );
      await click(".product-workspace-modal footer .product-primary-button", "conversation.create");
      await page.waitFor('!document.querySelector(".product-workspace-modal")', 60_000);
      await page.waitFor(
        `document.body.innerText.includes(${JSON.stringify(`UI acceptance ${suffix}`)})`,
      );

      await setValue(
        ".product-composer textarea",
        "Do not call tools. Reply with exactly BROWSER-UI-CHAT-OK.",
      );
      await page.waitFor('!document.querySelector(".product-send-button").disabled');
      await click(".product-send-button", "composer.send");
      await page.waitFor(
        '[...document.querySelectorAll(".product-agent-answer")].some(element=>element.innerText.includes("BROWSER-UI-CHAT-OK"))',
        180_000,
      );
      const elasticConversation = await waitFor(
        async () =>
          (await api.listConversations()).conversations.find(
            (candidate) => candidate.title === `UI acceptance ${suffix}`,
          ),
        "elastic conversation",
      );
      await waitFor(
        async () => {
          const runs = await api.listRuns(elasticConversation.sessionId);
          return runs.runs.at(-1)?.state === "completed";
        },
        "completed browser-submitted Run",
        180_000,
      );

      await setValue(
        ".product-composer textarea",
        "Use bash exactly once to run sleep 8. Then reply exactly OLD-BROWSER-UI-STEER.",
      );
      await page.waitFor('!document.querySelector(".product-send-button").disabled');
      await click(".product-send-button", "composer.sendForSteer");
      await page.waitFor('document.querySelector(".product-steer-button")', 60_000);
      await setValue(
        ".product-composer textarea",
        "Replace the final reply with exactly BROWSER-UI-STEER-OK.",
      );
      await click(".product-steer-button", "composer.steer");
      await page.waitFor(
        '[...document.querySelectorAll(".product-agent-answer")].some(element=>element.innerText.includes("BROWSER-UI-STEER-OK"))',
        180_000,
      );
      await page.waitFor('!document.querySelector(".product-stop-button")');
      await page.waitFor(
        '[...document.querySelectorAll(".product-tool[data-tool-name=bash] code")].some(element=>element.textContent.includes("sleep 8"))',
      );
      const piStyleTranscript = await page.evaluate(
        'document.querySelectorAll(".product-avatar").length===0 && document.querySelectorAll(".product-tool[data-tool-name=bash]").length===1',
      );
      assert.equal(piStyleTranscript, true, "Pi-style transcript renderer was not active");
      record("transcript.piStyleToolRenderer");
      await page.screenshot(transcriptScreenshotPath);

      await setValue(
        ".product-composer textarea",
        "Use bash exactly once to run sleep 60, then report completion.",
      );
      await page.waitFor('!document.querySelector(".product-send-button").disabled');
      await click(".product-send-button", "composer.sendForStop");
      await page.waitFor('document.querySelector(".product-stop-button")', 60_000);
      await click(".product-stop-button", "composer.stop");
      await page.waitFor(
        '[...document.querySelectorAll(".product-muted-line,.product-turn-error")].some(element=>element.innerText.includes("停止")||element.innerText.includes("失败"))',
        90_000,
      );

      await page.evaluate("window.confirm=()=>true");
      await click(
        ".product-turn:first-child .product-prune-action",
        "conversation.pruneLaterTurns",
      );
      await page.waitFor('document.querySelectorAll(".product-turn").length===1', 60_000);

      await clickText(".product-tree-view-switch button", "整棵树", "tree.full");
      await clickText(".product-tree-view-switch button", "当前分支", "tree.focus");

      await click(".product-topbar-actions button:last-child", "workspace.open");
      await page.waitFor('document.querySelector(".workspace-directory")');
      await click('.workspace-directory-header button[title="刷新目录"]', "workspace.refresh");
      await clickText(".workspace-view-tabs button", "终端", "workspace.terminalTab");
      await page.waitFor(
        '[...document.querySelectorAll(".workspace-terminal-toolbar button")].some(element=>element.textContent.includes("连接终端"))',
        30_000,
      );
      await clickText(
        ".workspace-terminal-toolbar button",
        "连接终端",
        "workspace.terminalConnect",
      );
      await page.waitFor('document.body.innerText.includes("已连接 · /workspace")', 90_000);
      await clickText(".workspace-terminal-toolbar button", "断开", "workspace.terminalDisconnect");
      await clickText(".workspace-view-tabs button", "文件", "workspace.filesTab");
      await click('.workspace-directory-header button[title="关闭"]', "workspace.close");

      await click(".product-answer-actions button:first-child", "conversation.forkOpen");
      await page.waitFor('document.querySelector(".product-fork-modal")');
      await setValue(".product-fork-modal input", `UI fork ${suffix}`);
      await click(".product-fork-modal .product-primary-button", "conversation.forkCreate");
      await page.waitFor('!document.querySelector(".product-fork-modal")', 60_000);
      await page.waitFor(
        `document.body.innerText.includes(${JSON.stringify(`UI fork ${suffix}`)})`,
      );
      await page.waitFor(
        'document.querySelector(".product-conversation-row.active .product-delete-conversation")?.disabled===false',
      );
      await click(
        ".product-conversation-row.active .product-delete-conversation",
        "conversation.deleteFork",
      );
      await page.waitFor(
        `!document.body.innerText.includes(${JSON.stringify(`UI fork ${suffix}`)})`,
      );

      await click(".product-resource-nav", "resources.open");
      await page.waitFor('document.querySelector(".product-resource-page")');
      await clickText(".product-resource-tabs button", "独享环境", "resources.exclusiveTab");
      await click(".product-resource-create .product-primary-button", "resources.createExclusive");
      const development = await waitFor(
        async () => {
          const environments = (await api.listDevelopmentEnvironments()).environments;
          return environments.find((candidate) => candidate.state === "running");
        },
        "UI-created exclusive environment",
        120_000,
      );
      await page.waitFor('document.querySelector(".product-environment-card")', 120_000);
      await page.waitFor(
        '[...document.querySelectorAll(".product-environment-card button")].some(button=>button.textContent.includes("暂停"))',
        30_000,
      );
      await clickText(".product-environment-card button", "暂停", "resources.pauseExclusive");
      await waitFor(
        async () =>
          (await api.listDevelopmentEnvironments()).environments.find(
            (candidate) =>
              candidate.environmentId === development.environmentId && candidate.state === "paused",
          ),
        "paused environment",
      );
      await page.waitFor('document.body.innerText.includes("已暂停")');
      await page.waitFor(
        '[...document.querySelectorAll(".product-environment-card button")].some(button=>button.textContent.includes("恢复"))',
      );
      await clickText(".product-environment-card button", "恢复", "resources.resumeExclusive");
      await waitFor(
        async () =>
          (await api.listDevelopmentEnvironments()).environments.find(
            (candidate) =>
              candidate.environmentId === development.environmentId &&
              candidate.state === "running",
          ),
        "resumed environment",
      );
      await clickText(".product-resource-tabs button", "Workspace", "resources.workspaceTab");
      await click(".product-resource-back", "resources.back");
      await page.waitFor('document.querySelector(".product-shell")');

      await click(".product-new-chat", "conversation.newExclusive");
      await clickText(
        ".product-execution-mode-choice .product-choice-card",
        "独享运行环境",
        "conversation.exclusiveMode",
      );
      await setValue(".product-progressive-options > label input", `UI exclusive ${suffix}`);
      await click(".product-working-directory-choice button", "conversation.directoryPicker");
      await page.waitFor('document.querySelector(".product-directory-picker")');
      await page.waitFor(
        'document.querySelector(".product-directory-new-folder")?.disabled===false',
        30_000,
      );
      await click(".product-directory-new-folder", "directory.newFolder");
      await page.waitFor('document.querySelector(".product-directory-create input")');
      await setValue(".product-directory-create input", `ui-project-${suffix}`);
      await click(".product-directory-create .product-primary-button", "directory.createFolder");
      await page.waitFor(
        `[...document.querySelectorAll(".product-directory-entry[aria-selected=true] strong")].some(element=>element.textContent.includes(${JSON.stringify(`ui-project-${suffix}`)}))`,
        30_000,
      );
      await page.screenshot(directoryScreenshotPath);
      await click(
        ".product-directory-picker > footer .product-primary-button",
        "directory.chooseCreatedFolder",
      );
      await page.waitFor('!document.querySelector(".product-directory-picker")');
      await click(
        ".product-workspace-modal footer .product-primary-button",
        "conversation.createExclusive",
      );
      await page.waitFor('!document.querySelector(".product-workspace-modal")', 60_000);
      await page.waitFor(
        `document.body.innerText.includes(${JSON.stringify(`UI exclusive ${suffix}`)})`,
      );

      await page.waitFor(
        '[...document.querySelectorAll(".product-environment-controls button")].some(button=>button.textContent.includes("SSH")&&!button.disabled)',
      );
      await clickText(".product-environment-controls button", "SSH", "ssh.open");
      await page.waitFor('document.querySelector(".product-ssh-ticket-modal")', 30_000);
      await clickText(".product-ssh-ticket-modal footer button", "复制一行命令", "ssh.copyCommand");
      await clickText(".product-ssh-ticket-modal footer button", "复制密码", "ssh.copyPassword");
      await click(".product-ssh-ticket-modal header button", "ssh.close");

      await page.screenshot(screenshotPath);
      await click(".product-resource-nav", "resources.reopen");
      await clickText(".product-resource-tabs button", "独享环境", "resources.exclusiveTabAgain");
      await page.waitFor('document.querySelector(".product-environment-card")');
      await clickText(".product-environment-card button", "释放", "resources.releaseExclusive");
      await waitFor(
        async () =>
          !(await api.listDevelopmentEnvironments()).environments.some(
            (candidate) =>
              candidate.environmentId === development.environmentId &&
              candidate.state !== "released",
          ),
        "released environment",
      );
      await click(".product-resource-back", "resources.finalBack");
      await page.waitFor('document.querySelector(".product-shell")');
      await click(
        ".product-conversation-row.active .product-delete-conversation",
        "conversation.deleteExclusive",
      );
      await page.waitFor(
        `!document.body.innerText.includes(${JSON.stringify(`UI exclusive ${suffix}`)})`,
      );
      await clickText(
        ".product-conversation-row > button:first-child",
        `UI acceptance ${suffix}`,
        "conversation.openElasticForDelete",
      );
      await page.waitFor(
        `[...document.querySelectorAll(".product-conversation-row.active strong")].some(element=>element.innerText.includes(${JSON.stringify(`UI acceptance ${suffix}`)}))`,
      );
      await click(
        ".product-conversation-row.active .product-delete-conversation",
        "conversation.deleteElastic",
      );
      await page.waitFor(
        `!document.body.innerText.includes(${JSON.stringify(`UI acceptance ${suffix}`)})`,
      );
      await click(".product-resource-nav", "resources.cleanupOpen");
      await page.waitFor('document.querySelector(".product-resource-page")');
      await page.waitFor(
        'document.querySelectorAll(".product-resource-card .product-danger-button").length>=2',
        60_000,
      );
      for (
        let remaining = await page.evaluate(
          'document.querySelectorAll(".product-resource-card .product-danger-button").length',
        );
        remaining > 0;
        remaining -= 1
      ) {
        await click(
          ".product-resource-card .product-danger-button",
          `resources.deleteWorkspace${String(remaining)}`,
        );
        await page.waitFor(
          `document.querySelectorAll(".product-resource-card .product-danger-button").length<${String(remaining)}`,
          60_000,
        );
      }
      await click(".product-resource-back", "resources.cleanupBack");
      await click('.product-account button[aria-label="退出登录"]', "account.logout");
      await page.waitFor('document.querySelector(".product-auth-card")');
    },
  );
} catch (error) {
  acceptanceError = error;
}

const remainingConversations = (await api.listConversations()).conversations;
for (const conversation of remainingConversations) {
  await api
    .deleteConversation(conversation.sessionId, newIdempotencyKey("delete"))
    .catch(() => undefined);
}
for (const development of (await api.listDevelopmentEnvironments()).environments) {
  if (development.state === "released") continue;
  await api
    .developmentEnvironmentAction(
      development.environmentId,
      "release",
      newIdempotencyKey("environment"),
    )
    .catch(() => undefined);
}
for (const workspace of (await api.listWorkspaces()).workspaces) {
  await api
    .deleteWorkspace(workspace.workspaceId, newIdempotencyKey("delete"))
    .catch(() => undefined);
}

if (acceptanceError !== undefined) throw acceptanceError;

const report = {
  accepted: true,
  piCloudRevision: testedRevision,
  checkedAt: new Date().toISOString(),
  account: username,
  clickedControls: clicked,
  clickedControlCount: clicked.length,
  screenshotCaptured: true,
  cleanupCompleted: true,
};
await writeFile(
  resolve(repositoryRoot, "docs/reports/browser-ui-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
