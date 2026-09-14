import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import WebSocket from "ws";

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function chromeBinary() {
  for (const candidate of [
    process.env.PI_CLOUD_CHROME_BINARY,
    "google-chrome",
    "chromium",
    "chromium-browser",
  ]) {
    if (candidate === undefined) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("A Chrome/Chromium binary is required for browser acceptance");
}

async function connectCdp(profile, chrome) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null || chrome.signalCode !== null)
      throw new Error("Test Chrome exited before its debugger became ready");
    try {
      // Read the endpoint created in THIS process's private profile. A random
      // fixed port could attach a parallel test to somebody else's browser.
      const portNumber = Number(
        (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
      );
      const targets = await fetch(`http://127.0.0.1:${String(portNumber)}/json`, {
        signal: AbortSignal.timeout(2000),
      }).then((response) => response.json());
      const page = targets.find((candidate) => candidate.type === "page");
      if (page?.webSocketDebuggerUrl !== undefined) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolvePromise, rejectPromise) => {
          socket.once("open", resolvePromise);
          socket.once("error", rejectPromise);
        });
        let nextId = 0;
        const pending = new Map();
        const disconnected = () => {
          for (const request of pending.values())
            request.reject(new Error("Test Chrome debugger disconnected"));
          pending.clear();
        };
        socket.on("close", disconnected);
        socket.on("error", disconnected);
        socket.on("message", (raw) => {
          const message = JSON.parse(String(raw));
          if (message.id === undefined || !pending.has(message.id)) return;
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error === undefined) request.resolve(message.result);
          else request.reject(new Error(message.error.message));
        });
        return {
          socket,
          send(method, params = {}) {
            return new Promise((resolvePromise, rejectPromise) => {
              const id = ++nextId;
              pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
        };
      }
    } catch {
      await wait(100);
    }
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function stopChrome(chrome, profile) {
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => chrome.once("exit", resolvePromise)),
      wait(5_000),
    ]);
  }
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill("SIGKILL");
    await new Promise((resolvePromise) => chrome.once("exit", resolvePromise));
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      await wait(attempt * 100);
    }
  }
}

export async function withChromePage(
  {
    profilePrefix = "pi-cloud-chrome-",
    width = 1_280,
    height = 900,
    additionalArguments = [],
  } = {},
  operation,
) {
  const binary = chromeBinary();
  const profile = await mkdtemp(resolve(tmpdir(), profilePrefix));
  const chrome = spawn(
    binary,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      ...additionalArguments,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let cdp;
  try {
    cdp = await connectCdp(profile, chrome);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const page = {
      send: cdp.send,
      onNetworkEvent(listener) {
        const observe = (raw) => {
          const message = JSON.parse(String(raw));
          if (message.method?.startsWith("Network.")) listener(message.method, message.params);
        };
        cdp.socket.on("message", observe);
        return () => cdp.socket.off("message", observe);
      },
      onRequest(listener) {
        const observe = (raw) => {
          const message = JSON.parse(String(raw));
          if (message.method === "Network.requestWillBeSent") listener(message.params.request.url);
        };
        cdp.socket.on("message", observe);
        return () => cdp.socket.off("message", observe);
      },
      async evaluate(expression) {
        const result = await cdp.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails !== undefined) {
          throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
        }
        return result.result.value;
      },
      async navigate(url, settleMs = 500) {
        await cdp.send("Page.navigate", { url });
        await wait(settleMs);
      },
      async waitFor(expression, timeoutMs = 30_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if ((await page.evaluate(`Boolean(${expression})`)) === true) return;
          await wait(100);
        }
        throw new Error(`Browser condition timed out: ${expression.slice(0, 160)}`);
      },
      async screenshot(path) {
        const result = await cdp.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        });
        await writeFile(path, Buffer.from(result.data, "base64"));
      },
      wait,
    };
    return await operation(page);
  } finally {
    cdp?.socket.close();
    await stopChrome(chrome, profile);
  }
}
