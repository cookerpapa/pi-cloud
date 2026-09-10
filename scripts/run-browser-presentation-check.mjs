import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import { withChromePage } from "./lib/chrome-cdp.mjs";

// Real React effects/DOM, without a model, database or user account. In
// particular, server-render-only tests cannot catch StrictMode RAF cleanup.
const cacheDir = await mkdtemp(join(tmpdir(), "pi-cloud-render-vite-"));
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ConversationTurn } from "/src/ConversationTurn.tsx";
import { useResizablePanel } from "/src/use-resizable-panel.ts";

let frames = new Map(), frameId = 0;
window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
window.cancelAnimationFrame = id => frames.delete(id);
window.advanceFrame = () => {
  const callbacks = [...frames.values()]; frames.clear();
  callbacks.forEach(callback => callback(performance.now()));
  return callbacks.length;
};
function Panel() {
  const panel = useResizablePanel({storageKey:"review",initialWidth:280,minimumWidth:180,maximumWidth:600});
  return React.createElement("div", {id:"panel", "data-width":panel.width, onPointerDown:panel.beginResize}, "drag");
}
const root = createRoot(document.getElementById("root"));
window.renderPanel = () => root.render(React.createElement(React.StrictMode, null, React.createElement(Panel)));
window.renderTurn = (text, recoveredTextLength = 0) => root.render(
  React.createElement(React.StrictMode, null, React.createElement(ConversationTurn, {turn:{
    runId:"run",turnId:"turn",mailboxPosition:null,prompt:"Question",acceptedAt:null,
    status:"running",startedSequence:1,terminalSequence:null,stopReason:null,failure:null,cancellation:null,
    items:[{kind:"text",key:"text:1",text,firstSequence:1,lastSequence:2,recoveredTextLength}]
  }})));
window.fixtureReady = true;
`;
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../packages/web-ui", import.meta.url)),
  cacheDir,
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "presentation-fixture",
      resolveId(id) {
        if (id === "/presentation-fixture.js") return "\0presentation-fixture";
      },
      load(id) {
        if (id === "\0presentation-fixture") return fixture;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/review.html") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><div id="root"></div><script type="module" src="/presentation-fixture.js"></script>',
          );
        });
      },
    },
  ],
});
try {
  await server.listen();
  const port = server.httpServer.address().port;
  await withChromePage({}, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.waitFor("window.fixtureReady");
    await page.evaluate("localStorage.clear(); renderPanel()");
    await page.waitFor('document.querySelector("#panel")');
    assert.equal(await page.evaluate('document.querySelector("#panel").dataset.width'), "280");
    await page.evaluate(
      `document.querySelector("#panel").dispatchEvent(new PointerEvent("pointerdown", {bubbles:true,clientX:100})); window.dispatchEvent(new PointerEvent("pointermove", {clientX:140}));`,
    );
    await page.waitFor('document.querySelector("#panel").dataset.width === "320"');
    const target = "Durable text with live animation. ".repeat(300);
    await page.evaluate(`renderTurn(${JSON.stringify(target)})`);
    await page.waitFor('document.querySelector(".product-agent-answer")');
    assert.equal(
      await page.evaluate('document.body.classList.contains("product-panel-resizing")'),
      false,
    );
    await page.evaluate('window.dispatchEvent(new PointerEvent("pointermove", {clientX:300}));');
    assert.equal(await page.evaluate('localStorage.getItem("review:width")'), "320");
    const frames = await page.evaluate("advanceFrame()");
    assert(frames > 0, "StrictMode remount left the live animation cancelled");
    await page.waitFor('document.querySelector(".product-agent-answer").textContent.length > 0');
    const visible = await page.evaluate(
      'document.querySelector(".product-agent-answer").textContent.length',
    );
    assert(visible < 100, "One frame flushed the entire buffered answer");
    await page.evaluate(`renderTurn(${JSON.stringify(target)}, 4000)`);
    await page.waitFor(
      'document.querySelector(".product-agent-answer").textContent.length >= 4000',
    );
    assert.equal(
      await page.evaluate('document.querySelector(".product-agent-answer").textContent'),
      target.slice(0, 4000),
    );
    await page.evaluate("renderPanel()");
    await page.waitFor('document.querySelector("#panel")');
    await page.evaluate(
      'document.querySelector("#panel").dispatchEvent(new PointerEvent("pointerdown", {bubbles:true,clientX:100})); window.dispatchEvent(new PointerEvent("pointercancel"));',
    );
    assert.equal(
      await page.evaluate('document.body.classList.contains("product-panel-resizing")'),
      false,
    );
  });
  console.log(
    JSON.stringify({
      accepted: true,
      strictModeAnimation: true,
      reconnectSnapshotImmediate: true,
      initialPanelWidth: true,
      resizeUnmountCleanup: true,
      pointerCancellation: true,
    }),
  );
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
