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
import ChatApp from "/src/ChatApp.tsx";
import { PiCloudApi } from "/src/api.ts";
import { I18nProvider } from "/src/i18n.tsx";
import { DEVELOPMENT_ENVIRONMENT_PROFILES, DEFAULT_NEW_CONVERSATION_MODEL } from "@pi-cloud/protocol";
import "/src/product.css";

const nativeRaf = window.requestAnimationFrame, nativeCancelRaf = window.cancelAnimationFrame;
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
window.turnBodies = [];
window.renderChat = () => {
  window.requestAnimationFrame = nativeRaf; window.cancelAnimationFrame = nativeCancelRaf;
  const sid = "10000000-0000-4000-8000-000000000001";
  const profileId = "20000000-0000-4000-8000-000000000001";
  const project = {projectId:"30000000-0000-4000-8000-000000000001",workspaceId:"40000000-0000-4000-8000-000000000001",name:"fixture",createdAt:new Date().toISOString()};
  const models = [
    {...DEFAULT_NEW_CONVERSATION_MODEL,displayName:"Fixture GPT",default:true,thinkingLevels:["off","medium","high"],defaultThinkingLevel:"medium",fastModeAvailable:true},
    {provider:"deepseek",modelId:"deepseek-v4-pro",displayName:"Fixture DeepSeek",default:false,thinkingLevels:["off","medium","high"],defaultThinkingLevel:"high",fastModeAvailable:false}
  ];
  let selection = {...DEFAULT_NEW_CONVERSATION_MODEL,thinkingLevel:"medium",fastMode:false};
  let session;
  const modelResource = () => ({sessionId:sid,modelProfileId:profileId,...selection,
    displayName:models.find(m=>m.provider===selection.provider).displayName});
  Object.assign(PiCloudApi.prototype, {
    getIdentity:async()=>({tenantId:"test-tenant",userId:"test-user",displayName:"Fixture",role:"owner",platformAdministrator:false}),
    listConversations:async()=>({conversations:[],delegatedSessions:[]}),
    listWorkspaces:async()=>({workspaces:[{...project,sessionCount:0,lastActiveAt:new Date().toISOString()}],truncated:false}),
    listDevelopmentEnvironments:async()=>({environments:[],profiles:DEVELOPMENT_ENVIRONMENT_PROFILES,truncated:false}),
    getModelCatalog:async()=>({models}),
    getConversationTree:async()=>({branches:[],delegatedSessions:[]}),
    createSession:async (projectId,workspaceId,title,executionMode,sandboxProfileKey,workingDirectory,model)=>{
      selection=model; window.savedSelection=selection;
      session={sessionId:sid,projectId,workspaceId,title,executionMode,sandboxProfileKey,workingDirectory,state:"idle",workspaceState:"attached",modelProfileId:profileId,createdAt:new Date().toISOString()};
      return session;
    },
    getSessionModel:async()=>modelResource(),
    getConversation:async()=>({project,session,inheritedMessages:[],turns:[],historyTruncated:false}),
  });
  const nativeFetch=window.fetch;
  window.fetch=async (url,init={})=>{
    if(String(url).endsWith("/events")) return new Response(new ReadableStream({start(controller){
      init.signal?.addEventListener("abort",()=>controller.close(),{once:true});
    }}),{headers:{"content-type":"text/event-stream"}});
    if(String(url).endsWith("/model") && init.method==="PUT") {
      selection=JSON.parse(init.body); window.savedSelection=selection;
      return Response.json(modelResource());
    }
    if(String(url).endsWith("/turns")) {
      window.turnBodies.push(JSON.parse(init.body));
      // Capture the real request builder without creating a model Run.
      return Response.json({error:{code:"conflict",message:"Fixture does not execute models"}},{status:409});
    }
    return nativeFetch(url,init);
  };
  root.render(React.createElement(I18nProvider,{initialLanguage:"en-US"},React.createElement(ChatApp)));
};
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
    await page.evaluate("renderChat()");
    await page.waitFor('document.querySelector(".product-model-menu-trigger")');
    const fill = async (selector, value) => {
      await page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
        const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});
        el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    await fill(".product-composer textarea", "initial prompt");
    await page.waitFor('!document.querySelector(".product-send-button").disabled');
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor('document.querySelector(".product-execution-mode-choice input")');
    await page.evaluate('document.querySelector(".product-execution-mode-choice input").click()');
    await page.waitFor('document.querySelector(".product-progressive-options input")');
    await fill(".product-progressive-options input", "Model contract");
    await page.evaluate('document.querySelector(".product-workspace-modal").requestSubmit()');
    await page.waitFor("window.turnBodies.length===1");
    assert.equal(await page.evaluate("savedSelection.thinkingLevel"), "medium");

    const openModel = async (providerIndex) => {
      await page.waitFor('!document.querySelector(".product-model-menu-trigger").disabled');
      await page.evaluate('document.querySelector(".product-model-menu-trigger").click()');
      await page.waitFor('document.querySelector(".product-model-menu-panel")');
      await page.evaluate(
        `document.querySelectorAll('.product-model-menu-panel')[0].querySelectorAll('button')[${providerIndex}].click()`,
      );
      await page.waitFor('document.querySelectorAll(".product-model-menu-panel").length===2');
      await page.evaluate(
        'document.querySelectorAll(".product-model-menu-panel")[1].querySelector("button").click()',
      );
      await page.waitFor('document.querySelectorAll(".product-model-menu-panel").length===3');
    };
    const high = async () => {
      await page.waitFor(
        '!document.querySelectorAll(".product-model-menu-panel")[2].querySelector("button").disabled',
      );
      await page.evaluate(
        `Array.from(document.querySelectorAll('.product-model-menu-panel')[2].querySelectorAll('button')).find(b=>b.querySelector('span')?.textContent==='High').click()`,
      );
      await page.waitFor('!document.querySelector(".product-model-menu-panel")');
    };
    await openModel(0);
    await page.evaluate('document.querySelector(".product-model-menu-fast").click()');
    await page.waitFor("savedSelection.fastMode===true");
    await high();
    assert.deepEqual(await page.evaluate("savedSelection"), {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      fastMode: true,
    });
    await fill(".product-composer textarea", "existing prompt");
    await page.waitFor('!document.querySelector(".product-send-button").disabled');
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor("window.turnBodies.length===2");
    await openModel(1);
    await high();
    assert.equal(await page.evaluate("savedSelection.fastMode"), false);
    await fill(".product-composer textarea", "DeepSeek prompt");
    await page.waitFor('!document.querySelector(".product-send-button").disabled');
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor("window.turnBodies.length===3");
    assert.deepEqual(
      await page.evaluate("turnBodies.map(body=>body.thinkingLevel??null)"),
      [null, null, null],
      "Composer must use persisted Session settings, not an old per-Turn override",
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
      composerSessionSettings: true,
      providerSwitchClearsFast: true,
    }),
  );
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
