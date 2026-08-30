import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_DIRECTORY_PICKER_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_DIRECTORY_PICKER_CHECK=1 to acknowledge real Cube capacity usage",
  );
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environment = Object.fromEntries(
  (await readFile(resolve(runtimeDirectory, ".env"), "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);

class BrowserCookieFetch {
  #cookie;
  fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (this.#cookie !== undefined) headers.set("cookie", this.#cookie);
    const response = await fetch(new URL(String(input), baseUrl), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(180_000),
    });
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of setCookies) {
      const match = /(?:^|[,;]\s*)(pi_cloud_session=[^;]*)/.exec(value);
      if (match !== null) this.#cookie = match[1];
    }
    return response;
  };
}

const wait = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
async function waitFor(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined && result !== null && result !== false) return result;
    await wait(200);
  }
  throw new Error(`${label} timed out`);
}

const suffix = Date.now().toString(36);
const username = `directory.acceptance.${suffix}`.slice(0, 48);
const password = `Directory acceptance ${suffix} 9!`;
const folderName = `ui-project-${suffix}`;
const cookieFetch = new BrowserCookieFetch();
const api = new PiCloudApi(cookieFetch.fetch);
await api.registerAccount(username, "Directory Acceptance", password);
const development = await api.createDevelopmentEnvironment(
  `Directory machine ${suffix}`,
  "standard",
  newIdempotencyKey("environment"),
);
await waitFor(
  async () =>
    (await api.listDevelopmentEnvironments()).environments.find(
      (candidate) =>
        candidate.environmentId === development.environmentId && candidate.state === "running",
    ),
  "running exclusive environment",
  180_000,
);

const screenshotPath = resolve("/tmp", "pi-cloud-directory-picker-latest.png");
let acceptanceError;
let cleanupError;
try {
  await withChromePage(
    { profilePrefix: "pi-cloud-directory-picker-", width: 1_360, height: 900 },
    async (page) => {
      const selector = (value) => `document.querySelector(${JSON.stringify(value)})`;
      const click = async (value, label) => {
        const clicked = await page.evaluate(
          `(()=>{const element=${selector(value)};if(!element||element.disabled)return false;element.click();return true})()`,
        );
        assert.equal(clicked, true, `${label} was unavailable`);
      };
      const clickText = async (value, text, label) => {
        const clicked = await page.evaluate(
          `(()=>{const element=[...document.querySelectorAll(${JSON.stringify(value)})].find(candidate=>candidate.textContent.includes(${JSON.stringify(text)})&&!candidate.disabled);if(!element)return false;element.click();return true})()`,
        );
        assert.equal(clicked, true, `${label} was unavailable`);
      };
      const setValue = async (value, next) => {
        const changed = await page.evaluate(
          `(()=>{const element=${selector(value)};if(!element)return false;element.focus();const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,${JSON.stringify(next)});element.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:${JSON.stringify(next)}}));element.dispatchEvent(new Event("change",{bubbles:true}));return element.value===${JSON.stringify(next)}})()`,
        );
        assert.equal(changed, true, `Could not set ${value}`);
      };

      await page.navigate(baseUrl.toString(), 800);
      await page.evaluate('localStorage.setItem("pi-cloud:ui-language","zh-CN")');
      await page.send("Page.reload", { ignoreCache: true });
      await page.waitFor('document.querySelector(".product-auth-card")');
      await setValue('input[autocomplete="username"]', username);
      await setValue('input[type="password"]', password);
      await click('.product-auth-card button[type="submit"]', "login");
      await page.waitFor('document.querySelector(".product-shell")', 30_000);
      await page.waitFor(
        'document.querySelector(".product-sidebar-brand")?.textContent.includes("PiCloud")',
      );
      await click(".product-new-chat", "new conversation");
      await page.waitFor('document.querySelector(".product-workspace-modal")');
      await clickText(
        ".product-execution-mode-choice .product-choice-card",
        "云端开发机",
        "exclusive mode",
      );
      await setValue(".product-progressive-options > label input", `Directory UI ${suffix}`);
      await click(".product-working-directory-choice button", "directory picker");
      await page.waitFor('document.querySelector(".product-directory-picker")');
      await page.waitFor(
        'document.querySelector(".product-directory-new-folder")?.disabled===false',
      );
      await click(".product-directory-new-folder", "new folder");
      await page.waitFor('document.querySelector(".product-directory-create input")');
      await setValue(".product-directory-create input", folderName);
      await click(".product-directory-create .product-primary-button", "create folder");
      await page.waitFor(
        `[...document.querySelectorAll(".product-directory-entry[aria-selected=true] strong")].some(element=>element.textContent===${JSON.stringify(folderName)})`,
        30_000,
      );
      await page.screenshot(screenshotPath);
      await click(
        ".product-directory-picker > footer .product-primary-button",
        "choose created folder",
      );
      await page.waitFor('!document.querySelector(".product-directory-picker")');
      await page.waitFor(
        `document.querySelector(".product-working-directory-choice")?.textContent.includes(${JSON.stringify(folderName)})`,
      );
      await click(".product-workspace-modal header button", "close conversation dialog");
    },
  );

  const listing = await api.listDevelopmentEnvironmentDirectory(
    development.environmentId,
    "/home/user",
  );
  assert.equal(
    listing.entries.some((entry) => entry.name === folderName && entry.kind === "directory"),
    true,
    "Created directory was not visible through the trusted listing API",
  );
} catch (error) {
  acceptanceError = error;
} finally {
  try {
    await api.developmentEnvironmentAction(
      development.environmentId,
      "release",
      newIdempotencyKey("environment"),
    );
    await rm(screenshotPath, { force: true });
  } catch (error) {
    cleanupError = error;
  }
}

if (acceptanceError !== undefined) throw acceptanceError;
if (cleanupError !== undefined) throw cleanupError;

const report = {
  accepted: true,
  piCloudRevision: revision,
  checkedAt: new Date().toISOString(),
  account: username,
  environmentId: development.environmentId,
  createdDirectory: `/home/user/${folderName}`,
  screenshotCaptured: true,
  cleanupCompleted: true,
};
await writeFile(
  resolve(repositoryRoot, "docs/reports/directory-picker-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report)}\n`);
