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
import { AdminPage } from "/src/AdminPage.tsx";
import { AccountMenu } from "/src/AccountMenu.tsx";
import { Markdown } from "/src/Markdown.tsx";
import { WorkspaceInspector } from "/src/WorkspaceInspector.tsx";
import { WorkspaceTerminal } from "/src/WorkspaceTerminal.tsx";
import { WorkspaceDirectoryPicker } from "/src/WorkspaceDirectoryPicker.tsx";
import { ConversationTreeNavigator } from "/src/ConversationTreeNavigator.tsx";
import { PiCloudApi } from "/src/api.ts";
import { I18nProvider } from "/src/i18n.tsx";
import { copyMessageText } from "/src/MessageCopyButton.tsx";
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
window.renderTurn = (text, recoveredTextLength = 0, status = "running") => root.render(
  React.createElement(React.StrictMode, null, React.createElement(ConversationTurn, {turn:{
    runId:"run",turnId:"turn",mailboxPosition:null,prompt:"Question",acceptedAt:null,
    status,startedSequence:1,terminalSequence:null,stopReason:null,failure:null,cancellation:null,
    items:[{kind:"text",key:"text:1",text,firstSequence:1,lastSequence:2,recoveredTextLength}]
  }})));
window.turnBodies = [];
window.copyFixtureText=copyMessageText;
window.renderAdmin=()=>root.render(React.createElement(I18nProvider,{initialLanguage:'en-US'},React.createElement(AdminPage,{
  api:{getCubeProxyConfiguration:()=>new Promise(()=>{}),getModelConfiguration:()=>new Promise(()=>{})},
  identity:{displayName:'Fixture administrator',platformAdministrator:true},onLogout:()=>{}
})));
window.renderMarkdownLanguage=()=>root.render(React.createElement(I18nProvider,{initialLanguage:'en-US'},
  React.createElement(AccountMenu,{label:'Fixture',onLogout:()=>{}}),
  React.createElement(Markdown,{children:'![fixture](https://images.invalid/fixture.png)'}),
));
const inspectorApi = {
  listDevelopmentEnvironments:async()=>({environments:[]}),
  listWorkspaceDirectory:async()=>({entries:[
    {name:"a.txt",path:"a.txt",kind:"file",sizeBytes:10},
    {name:"b.txt",path:"b.txt",kind:"file",sizeBytes:10},
    {name:"large.bin",path:"large.bin",kind:"file",sizeBytes:1000000}
  ],truncated:false}),
  readWorkspaceFile:async(_session,path)=>new Promise(resolve=>{
    window.fileReads[path]=text=>resolve({bytes:new TextEncoder().encode(text),contentType:"text/plain"});
  }),
};
window.fileReads={};
window.renderDirectoryPicker=()=>{
  window.directoryLoads={};window.chosenDirectories=[];
  const api={
    listDevelopmentEnvironmentDirectory:(_environment,path)=>new Promise((resolve,reject)=>{
      window.directoryLoads[path]={resolve,reject};
    }),
    createDevelopmentEnvironmentDirectory:()=>new Promise(resolve=>{window.finishDirectoryCreate=resolve;})
  };
  root.render(React.createElement(I18nProvider,{initialLanguage:'en-US'},React.createElement(WorkspaceDirectoryPicker,{
    api,environmentId:'machine',initialDirectory:'/home/user',workspaceName:'machine',onCancel:()=>{},
    onChoose:path=>window.chosenDirectories.push(path)
  })));
};
window.navigations=[]; window.jumpCount=0;
const NativeWebSocket=window.WebSocket;
window.terminalSockets=[];
window.renderTerminal=()=>{
  window.WebSocket=class extends EventTarget {
    static OPEN=1; static CLOSED=3; static CONNECTING=0;
    readyState=1;
    constructor(url){super();this.url=url;window.terminalSockets.push(this);}
    send(){}
    close(){this.readyState=3;}
  };
  root.render(React.createElement(I18nProvider,{initialLanguage:'en-US'},React.createElement(WorkspaceTerminal,{
    sessionId:'session-fixture',onError:()=>{}
  })));
};
window.terminalReady=i=>terminalSockets[i].dispatchEvent(new MessageEvent('message',{data:JSON.stringify({
  workspaceTerminalProtocolVersion:1,type:'workspace_terminal.ready',terminalId:'10000000-0000-4000-8000-000000000001',pid:1,workspaceRoot:'/workspace'
})}));
window.restoreWebSocket=()=>{window.WebSocket=NativeWebSocket;};
window.renderNavigation=()=>{
  const scroller=document.createElement('section'); scroller.id='fixture-scroller';
  const anchor=document.createElement('div'); anchor.dataset.conversationTurnId='root-turn'; anchor.dataset.conversationEntryId='root-entry';
  scroller.append(anchor); document.body.append(scroller);
  const entry={entryId:'root-entry',turnId:'root-turn',role:'user',text:'Shared question',finalAssistant:false};
  const tree={currentSessionId:'root-session',branches:[
    {sessionId:'root-session',parentSessionId:null,kind:'conversation',title:'root',entries:[entry]},
    {sessionId:'child-session',parentSessionId:'root-session',forkedFromEntryId:'root-entry',kind:'subagent',title:'child',entries:[]}
  ],delegatedSessions:[]};
  root.render(React.createElement(I18nProvider,{initialLanguage:'en-US'},React.createElement(ConversationTreeNavigator,{
    tree,view:'full',loading:false,scrollerRef:{current:scroller},onViewChange:()=>{},
    onNavigate:(...args)=>window.navigations.push(args),onJump:()=>window.jumpCount++
  })));
};
window.renderInspector=(refreshSignal=0)=>root.render(React.createElement(I18nProvider,{initialLanguage:"en-US"},
  React.createElement(WorkspaceInspector,{api:inspectorApi,sessionId:"session-fixture",workspaceId:"workspace-fixture",
    workspaceName:"fixture",developmentEnvironmentId:null,workingDirectory:"/workspace",refreshSignal,onClose:()=>{},onError:()=>{}})));
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
    if(String(url)==="/v1/auth/logout") return window.rejectLogout
      ? Response.json({error:{code:"conflict",message:"Fixture rejects logout"}},{status:503})
      : Response.json({loggedOut:true});
    if(String(url).endsWith("/events")) return new Response(new ReadableStream({start(controller){
      init.signal?.addEventListener("abort",()=>controller.close(),{once:true});
    }}),{headers:{"content-type":"text/event-stream"}});
    if(String(url).endsWith("/model") && init.method==="PUT") {
      selection=JSON.parse(init.body); window.savedSelection=selection;
      return Response.json(modelResource());
    }
    if(String(url).endsWith("/turns")) {
      window.turnBodies.push(JSON.parse(init.body));
      if(window.deferTurn) return new Promise(resolve=>{
        window.finishTurn=()=>resolve(Response.json({turnId:"50000000-0000-4000-8000-000000000001",
          sessionId:sid,runId:"60000000-0000-4000-8000-000000000001",mailboxPosition:1,
          state:"queued",acceptedAt:new Date().toISOString(),replayed:false},{status:202}));
      });
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
          if (req.url === "/v1/identity") {
            res.statusCode = 401;
            res.setHeader("content-type", "application/json");
            return res.end(
              JSON.stringify({
                error: { code: "authentication_required", message: "Login required" },
              }),
            );
          }
          if (req.url === "/v1/auth/providers") {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ local: { login: true, registration: true } }));
          }
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
    const settledText = "First paragraph.\n\nSecond paragraph.";
    await page.evaluate(`renderTurn(${JSON.stringify(settledText)},${settledText.length})`);
    await page.waitFor("document.querySelectorAll('.product-agent-answer p').length===2");
    await page.evaluate(
      "window.stableParagraph=document.querySelector('.product-agent-answer p');undefined",
    );
    await page.evaluate(
      `renderTurn(${JSON.stringify(settledText)},${settledText.length},'completed')`,
    );
    await page.waitFor("document.querySelector('.product-answer-actions')");
    assert.equal(
      await page.evaluate("document.querySelector('.product-agent-answer p')===stableParagraph"),
      true,
      "Settlement must not replace already-rendered Markdown nodes",
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
    await page.evaluate(
      'document.querySelector(".product-composer textarea").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", isComposing:true, bubbles:true}))',
    );
    await page.wait(50);
    assert.equal(
      await page.evaluate('document.querySelector(".product-workspace-modal")!==null'),
      false,
      "IME confirmation must not submit the composer",
    );
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
    await page.evaluate("window.deferTurn=true");
    await fill(".product-composer textarea", "submitted draft");
    await page.waitFor('!document.querySelector(".product-send-button").disabled');
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor("typeof window.finishTurn==='function'");
    await fill(".product-composer textarea", "next draft");
    await page.evaluate("finishTurn()");
    await page.waitFor(
      'document.querySelector(".product-user-bubble")?.textContent==="submitted draft"',
    );
    assert.equal(
      await page.evaluate('document.querySelector(".product-composer textarea").value'),
      "next draft",
      "Acceptance must not clear text typed while the request was in flight",
    );
    await page.evaluate("renderInspector()");
    await page.waitFor('document.querySelectorAll("button.workspace-tree-file").length===3');
    await page.evaluate(
      'document.querySelector("button.workspace-tree-file[title=\\"a.txt\\"]").click()',
    );
    await page.waitFor("typeof fileReads['a.txt']==='function'");
    await page.evaluate(
      'document.querySelector("button.workspace-tree-file[title=\\"b.txt\\"]").click()',
    );
    await page.waitFor("typeof fileReads['b.txt']==='function'");
    await page.evaluate("fileReads['b.txt']('content B')");
    await page.waitFor(
      'document.querySelector(".workspace-file-preview code")?.textContent==="content B"',
    );
    await page.evaluate("fileReads['a.txt']('content A')");
    await page.wait(50);
    assert.equal(
      await page.evaluate('document.querySelector(".workspace-file-preview code").textContent'),
      "content B",
      "A late file read must not replace the selected file's content",
    );
    await page.evaluate('document.querySelector(".workspace-view-tabs button:last-child").click()');
    await page.waitFor('document.querySelector(".workspace-terminal-panel")');
    await page.evaluate("renderInspector(1)");
    await page.wait(100);
    assert.equal(
      await page.evaluate('document.querySelector(".workspace-terminal-panel")!==null'),
      true,
      "A Run completion refresh must not unmount the human terminal",
    );
    await page.evaluate("renderNavigation()");
    await page.waitFor('document.querySelector(".product-tree-branch-label")');
    await page.evaluate('document.querySelector(".product-tree-branch-label").click()');
    assert.deepEqual(
      await page.evaluate("navigations"),
      [["child-session"]],
      "An empty child branch must still be selectable",
    );
    await page.evaluate('document.querySelector(".product-tree-entry").click()');
    assert.equal(
      await page.evaluate("jumpCount"),
      1,
      "A local tree jump must stop automatic tail following",
    );
    await page.evaluate("document.getElementById('fixture-scroller').remove()");
    await page.evaluate("renderTerminal()");
    await page.waitFor('document.querySelector(".workspace-terminal-toolbar button")');
    await page.evaluate(
      'document.querySelector(".workspace-terminal-toolbar button").click();terminalReady(0)',
    );
    await page.waitFor(
      'document.querySelector(".workspace-terminal-toolbar button").textContent==="Disconnect"',
    );
    await page.evaluate('document.querySelector(".workspace-terminal-toolbar button").click()');
    await page.waitFor(
      'document.querySelector(".workspace-terminal-toolbar button").textContent==="Connect terminal"',
    );
    await page.evaluate(
      'document.querySelector(".workspace-terminal-toolbar button").click();terminalReady(1)',
    );
    await page.waitFor(
      'document.querySelector(".workspace-terminal-toolbar button").textContent==="Disconnect"',
    );
    await page.evaluate("terminalSockets[0].dispatchEvent(new Event('close'))");
    await page.wait(50);
    assert.equal(
      await page.evaluate(
        'document.querySelector(".workspace-terminal-toolbar button").textContent',
      ),
      "Disconnect",
      "A retired terminal socket must not disconnect its successor",
    );
    await page.evaluate("restoreWebSocket()");
    await page.evaluate("renderDirectoryPicker()");
    await page.waitFor("directoryLoads['/home/user']");
    await page.evaluate("directoryLoads['/home/user'].reject(new Error('Directory unavailable'))");
    await page.waitFor("document.querySelector('.product-directory-picker .product-form-error')");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-directory-picker footer .product-primary-button').disabled",
      ),
      true,
      "A failed directory listing must not leave a selectable stale directory",
    );
    await page.evaluate("document.querySelector('.product-directory-address button').click()");
    await page.waitFor("directoryLoads['/']");
    await page.evaluate("directoryLoads['/'].resolve({path:'/',entries:[],truncated:false})");
    await page.waitFor("!document.querySelector('.product-directory-new-folder').disabled");
    await page.evaluate("document.querySelector('.product-directory-new-folder').click()");
    await fill(".product-directory-create input", "project");
    await page.evaluate(
      "document.querySelector('.product-directory-create .product-primary-button').click()",
    );
    await page.waitFor("typeof finishDirectoryCreate==='function'");
    await page.evaluate("document.querySelector('.product-directory-places button').click()");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-directory-selection code').textContent",
      ),
      "/",
      "Navigation cannot race a pending directory creation",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-directory-places button').disabled"),
      true,
    );
    await page.evaluate(
      "finishDirectoryCreate({path:'/',entries:[{name:'project',path:'/project',kind:'directory'}],truncated:false})",
    );
    await page.waitFor(
      "document.querySelector('.product-directory-selection code').textContent==='/project'",
    );
    const clipboardFailure = await page.evaluate(`(async()=>{
      const descriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
      const nativeExec=document.execCommand;
      const active=document.createElement('input');document.body.append(active);active.focus();
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
      document.execCommand=()=>{throw new Error('Copy rejected');};
      const count=document.querySelectorAll('textarea').length;
      try {
        let error;try {await copyFixtureText('private copy fixture');} catch(caught){error=caught.message;}
        return {error,extraTextareas:document.querySelectorAll('textarea').length-count,focusRestored:document.activeElement===active};
      } finally {
        document.execCommand=nativeExec;active.remove();
        if(descriptor)Object.defineProperty(navigator,'clipboard',descriptor);else delete navigator.clipboard;
      }
    })()`);
    assert.deepEqual(clipboardFailure, {
      error: "Copy rejected",
      extraTextareas: 0,
      focusRestored: true,
    });
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 400,
      height: 550,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate("renderChat()");
    await page.waitFor("document.querySelector('.product-main')");
    const mobileChat = await page.evaluate(
      "document.querySelector('.product-main').clientHeight===innerHeight",
    );
    await page.evaluate("renderAdmin()");
    await page.waitFor("document.querySelector('.product-admin-page')");
    const adminScroll = await page.evaluate(
      "document.querySelector('.product-admin-page').clientHeight===innerHeight",
    );
    await page.evaluate("document.querySelector('.product-account-menu-trigger').click()");
    await page.evaluate(
      "document.querySelector('.product-account-menu-language > button').click()",
    );
    await page.evaluate(
      "document.querySelector('.product-account-language-submenu button').click()",
    );
    await page.waitFor("document.documentElement.lang==='zh-CN'");
    const adminTranslated = await page.evaluate(
      "document.querySelector('.product-admin-service-grid a span').textContent.includes('管理订阅')",
    );
    await page.evaluate("renderMarkdownLanguage()");
    await page.waitFor("document.querySelector('.product-image-placeholder')");
    // The provider may be reused by React; select English before checking the transition.
    await page.evaluate("document.querySelector('.product-account-menu-trigger').click()");
    await page.evaluate(
      "document.querySelector('.product-account-menu-language > button').click()",
    );
    await page.evaluate(
      "document.querySelector('.product-account-language-submenu button:last-child').click()",
    );
    await page.waitFor("document.documentElement.lang==='en-US'");
    const markdownEnglish = await page.evaluate(
      "document.querySelector('.product-image-placeholder').textContent.includes('Image')",
    );
    await page.evaluate("document.querySelector('.product-account-menu-trigger').click()");
    await page.evaluate(
      "document.querySelector('.product-account-menu-language > button').click()",
    );
    await page.evaluate(
      "document.querySelector('.product-account-language-submenu button').click()",
    );
    await page.waitFor("document.documentElement.lang==='zh-CN'");
    const markdownTranslated = await page.evaluate(
      "document.querySelector('.product-image-placeholder').textContent.includes('图片')",
    );
    assert.deepEqual(
      { adminTranslated, markdownEnglish, markdownTranslated },
      { adminTranslated: true, markdownEnglish: true, markdownTranslated: true },
    );
    await page.evaluate("renderDirectoryPicker()");
    await page.waitFor("directoryLoads['/home/user']");
    await page.evaluate(
      "directoryLoads['/home/user'].resolve({path:'/home/user',entries:[],truncated:false})",
    );
    await page.waitFor(
      "!document.querySelector('.product-directory-picker footer .product-primary-button').disabled",
    );
    const directoryChoice = await page.evaluate(`(()=>{
      const button=document.querySelector('.product-directory-picker footer .product-primary-button');
      const rect=button.getBoundingClientRect();
      return rect.bottom<=innerHeight && document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button;
    })()`);
    assert.deepEqual(
      { mobileChat, adminScroll, directoryChoice },
      { mobileChat: true, adminScroll: true, directoryChoice: true },
    );
    await page.send("Emulation.clearDeviceMetricsOverride");
    await page.evaluate("renderChat(); window.rejectLogout=true");
    await page.waitFor('document.querySelector(".product-account-menu-trigger")');
    await page.evaluate('document.querySelector(".product-account-menu-trigger").click()');
    await page.evaluate('document.querySelector(".product-account-menu-logout").click()');
    await page.wait(100);
    assert.equal(
      await page.evaluate('document.querySelector(".product-shell")!==null'),
      true,
      "Failed logout must not pretend the HttpOnly login cookie was revoked",
    );
    await page.waitFor('document.querySelector(".product-account-menu [role=alert]")');
    await page.evaluate(
      "window.rejectLogout=false;document.querySelector('.product-account-menu-logout').click()",
    );
    await page.wait(500);
    await page.waitFor('document.querySelector(".product-auth-card")');
    assert.equal(
      await page.evaluate("typeof window.fixtureReady"),
      "undefined",
      "Successful logout must discard the entire previous account's document state",
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
      compositionAndPendingDraft: true,
      inspectorSelectionAndTerminalLifetime: true,
      logoutLifecycle: true,
      branchSelectionAndManualJump: true,
      terminalSocketIsolation: true,
      directoryPickerLifecycle: true,
      responsivePageScrolling: true,
    }),
  );
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
