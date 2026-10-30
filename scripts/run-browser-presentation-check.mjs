import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import { withChromePage as openChromePage } from "./lib/chrome-cdp.mjs";
async function withChromePage(options, operation) {
  if (process.env.PI_CLOUD_BROWSER_SCOPE === "peer-forks" && !options.peerForks) return;
  if (process.env.PI_CLOUD_BROWSER_SCOPE === "commands" && !options.commands) return;
  if (process.env.PI_CLOUD_BROWSER_SCOPE === "tool-groups" && !options.toolGroups) return;
  return openChromePage(options, async (page) => {
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        "window.fixtureErrors=[];window.addEventListener('error',e=>fixtureErrors.push(String(e.message).slice(0,300)));window.addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason).slice(0,300)));",
    });
    try {
      return await operation(page);
    } catch (error) {
      console.error(
        JSON.stringify({
          browserFailure: await page
            .evaluate(
              "({url:location.href,ready:document.readyState,errors:window.fixtureErrors??[],text:document.body?.innerText?.slice(0,500),resources:performance.getEntriesByType('resource').filter(r=>r.responseStatus!==200).slice(-10).map(r=>({path:new URL(r.name).pathname,status:r.responseStatus,duration:r.duration}))})",
            )
            .catch(() => ({ disconnected: true })),
        }),
      );
      await page.screenshot("/tmp/pi-cloud-presentation-failure.png").catch(() => {});
      throw error;
    }
  });
}

// A dead debugger must fail the acceptance run, never leave a pending RPC
// hanging forever. Exercise both an in-flight call and a call after disconnect.
await withChromePage({}, async (page) => {
  const { targetInfo } = await page.send("Target.getTargetInfo");
  const pending = page.evaluate("new Promise(() => {})").catch((error) => error);
  await page.send("Target.closeTarget", { targetId: targetInfo.targetId });
  let timer;
  try {
    await Promise.race([
      (async () => {
        assert.match((await pending).message, /debugger disconnected/u);
        await assert.rejects(page.evaluate("1 + 1"), /debugger disconnected/u);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Closed debugger left an RPC pending")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

// Real React effects/DOM, without a model, database or user account. In
// particular, server-render-only tests cannot catch StrictMode RAF cleanup.
const cacheDir = await mkdtemp(join(tmpdir(), "pi-cloud-render-vite-"));
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ConversationTurn } from "/src/ConversationTurn.tsx";
import { RunObservationStore } from "/src/run-observation-store.ts";
import { ToolProgressStore } from "/src/tool-progress-store.ts";
import { useResizablePanel } from "/src/use-resizable-panel.ts";
import ChatApp from "/src/ChatApp.tsx";
import { AdminPage } from "/src/AdminPage.tsx";
import { AccountMenu } from "/src/AccountMenu.tsx";
import { Markdown } from "/src/Markdown.tsx";
import { WorkspaceInspector } from "/src/WorkspaceInspector.tsx";
import { WorkspaceTerminal } from "/src/WorkspaceTerminal.tsx";
import { WorkspaceDirectoryPicker } from "/src/WorkspaceDirectoryPicker.tsx";
import { WorkspaceRebindDialog } from "/src/WorkspaceRebindDialog.tsx";
import { ConversationTreeNavigator } from "/src/ConversationTreeNavigator.tsx";
import { PiCloudApi, PiCloudApiError } from "/src/api.ts";
import { I18nProvider } from "/src/i18n.tsx";
import { createInitialSessionView, sessionViewReducer } from "/src/session-view.ts";
import { copyMessageText } from "/src/MessageCopyButton.tsx";
import { DEVELOPMENT_ENVIRONMENT_PROFILES,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE, DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256, parseInputQueueResource } from "@pi-cloud/protocol";
import "/src/product.css";
const DEFAULT_NEW_CONVERSATION_MODEL = {provider:"openai-codex",modelId:"gpt-6.1-sol"};

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
const configuration={productUrl:location.origin,adminUrl:location.origin,
  managementUrls:{providerGateway:'https://models.example.test/management.html',grafana:'',prometheus:'',alertmanager:'',jaeger:''}};
window.renderPanel = () => root.render(React.createElement(React.StrictMode, null, React.createElement(Panel)));
window.runObservations = new RunObservationStore();
window.toolProgressStore = new ToolProgressStore();
window.renderToolSettlement = (status='running',output, single=false) => {
  const tool=(id,state,text)=>({kind:'tool',key:'tool:'+id,toolCallId:id,toolName:'bash',input:{command:'fixture '+id},status:state,
    firstSequence:1,lastSequence:2,startedAt:'2026-10-28T00:00:00Z',...(state==='running'?{}:{completedAt:'2026-10-28T00:00:01Z'}),
    ...(text===undefined?{}:{output:{content:[{type:'text',text}]}})});
  const current=tool('settling',status,output);
  root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,{initialLanguage:'zh-CN'},React.createElement(ConversationTurn,{
    progressStore:toolProgressStore,turn:{runId:'run',turnId:'settlement-turn',mailboxPosition:null,prompt:'Fixture',acceptedAt:null,
      status:'running',startedSequence:1,terminalSequence:null,stopReason:null,failure:null,cancellation:null,
      items:single?[current]:[tool('before','completed','BEFORE_RESULT'),current,tool('after','completed','AFTER_RESULT')]}
  }))));
};
window.emitToolPreview = text => toolProgressStore.receive({type:'tool.progress',version:2,sessionId:'s',turnId:'settlement-turn',toolCallId:'settling',operationId:'op',update:{kind:'reset',revision:1,text}});
window.renderTurn = (text, recoveredTextLength = 0, status = "running", stopReason = null, phase, connected = true) => root.render(
  React.createElement(React.StrictMode, null, React.createElement(ConversationTurn, {observationStore:runObservations,connected,turn:{
    runId:"run",turnId:"turn",mailboxPosition:null,prompt:"Question",acceptedAt:null,
    status,startedSequence:1,terminalSequence:null,stopReason,failure:null,cancellation:null,
    items:[{kind:"text",key:"text:"+(phase??'1'),text,firstSequence:1,lastSequence:2,recoveredTextLength,...(phase?{phase}:{})}]
  }})));
window.retryView=createInitialSessionView();window.retrySequence=0;
window.renderRetry=attempt=>{
  const envelope=(type,payload)=>({schemaVersion:1,eventId:'10000000-0000-4000-8000-000000000001',sessionId:'retry-session',turnId:'retry-turn',agentId:'root',seq:++window.retrySequence,occurredAt:'2026-10-27T00:00:00Z',type,payload});
  if(!window.retryView.turns.length)window.retryView=sessionViewReducer(window.retryView,{type:'stream.event',event:envelope('turn.started',{inputKind:'prompt'})});
  window.retryView=sessionViewReducer(window.retryView,{type:'stream.event',event:envelope('model.sampling.retry.scheduled',{stepSequence:1,stepSha256:'a'.repeat(64),completedSamplingAttempt:attempt-1,nextSamplingAttempt:attempt,maximumSamplingAttempts:6,delayMs:500})});
  root.render(React.createElement(I18nProvider,{initialLanguage:'zh-CN'},React.createElement(ConversationTurn,{turn:window.retryView.turns[0]})));
};
window.reloadRetry=()=>{
  const t=window.retryView.turns[0];window.retryView=sessionViewReducer(window.retryView,{type:'conversation.loaded',conversation:{project:{},session:{sessionId:'retry-session',state:'running'},inheritedMessages:[],history:{before:'history-page',after:null,hasBefore:false,hasAfter:false},turns:[{...t,state:t.status,transcript:{schemaVersion:1,throughSequence:retrySequence,startedSequence:t.startedSequence,terminalSequence:null,stopReason:null,failure:null,cancellation:null,items:t.items.map(i=>({...i,historyCursor:'cursor:'+i.sequence}))}}]}});
  root.render(React.createElement(I18nProvider,{initialLanguage:'zh-CN'},React.createElement(ConversationTurn,{turn:window.retryView.turns[0]})));
};
window.renderPreviewPresentation=(status='completed',withLink=true,single=false)=>{
  window.requestAnimationFrame=nativeRaf;window.cancelAnimationFrame=nativeCancelRaf;
  const path='/v1/conversations/10000000-0000-4000-8000-000000000001/preview/5173/';
  window.previewFixturePath=path;
  const tool={kind:'tool',key:'preview',toolCallId:'task:2',toolName:'preview',input:{port:5173,path:'/'},
    output:{content:[{type:'text',text:'Verified HTTP service on port 5173. Application path: '+path}],details:{port:5173,previewPath:path}},
    status:'completed',firstSequence:2,lastSequence:3,startedAt:'2026-10-24T00:00:00.000Z',completedAt:'2026-10-24T00:00:00.200Z'};
  root.render(React.createElement(I18nProvider,{initialLanguage:'zh-CN'},React.createElement(ConversationTurn,{
    key:status+String(withLink)+String(single),turn:{runId:'preview-run',turnId:'preview-turn',prompt:'制作一个应用',acceptedAt:null,mailboxPosition:1,
      status,startedSequence:1,terminalSequence:status==='completed'?5:null,stopReason:status==='completed'?'stop':null,failure:null,cancellation:null,
      items:[...(single?[]:[{...tool,key:'bash',toolCallId:'task:1',toolName:'bash',input:{command:'start app'},output:'Ready'}]),tool,
        {kind:'text',key:'answer',messageId:'answer',phase:'final_answer',text:withLink?'已完成：[进入示例应用]('+path+')':'应用已完成。',firstSequence:4,lastSequence:4}]
    }
  })));
};
window.turnBodies = [];
window.turnRequests = [];
window.uploadCalls = [];
window.uploadReceipts = [];
window.copyFixtureText=copyMessageText;
window.renderAdmin=()=>root.render(React.createElement(I18nProvider,{initialLanguage:'en-US'},React.createElement(AdminPage,{
  managementUrls:configuration.managementUrls,
  api:{getCubeProxyConfiguration:async()=>({enabled:false,configured:false,revision:1}),getModelConfiguration:async()=>({mode:"deterministic",provider:"pi-cloud-fake",modelId:"pi-cloud-fake",configured:false,routeVersion:1,updatedAt:"2026-10-21T00:00:00Z"}),getModelCatalog:async()=>({revision:"a".repeat(64),reloadFailed:false,defaultModel:{provider:"openai-codex",modelId:"fixture-future"},models:[{provider:"openai-codex",modelId:"fixture-future",displayName:"Future model",default:true,thinkingLevels:["medium"],defaultThinkingLevel:"medium",fastModeAvailable:false}]})},
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
window.renderRebind = (withMachine=true) => {
  window.rebindCalls=[];window.rebindResumes=[];window.rebindCreates=0;window.rebindBound=[];
  window.rebindFailNext=!withMachine;
  const machine={environmentId:'machine-fixture',projectId:'machine-project',workspaceId:'machine-workspace',
    workspaceName:'Existing cloud machine',state:'paused',generation:1,profileKey:'starter',cpuCount:1,memoryMiB:2048,systemDiskGiB:8,
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const api={
    developmentEnvironmentAction:async(id,action)=>{rebindResumes.push({id,action});machine.state='running';return machine;},
    listDevelopmentEnvironmentDirectory:async(environmentId,path)=>({environmentId,path,entries:[{name:'repo',path:'/home/user/repo',kind:'directory'}]}),
    createProject:async()=>{rebindCreates++;return {workspaceId:'created-workspace'};},
    rebindConversationWorkspace:async(...args)=>{rebindCalls.push(args);if(rebindFailNext){rebindFailNext=false;throw Error('Lost binding reply');}return {};},
  };
  root.render(React.createElement(I18nProvider,{initialLanguage:'en-US'},React.createElement(WorkspaceRebindDialog,{
    key:withMachine?'machine':'new',api,sessionId:'preserved-session',workspaces:[],environments:withMachine?[machine]:[],canMutate:true,
    onRefresh:async()=>{},onBound:async(id)=>{rebindBound.push(id);},onClose:()=>{},onOpenResources:()=>{},
  })));
};
window.renderChat = (sessionState='idle', history=false, childViews=false, peerForks=false) => {
  window.requestAnimationFrame = nativeRaf; window.cancelAnimationFrame = nativeCancelRaf;
  const sid = "10000000-0000-4000-8000-000000000001";
  const profileId = "20000000-0000-4000-8000-000000000001";
  const createdAt=new Date().toISOString();
  const project = {projectId:"30000000-0000-4000-8000-000000000001",workspaceId:"40000000-0000-4000-8000-000000000001",name:"fixture",createdAt,
    source:{kind:'empty',status:'ready'},environment:{environmentVersionId:'70000000-0000-4000-8000-000000000001',
      versionNumber:1,profileKey:'pi-cloud-fullstack',profileVersion:'1',imageRevision:'fixture',specSha256:DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
      recipe:DEFAULT_PROJECT_ENVIRONMENT_RECIPE,recipeSha256:DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,state:'pending',active:true,createdAt}};
  const models = [
    {...DEFAULT_NEW_CONVERSATION_MODEL,displayName:"Fixture GPT",default:true,thinkingLevels:["off","medium","high"],defaultThinkingLevel:"medium",fastModeAvailable:true},
    {provider:"deepseek",modelId:"deepseek-v4-flash",displayName:"Fixture DeepSeek",default:false,thinkingLevels:["off","medium","high"],defaultThinkingLevel:"high",fastModeAvailable:false}
  ];
  let selection = {...DEFAULT_NEW_CONVERSATION_MODEL,thinkingLevel:"medium",fastMode:false};
  let session;
  const fixtureTurnId='50000000-0000-4000-8000-000000000011';
  window.fixtureQueue={sessionId:sid,revision:0,activeTurnId:sessionState==='running'?fixtureTurnId:null,items:[]};
  window.steerRequests=[];window.steerReceipts=new Map();
  window.usageReads=0;window.compactRequests=[];window.compactReceipts=new Map();window.compactValue=null;window.loseCompactReply=false;window.deferCompactReply=false;
  window.turnReceipts=new Map();
  window.turnStates=new Map();window.returnedInputs=null;window.returnInputsReady=true;
  const delegates=['branch','fresh'].map((contextMode,index)=>({sessionId:'10000000-0000-4000-8000-00000000000'+(index+2),
    executionId:'80000000-0000-4000-8000-00000000000'+(index+1),parentSessionId:sid,rootSessionId:sid,parentTurnId:fixtureTurnId,
    depth:1,title:contextMode+' child',contextMode,sandboxMode:'shared',state:'completed',workspaceName:'fixture',createdAt}));
  if(childViews) session={sessionId:sid,projectId:project.projectId,workspaceId:project.workspaceId,title:'Parent conversation',
    executionMode:'elastic',sandboxProfileKey:'starter',workingDirectory:'/workspace',state:sessionState,workspaceState:'attached',modelProfileId:profileId,
    createdAt,updatedAt:createdAt,lastActiveAt:createdAt};
  const tree=(label,sessionId=sid)=>({currentSessionId:sessionId,branches:[{sessionId,parentSessionId:sessionId===sid?null:sid,
    kind:sessionId===sid?'conversation':'subagent',title:'Fixture tree',current:true,
    entries:[{entryId:'answer-entry',turnId:fixtureTurnId,role:'assistant',text:label,finalAssistant:true}]}],delegatedSessions:[]});
  window.treeRequests=[];window.deferTrees=false;
  window.historyMutations=[];
  window.fixtureParentDeleted=false;window.fixtureForkDeleted=false;window.fixtureSourcePointGone=false;window.sourceNavigationReads=[];
  const forkSessionId='10000000-0000-4000-8000-000000000009';
  const sourceId=peerForks==='child'?delegates[0].sessionId:sid;
  const sourceTitle=peerForks==='child'?delegates[0].title:'Parent conversation';
  window.holdNextConversationList=false;
  const conversation=(sessionId=sid)=>({project,session:{...session,sessionId,...(peerForks&&sessionId===forkSessionId?{title:'Independent Fork',forkSource:{sessionId:sourceId,turnId:fixtureTurnId,entryId:'answer-entry',title:window.fixtureParentDeleted?null:sourceTitle}}:{}),...(peerForks&&sessionId!==sid&&sessionId!==forkSessionId?{title:sourceTitle}:{}),...(window.fixtureWorkspaceMissing?{workspaceState:'missing'}:{})},inheritedMessages:[],turns:history?[{
    turnId:fixtureTurnId,runId:'60000000-0000-4000-8000-000000000011',mailboxPosition:1,prompt:'Tree question',state:sessionState==='running'?'running':'completed',acceptedAt:createdAt,
    transcript:{schemaVersion:1,throughSequence:sessionState==='running'?2:3,startedSequence:1,terminalSequence:sessionState==='running'?null:3,stopReason:sessionState==='running'?null:'stop',failure:null,cancellation:null,
      items:window.fixtureToolHistory??[{kind:'text',text:'Tree answer',firstSequence:2,lastSequence:2}]}
  }]:[],history:{before:null,after:null,hasBefore:false,hasAfter:false}});
  const modelResource = () => ({sessionId:sid,modelProfileId:profileId,...selection,
    displayName:models.find(m=>m.provider===selection.provider).displayName});
  Object.assign(PiCloudApi.prototype, {
    getIdentity:async()=>{
      if(window.identityErrorStatus!==undefined)throw new PiCloudApiError(window.identityErrorStatus,'fixture-unavailable','Fixture identity service unavailable');
      return {tenantId:"test-tenant",userId:window.fixtureUserId??"test-user",displayName:"Fixture",role:"owner",platformAdministrator:false};
    },
    listConversations:async()=>{
      const listed={conversations:[...(peerForks&&!window.fixtureForkDeleted?[{...session,sessionId:forkSessionId,title:'Independent Fork',workspaceName:'fixture'}]:[]),...(childViews&&!window.fixtureParentDeleted?[{...session,workspaceName:'fixture'}]:[])],
        delegatedSessions:childViews&&!window.fixtureParentDeleted?delegates:[]};
      if(window.holdNextConversationList){window.holdNextConversationList=false;return new Promise(resolve=>{window.finishOldConversationList=()=>resolve(listed);});}
      return listed;
    },
    deleteConversation:async(id)=>{if(peerForks&&id===forkSessionId)window.fixtureForkDeleted=true;else window.fixtureParentDeleted=true;return {};},
    listWorkspaces:async()=>{
      if(window.holdWorkspaceList) await new Promise(resolve=>{window.releaseWorkspaceList=resolve;});
      return {workspaces:[{...project,sessionCount:0,lastActiveAt:new Date().toISOString()}],truncated:false};
    },
    listDevelopmentEnvironments:async()=>({environments:[],profiles:DEVELOPMENT_ENVIRONMENT_PROFILES,truncated:false}),
    getModelCatalog:async()=>({models,revision:"a".repeat(64),reloadFailed:false,defaultModel:DEFAULT_NEW_CONVERSATION_MODEL}),
    getConversationTree:async(sessionId,view)=>{
      if(peerForks){
        if(window.fixtureParentDeleted&&sessionId!==forkSessionId)throw new PiCloudApiError(404,'not_found','Source deleted');
        const result=tree('Initial tree',sessionId);result.delegatedSessions=window.fixtureParentDeleted?[]:delegates;
        if(sessionId===forkSessionId)result.branches[0]={...result.branches[0],kind:'conversation',parentSessionId:null};
        return result;
      }
      return window.deferTrees?new Promise(resolve=>window.treeRequests.push({view,resolve:label=>resolve(tree(label,sessionId))}))
      :history?tree('Initial tree',sessionId):{branches:[],delegatedSessions:[]};
    },
    pruneConversation:async(sessionId)=>{window.historyMutations.push({operation:'prune',sessionId});return {prunedTurnCount:0};},
    createSession:async (projectId,workspaceId,title,executionMode,sandboxProfileKey,workingDirectory,model)=>{
      selection=model; window.savedSelection=selection;
      session={sessionId:sid,projectId,workspaceId,title,executionMode,sandboxProfileKey,workingDirectory,state:sessionState,workspaceState:"attached",modelProfileId:profileId,createdAt:new Date().toISOString()};
      return session;
    },
    uploadWorkspaceFile:async(sessionId,id,file,name,signal)=>{
      window.uploadCalls.push({sessionId,id,name,size:file.size});
      if(window.failNextUpload){window.failNextUpload=false;throw Error('Fixture upload failed');}
      if(window.holdUpload)await new Promise((resolve,reject)=>{window.finishUpload=resolve;signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
      const upload={id,sessionId,workspaceId:session.workspaceId,name,path:'/workspace/uploads/'+id+'/'+name,mimeType:file.type||'application/octet-stream',byteLength:file.size,sha256:'a'.repeat(64),...(file.type==='image/png'?{image:{id,byteLength:file.size,mimeType:'image/png',sha256:'a'.repeat(64)}}:{})};
      window.uploadReceipts.push(upload);return upload;
    },
    removeDraftUpload:async()=>{},
    readInputImage:async()=>({bytes:Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2uV8AAAAASUVORK5CYII='),c=>c.charCodeAt(0)),contentType:'image/png'}),
    getSessionModel:async()=>modelResource(),
    getConversation:async(sessionId,query)=>{
      if(peerForks){window.sourceNavigationReads.push({sessionId,query});if(sessionId!==forkSessionId&&(window.fixtureParentDeleted||(window.fixtureSourcePointGone&&query?.entryId)))throw new PiCloudApiError(404,'not_found','Source point unavailable');}
      const view=conversation(sessionId);
      if(!window.raceTurn)return view;
      const next={...view,turns:[...view.turns,window.raceTurn]};
      if(window.holdTurnMetadata)return new Promise(resolve=>{window.releaseTurnMetadata=()=>resolve(next);});
      return next;
    },
    getInputQueue:async(sessionId)=>parseInputQueueResource({...structuredClone(window.fixtureQueue),sessionId,
      viewVersion:String(window.fixtureQueue.revision),revision:window.fixtureQueue.revision.toString(16).padStart(64,"0")+"."+"a".repeat(64),afterPosition:0,hasMore:false,
      hasReturnedInputs:!!window.returnedInputs,
      items:window.fixtureQueue.items}),
  });
  const nativeFetch=window.fetch;
  window.fetch=async (url,init={})=>{
    if(String(url).endsWith('/usage')){
      window.usageReads++;
      const tokens={input:7000,output:1000,cacheRead:6000,cacheWrite:0,total:8000};
      return Response.json({sessionId:String(url).split('/').at(-2),nativeSequence:7,observedAt:new Date().toISOString(),source:'postgres',inFlight:sessionState==='running',
        model:{provider:'openai-codex',modelId:'gpt-6.1-sol'},tokens,models:[],children:[],includingChildren:tokens,context:{estimatedTokens:9000,window:1000000,compactThreshold:900000,method:'latest_usage'}});
    }
    if(String(url).endsWith('/compact')){
      if((init.method??'GET')==='GET')return Response.json(window.compactValue);
      const key=new Headers(init.headers).get('idempotency-key'),body=JSON.parse(init.body);
      window.compactRequests.push({key,body});
      let value=window.compactReceipts.get(key);
      if(!value){const id=crypto.randomUUID(),initialOperation=sessionState!=='running';value={commandId:id,sessionId:sid,runId:initialOperation?crypto.randomUUID():'60000000-0000-4000-8000-000000000011',
        turnId:initialOperation?id:fixtureTurnId,initialOperation,state:'summarizing',acceptedAt:new Date().toISOString(),nativeSequence:7,replayed:false};window.compactReceipts.set(key,value);}
      window.compactValue=value;
      if(window.loseCompactReply){window.loseCompactReply=false;throw new Error('Fixture lost compact reply');}
      if(window.deferCompactReply)return new Promise(resolve=>{window.releaseCompactReply=()=>resolve(Response.json(value));});
      return Response.json(value);
    }

    if(String(url)==="/v1/auth/logout") return window.rejectLogout
      ? Response.json({error:{code:"conflict",message:"Fixture rejects logout"}},{status:503})
      : Response.json({loggedOut:true});
    if(String(url).endsWith("/events")) return new Response(new ReadableStream({start(controller){
      if(childViews) {
        const snapshot={schemaVersion:3,conversation:conversation(String(url).split('/').at(-2))};
        const frame=(event,data)=>'event: '+event+'\\n'+'data: '+JSON.stringify(data)+'\\n\\n';
        window.emitFixtureEvent=event=>controller.enqueue(new TextEncoder().encode(frame(event.type,event)));
        window.finishFixtureTurn=()=>controller.enqueue(new TextEncoder().encode(frame('turn.completed',{
          schemaVersion:1,eventId:'90000000-0000-4000-8000-000000000001',sessionId:snapshot.conversation.session.sessionId,
          turnId:fixtureTurnId,agentId:'root',seq:3,occurredAt:new Date().toISOString(),type:'turn.completed',payload:{stopReason:'stop'}
        })));
        controller.enqueue(new TextEncoder().encode(frame('stream.begin',{kind:'snapshot'})+
          frame('stream.part',JSON.stringify(snapshot))+frame('stream.end',{})));
      }
      init.signal?.addEventListener("abort",()=>controller.close(),{once:true});
    }}),{headers:{"content-type":"text/event-stream"}});
    if(String(url).endsWith("/model") && init.method==="PUT") {
      selection=JSON.parse(init.body); window.savedSelection=selection;
      return Response.json(modelResource());
    }
    if(String(url).endsWith('/cancellations')) {
      const requestId=crypto.randomUUID();
      const items=[...window.turnReceipts.entries()].filter(([,r])=>window.turnStates.get(r.inputId??r.runId)==='queued')
        .map(([key,r],index)=>{
          window.turnStates.set(r.inputId??r.runId,'cancelled');
          const body=window.turnRequests.find(call=>call.key===key).body;
          return {inputId:r.inputId??r.turnId,idempotencyKey:key,text:body.prompt,mailboxPosition:index+1,
            uploads:(body.uploadIds??[]).map(id=>window.uploadReceipts.find(file=>file.id===id))};
        });
      window.returnedInputs={requestId,items};window.fixtureQueue.revision++;
      return Response.json({controlRequestId:requestId,targetRunId:'60000000-0000-4000-8000-000000000011',
        turnId:fixtureTurnId,sessionId:sid,state:'pending',acceptedAt:new Date().toISOString(),replayed:false},{status:202});
    }
    if(String(url).endsWith('/returned-inputs/acknowledgements')) {
      window.returnedInputs=null;window.fixtureQueue.revision++;
      return new Response(null,{status:204});
    }
    if(String(url).includes('/returned-inputs')) {
      const batch=window.returnedInputs,afterPosition=Number(new URL(String(url),location.origin).searchParams.get('afterPosition')??0);
      return Response.json({sessionId:sid,requestId:batch?.requestId??null,afterPosition,
        pending:!!batch&&!window.returnInputsReady,hasMore:false,
        items:batch&&window.returnInputsReady?batch.items.filter(item=>item.mailboxPosition>afterPosition):[]});
    }
    if(String(url).endsWith("/steers")) {
      const body=JSON.parse(init.body),key=new Headers(init.headers).get('idempotency-key');
      window.steerRequests.push({body,key});
      const previous=window.steerReceipts.get(key);
      const source='input-'+String(31+window.steerReceipts.size).padStart(64,'0');
      const receipt=previous??{kind:'input',inputId:source,runId:'60000000-0000-4000-8000-000000000011',turnId:fixtureTurnId,
        delivery:'steer',sessionId:sid,state:'accepted',acceptedAt:new Date().toISOString(),replayed:false};
      if(!previous){window.steerReceipts.set(key,receipt);window.fixtureQueue.revision++;
        window.fixtureQueue.items.push({inputId:source,runId:receipt.runId,text:body.text,uploads:(body.uploadIds??[]).map(id=>window.uploadReceipts.find(upload=>upload.id===id)),mailboxPosition:window.fixtureQueue.items.length+1,acceptedAt:receipt.acceptedAt,status:'steering'});}
      if(window.loseSteerReply){window.loseSteerReply=false;throw Error('Fixture lost Steer response');}
      return Response.json({...receipt,replayed:!!previous},{status:202});
    }
    if(String(url).endsWith("/turns")) {
      const submitted=JSON.parse(init.body);window.turnBodies.push(submitted);
      const key=new Headers(init.headers).get('idempotency-key');
      window.turnRequests.push({key,body:submitted});
      if(window.startBeforeAck){
        const turnId='50000000-0000-4000-8000-000000000012',runId='60000000-0000-4000-8000-000000000012';
        const acceptedAt=new Date().toISOString();
        window.raceTurn={turnId,runId,mailboxPosition:2,prompt:submitted.prompt,uploads:(submitted.uploadIds??[]).map(id=>window.uploadReceipts.find(u=>u.id===id)),state:'running',acceptedAt,
          transcript:{schemaVersion:1,throughSequence:5,startedSequence:4,terminalSequence:null,stopReason:null,failure:null,cancellation:null,
            items:[{kind:'text',messageId:'race-text',text:'Working on the new request',phase:'commentary',firstSequence:5,lastSequence:5}]}};
        const envelope={schemaVersion:1,eventId:'90000000-0000-4000-8000-000000000012',sessionId:sid,turnId,agentId:'root',occurredAt:acceptedAt};
        window.emitFixtureEvent({...envelope,seq:4,type:'turn.started',payload:{inputKind:'prompt'}});
        window.emitFixtureEvent({...envelope,eventId:'90000000-0000-4000-8000-000000000013',seq:5,type:'assistant.text.delta',payload:{messageId:'race-text',text:'Working on the new request',phase:'commentary'}});
        return new Promise((resolve,reject)=>{window.releaseTurnAck=()=>window.failRaceAck?reject(new TypeError('Lost accepted response')):resolve(Response.json({kind:'run',turnId,runId,sessionId:sid,mailboxPosition:2,state:'queued',acceptedAt,replayed:false},{status:202}));});
      }
      if(window.deferTurn) return new Promise(resolve=>{
        window.finishTurn=()=>{
          window.fixtureQueue.revision++;window.fixtureQueue.items=[{inputId:"50000000-0000-4000-8000-000000000001",runId:"60000000-0000-4000-8000-000000000001",text:submitted.prompt,mailboxPosition:1,acceptedAt:new Date().toISOString(),status:"queued"}];
          resolve(Response.json({kind:"run",turnId:"50000000-0000-4000-8000-000000000001",
          sessionId:sid,runId:"60000000-0000-4000-8000-000000000001",mailboxPosition:1,
          state:"queued",acceptedAt:new Date().toISOString(),replayed:false},{status:202}));
        };
      });
      if(window.acceptTurns) {
        const prior=window.turnReceipts.get(key);
        const receipt=prior??(sessionState==='running'?{kind:'input',inputId:'input-'+crypto.randomUUID().replaceAll('-','').repeat(2),
          turnId:fixtureTurnId,runId:'60000000-0000-4000-8000-000000000011',sessionId:sid,delivery:'follow_up',state:'accepted',acceptedAt:new Date().toISOString()}:
          {kind:'run',turnId:crypto.randomUUID(),sessionId:sid,runId:crypto.randomUUID(),mailboxPosition:window.turnReceipts.size+1,state:'queued',acceptedAt:new Date().toISOString()});
        if(!prior){window.turnReceipts.set(key,receipt);window.turnStates.set(receipt.inputId??receipt.runId,'queued');
          if(receipt.kind==='input'){window.fixtureQueue.revision++;window.fixtureQueue.items.push({inputId:receipt.inputId,runId:receipt.runId,text:submitted.prompt,
            uploads:(submitted.uploadIds??[]).map(id=>window.uploadReceipts.find(upload=>upload.id===id)),mailboxPosition:window.fixtureQueue.items.length+1,acceptedAt:receipt.acceptedAt,status:'queued'});}}

        if(window.loseTurnReply){window.loseTurnReply=false;throw Error('Fixture lost Turn response after commit');}
        return Response.json({...receipt,replayed:!!prior},{status:202});
      }
      // Capture the real request builder without creating a model Run.
      return Response.json({error:{code:"conflict",message:"Fixture does not execute models"}},{status:409});
    }
    return nativeFetch(url,init);
  };
  root.render(React.createElement(I18nProvider,{initialLanguage:"en-US"},React.createElement(ChatApp,{key:sessionState+String(history)+String(childViews)+String(peerForks)+String(window.identityErrorStatus),configuration})));
};
window.renderGeneratedImage=()=>root.render(React.createElement(Markdown,null,
  '![Character design](/v1/sessions/10000000-0000-4000-8000-000000000001/images/10000000-0000-4000-8000-000000000002)'));
window.renderShownImage=(toolName='show_image',status='running')=>{
  window.requestAnimationFrame=nativeRaf;window.cancelAnimationFrame=nativeCancelRaf;
  const tool={kind:'tool',key:'shown',toolCallId:'task:2',toolName,input:{path:'/workspace/screenshot.png',caption:'页面效果 <script>'},
    output:{content:[{type:'text',text:'Image prepared from /workspace/screenshot.png'},
      {type:'image',imageId:'10000000-0000-4000-8000-000000000002',mimeType:'image/png',
        previewPath:'/v1/sessions/10000000-0000-4000-8000-000000000001/images/10000000-0000-4000-8000-000000000002'}],
      details:{imageCaption:'页面效果 <script>'}},status:'completed',firstSequence:2,lastSequence:3,
    startedAt:'2026-10-25T00:00:00.000Z',completedAt:'2026-10-25T00:00:01.000Z'};
  root.render(React.createElement(I18nProvider,{initialLanguage:'zh-CN'},React.createElement(ConversationTurn,{
    key:toolName+status,turn:{runId:'shown-run',turnId:'shown-turn',prompt:'给我看看页面效果',acceptedAt:null,mailboxPosition:1,
      status,startedSequence:1,terminalSequence:status==='completed'?6:null,stopReason:status==='completed'?'stop':null,failure:null,cancellation:null,
      items:[{...tool,key:'before',toolCallId:'task:1',toolName:'bash',input:{command:'take screenshot'},output:'Ready'},tool,
        {...tool,key:'after',toolCallId:'task:3',toolName:'bash',input:{command:'continue work'},output:'Done',firstSequence:4,lastSequence:5}]
    }
  })));
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
          if (
            req.url ===
            "/v1/sessions/10000000-0000-4000-8000-000000000001/images/10000000-0000-4000-8000-000000000002"
          ) {
            res.setHeader("content-type", "image/png");
            return res.end(
              Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA3UAAAAASUVORK5CYII=",
                "base64",
              ),
            );
          }
          if (req.url === "/ui-config.json") {
            const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
            res.setHeader("content-type", "application/json");
            return res.end(
              JSON.stringify({
                productUrl: origin,
                adminUrl: origin,
                managementUrls: {
                  providerGateway: "",
                  grafana: "",
                  prometheus: "",
                  alertmanager: "",
                  jaeger: "",
                },
              }),
            );
          }
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
          if (new URL(req.url ?? "/", "http://fixture.invalid").pathname !== "/review.html")
            return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/presentation-fixture.js"></script>',
          );
        });
      },
    },
  ],
});
try {
  await server.listen();
  const port = server.httpServer.address().port;
  for (const source of ["parent", "child"]) {
    await withChromePage({ peerForks: true }, async (page) => {
      await page.navigate(`http://127.0.0.1:${port}/review.html`);
      await page.waitFor("window.fixtureReady");
      await page.evaluate(
        `renderChat('idle',true,true,${JSON.stringify(source)});window.confirm=()=>true`,
      );
      const humans = ".product-conversation-row:not(.product-delegated-session)";
      await page.waitFor(`document.querySelectorAll('${humans}').length===2`);
      const layout = await page.evaluate(
        `(()=>{const rows=[...document.querySelectorAll('${humans}')];return {names:rows.map(r=>r.querySelector('strong').textContent),left:rows.map(r=>r.getBoundingClientRect().left),nested:rows.some(r=>r.parentElement.parentElement.closest('.product-conversation-tree-node')),children:document.querySelectorAll('.product-delegated-session').length};})()`,
      );
      assert.deepEqual(layout.names, ["Independent Fork", "Parent conversation"]);
      assert.equal(layout.left[0], layout.left[1]);
      assert.equal(layout.nested, false);
      assert.equal(layout.children, 2);
      const openFork = async () => {
        await page.evaluate(
          `document.querySelectorAll('${humans} > button:first-child')[0].click()`,
        );
        await page.waitFor(
          "document.querySelector('.product-topbar-title strong')?.textContent==='Independent Fork'",
        );
        await page.waitFor("document.querySelector('.product-fork-source')");
      };
      await openFork();
      await page.screenshot(`/tmp/pi-cloud-peer-forks-${source}.png`);
      await page.evaluate("document.querySelector('.product-fork-source').click()");
      await page.waitFor(
        source === "child"
          ? "document.querySelector('.product-delegated-title')?.textContent.includes('Read only')"
          : "document.querySelector('.product-topbar-title strong')?.textContent==='Parent conversation'",
      );
      assert(
        await page.evaluate("sourceNavigationReads.some(r=>r.query?.entryId==='answer-entry')"),
      );
      await openFork();
      if (source === "parent") {
        await page.evaluate(
          "window.fixtureSourcePointGone=true;document.querySelector('.product-fork-source').click()",
        );
        await page.waitFor(
          "document.querySelector('.product-topbar-title strong')?.textContent==='Parent conversation'",
        );
        assert.equal(
          await page.evaluate("Boolean(document.querySelector('.product-error-banner'))"),
          false,
        );
        await openFork();
      }
      await page.evaluate(
        `document.querySelectorAll('${humans} .product-delete-conversation')[1].click()`,
      );
      await page.waitFor(`document.querySelectorAll('${humans}').length===1`);
      await page.waitFor("document.querySelector('.product-fork-source-unavailable')");
      assert.equal(
        await page.evaluate("document.querySelector('.product-topbar-title strong').textContent"),
        "Independent Fork",
      );
      assert.equal(
        await page.evaluate("document.querySelectorAll('.product-delegated-session').length"),
        0,
      );
      for (const width of [1280, 390]) {
        await page.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page.wait(100);
        assert(await page.evaluate("document.documentElement.scrollWidth<=innerWidth+1"));
      }
      console.log(
        JSON.stringify({
          peerForks: true,
          source,
          flatRows: true,
          sourceNavigation: true,
          independentDelete: true,
        }),
      );
    });
  }
  await withChromePage({}, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.waitFor("window.fixtureReady");
    await page.evaluate("renderRetry(2)");
    await page.waitFor(
      "document.querySelector('.product-lifecycle-retry')?.textContent.includes('第 2 次')",
    );
    await page.evaluate(
      "void(window.retryElement=document.querySelector('.product-lifecycle-retry'))",
    );
    for (const attempt of [3, 4]) {
      await page.evaluate(`renderRetry(${attempt})`);
      await page.waitFor(
        `document.querySelector('.product-lifecycle-retry')?.textContent.includes('第 ${attempt} 次')`,
      );
      assert.equal(
        await page.evaluate("document.querySelectorAll('.product-lifecycle-retry').length"),
        1,
      );
      assert(
        await page.evaluate(
          "window.retryElement===document.querySelector('.product-lifecycle-retry')",
        ),
        "Retry counter should update the same row",
      );
    }
    await page.evaluate("reloadRetry()");
    await page.waitFor(
      "document.querySelector('.product-lifecycle-retry')?.textContent.includes('第 4 次')",
    );
    assert.equal(
      await page.evaluate("document.querySelectorAll('.product-lifecycle-retry').length"),
      1,
    );
  });
  await withChromePage({ toolGroups: true }, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.waitFor("window.fixtureReady");
    for (const [status, result] of [
      ["completed", "FINAL_RESULT"],
      ["failed", "Command exited with code 7"],
      ["unknown", "Execution outcome is unknown"],
    ]) {
      await page.evaluate("renderToolSettlement()");
      await page.waitFor("document.querySelector('.product-activity-group-toggle')");
      await page.evaluate(
        "if(document.querySelector('.product-activity-group-toggle').getAttribute('aria-expanded')==='false')document.querySelector('.product-activity-group-toggle').click()",
      );
      await page.waitFor("document.querySelector('.product-tool-progress button')");
      await page.evaluate(
        "document.querySelector('.product-tool-progress button').click();emitToolPreview('TEMPORARY_ONLY')",
      );
      await page.waitFor(
        "document.querySelector('.product-tool-progress-tail')?.textContent==='TEMPORARY_ONLY'",
      );
      await page.evaluate(
        `renderToolSettlement(${JSON.stringify(status)},${JSON.stringify(result)})`,
      );
      await page.waitFor(
        `!document.querySelector('.product-tool-progress') && document.body.textContent.includes(${JSON.stringify(result)})`,
      );
      await page.evaluate("emitToolPreview('LATE_PREVIEW')");
      assert.equal(
        await page.evaluate(
          "toolProgressStore.get('settlement-turn'+String.fromCharCode(0)+'settling')",
        ),
        undefined,
      );
      assert.equal(
        await page.evaluate(
          "document.body.textContent.includes('TEMPORARY_ONLY') || document.body.textContent.includes('LATE_PREVIEW')",
        ),
        false,
      );
      const borders = await page.evaluate(
        `(()=>{const g=document.querySelector('.product-activity-group');return{group:getComputedStyle(g).borderLeftColor,tools:[...g.querySelectorAll('.product-tool')].map(t=>({failed:t.classList.contains('product-tool-failed'),marker:getComputedStyle(t,'::before').backgroundColor}))}})()`,
      );
      assert.equal(
        borders.group,
        "rgb(53, 53, 53)",
        "A failed Tool must not color the whole group border",
      );
      assert.equal(
        borders.tools.filter((tool) => tool.marker === "rgb(103, 70, 70)").length,
        status === "failed" ? 1 : 0,
      );
      assert(borders.tools.every((tool) => tool.marker !== "rgb(103, 70, 70)" || tool.failed));
    }
    await page.evaluate("renderToolSettlement('failed','Command exited with code 7',true)");
    await page.waitFor("document.querySelectorAll('.product-tool').length===1");
    assert.equal(
      await page.evaluate(
        "getComputedStyle(document.querySelector('.product-tool'),'::before').backgroundColor",
      ),
      "rgb(103, 70, 70)",
    );
  });
  await withChromePage({ toolGroups: true }, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.evaluate(
      "history.replaceState(null,'','/review.html?session=10000000-0000-4000-8000-000000000001')",
    );
    await page.waitFor("window.fixtureReady");
    await page.evaluate(`window.fixtureToolHistory=[
      {kind:'tool',toolCallId:'task:1',toolName:'bash',input:{command:'INPUT_START'+String.fromCharCode(10)+'line'+(String.fromCharCode(10)+'line').repeat(20)+String.fromCharCode(10)+'INPUT_END'},output:{content:[{type:'text',text:'RESULT_START'+String.fromCharCode(10)+'line'+(String.fromCharCode(10)+'line').repeat(25)+String.fromCharCode(10)+'WIDTH_'+ 'W'.repeat(8000)+String.fromCharCode(10)+'RESULT_END'}]},status:'completed',firstSequence:1,lastSequence:2,startedAt:'2026-10-27T00:00:00Z',completedAt:'2026-10-27T00:00:01Z'},
      {kind:'tool',toolCallId:'task:2',toolName:'preview',input:{port:8080},output:{content:[{type:'text',text:'PREVIEW_DETAIL_'+ 'W'.repeat(8000)}]},status:'completed',firstSequence:1,lastSequence:2,startedAt:'2026-10-27T00:00:00Z',completedAt:'2026-10-27T00:00:01Z'}];renderChat('running',true,true)`);
    await page.waitFor(
      "document.querySelector('.product-activity-group-toggle') && document.querySelector('.product-tool-group-display-toggle')?.disabled===false",
    );
    await page.evaluate("document.querySelector('.product-activity-group-toggle').click()");
    await page.waitFor("document.querySelector('.product-tool[data-tool-name=bash]')");
    const originalBash = await page.evaluate(
      "document.querySelector('.product-tool[data-tool-name=bash]').innerHTML",
    );
    await page.evaluate("document.querySelector('.product-tool-group-display-toggle').click()");
    await page.waitFor(
      "document.querySelector('.product-tool-group-display-toggle').getAttribute('aria-pressed')==='true'",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-tool[data-tool-name=bash]').innerHTML"),
      originalBash,
      "The toolbar must only change group defaults",
    );
    assert.equal(
      await page.evaluate(
        "document.querySelectorAll('.product-tool[data-tool-name=bash] details').length",
      ),
      0,
    );
    assert.equal(
      await page.evaluate("document.querySelectorAll('.product-tool details[open]').length"),
      0,
      "Existing ordinary Tool details stay closed",
    );
    await page.evaluate(
      "document.querySelector('.product-tool[data-tool-name=preview] details summary').click()",
    );
    await page.waitFor(
      "document.querySelector('.product-tool[data-tool-name=preview] details[open]')",
    );
    const checkWidth = async () => {
      const size = await page.evaluate(
        `(()=>{const p=document.querySelector('.product-chat-scroll');return{viewport:innerWidth,document:document.documentElement.scrollWidth,pane:p.clientWidth,content:p.scrollWidth}})()`,
      );
      assert(
        size.document <= size.viewport + 1 && size.content <= size.pane + 1,
        "Tool content widened the page: " + JSON.stringify(size),
      );
    };
    await checkWidth();
    await page.evaluate(
      "document.querySelector('.product-tool[data-tool-name=bash] .product-tool-text button').click()",
    );
    await page.waitFor(
      "document.querySelector('.product-chat-scroll').textContent.includes('INPUT_END')",
    );
    await page.evaluate("document.querySelector('.product-tool-group-display-toggle').click()");
    await page.waitFor("document.querySelectorAll('.product-tool').length===0");
    await page.evaluate("document.querySelector('.product-tool-group-display-toggle').click()");
    await page.waitFor(
      "document.querySelector('.product-tool[data-tool-name=preview] details[open]') && document.querySelector('.product-chat-scroll').textContent.includes('INPUT_END')",
    );
    assert(
      !(await page.evaluate(
        "document.querySelector('.product-chat-scroll').textContent.includes('RESULT_START')",
      )),
      "Group mode must not expand result text",
    );
    await page.evaluate("document.querySelector('.product-activity-group-toggle').click()");
    await page.waitFor("document.querySelectorAll('.product-tool').length===0");
    await page.evaluate(
      `emitFixtureEvent({schemaVersion:1,eventId:crypto.randomUUID(),sessionId:'10000000-0000-4000-8000-000000000001',turnId:'50000000-0000-4000-8000-000000000011',agentId:'root',seq:3,occurredAt:new Date().toISOString(),type:'tool.started',payload:{toolCallId:'task:3',toolName:'bash',input:{command:'NEXT_INPUT'}}});emitFixtureEvent({schemaVersion:1,eventId:crypto.randomUUID(),sessionId:'10000000-0000-4000-8000-000000000001',turnId:'50000000-0000-4000-8000-000000000011',agentId:'root',seq:4,occurredAt:new Date().toISOString(),type:'tool.completed',payload:{toolCallId:'task:3',outcome:'completed',output:{content:[{type:'text',text:'NEXT_RESULT'}]}}})`,
    );
    await page.wait(300);
    assert.equal(
      await page.evaluate("document.querySelectorAll('.product-tool').length"),
      0,
      "New results must respect an explicitly closed group",
    );
    await page.evaluate("document.querySelector('.product-activity-group-toggle').click()");
    await page.waitFor(
      "document.querySelector('.product-chat-scroll').textContent.includes('NEXT_RESULT')",
    );
    assert.equal(
      await page.evaluate(
        "document.querySelectorAll('.product-tool[data-tool-name=bash] details').length",
      ),
      0,
    );
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await page.wait(400);
    await checkWidth();
  });
  await withChromePage({}, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.waitFor("window.fixtureReady");
    await page.evaluate("renderRebind(true)");
    await page.waitFor(
      "document.querySelector('.product-rebind-modal select') && !document.querySelector('.product-rebind-modal fieldset').disabled",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-rebind-modal select').value"),
      "machine-fixture",
    );
    await page.evaluate(
      "Array.from(document.querySelectorAll('.product-rebind-modal button')).find(b=>b.textContent.includes('Choose directory')).click()",
    );
    await page.waitFor("document.querySelector('.product-directory-entry-directory')");
    await page.evaluate("document.querySelector('.product-directory-entry-directory').click()");
    await page.waitFor(
      "document.querySelector('.product-directory-selection code')?.textContent==='/home/user/repo'",
    );
    await page.evaluate(
      "document.querySelector('.product-directory-picker footer .product-primary-button').click()",
    );
    await page.waitFor(
      "document.querySelector('.product-rebind-modal code')?.textContent==='/home/user/repo'",
    );
    await page.evaluate(
      "document.querySelector('.product-rebind-modal button[type=submit]').click()",
    );
    await page.waitFor("rebindBound.length===1");
    assert.deepEqual(
      await page.evaluate(
        "rebindCalls.map(([session,workspace,key,cwd])=>({session,workspace,cwd}))",
      ),
      [{ session: "preserved-session", workspace: "machine-workspace", cwd: "/home/user/repo" }],
    );
    assert.equal(await page.evaluate("rebindCreates"), 0);
    assert.deepEqual(await page.evaluate("rebindResumes"), [
      { id: "machine-fixture", action: "resume" },
    ]);
    await page.evaluate("renderRebind(false)");
    await page.waitFor(
      "document.querySelector('.product-rebind-modal input[maxlength]') && !document.querySelector('.product-rebind-modal fieldset').disabled",
    );
    await page.evaluate(
      "const e=document.querySelector('.product-rebind-modal input[maxlength]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Replacement');e.dispatchEvent(new Event('input',{bubbles:true}));",
    );
    await page.waitFor(
      "!document.querySelector('.product-rebind-modal button[type=submit]').disabled",
    );
    await page.evaluate(
      "document.querySelector('.product-rebind-modal button[type=submit]').click()",
    );
    await page.waitFor(
      "document.querySelector('.product-rebind-modal [role=alert]') && !document.querySelector('.product-rebind-modal button[type=submit]').disabled",
    );
    await page.evaluate(
      "document.querySelector('.product-rebind-modal button[type=submit]').click()",
    );
    await page.waitFor("rebindBound.length===1");
    assert.equal(await page.evaluate("rebindCreates"), 1);
    assert.equal(
      await page.evaluate("rebindCalls.length===2 && rebindCalls[0][2]===rebindCalls[1][2]"),
      true,
    );
    await page.evaluate("localStorage.clear(); renderPanel()");
    await page.waitFor('document.querySelector("#panel")');
    assert.equal(await page.evaluate('document.querySelector("#panel").dataset.width'), "280");
    await page.evaluate(
      `document.querySelector("#panel").dispatchEvent(new PointerEvent("pointerdown", {bubbles:true,clientX:100})); window.dispatchEvent(new PointerEvent("pointermove", {clientX:140}));`,
    );
    await page.waitFor('document.querySelector("#panel").dataset.width === "320"');
    const target = "Durable text with live animation. ".repeat(300);
    const commentary = "正在查看入口逻辑和配置，接着检查相关测试。".repeat(12);
    await page.evaluate(`renderTurn(${JSON.stringify(commentary)},0,'running',null,'commentary')`);
    await page.waitFor("document.querySelector('.product-agent-stage')");
    assert.equal(
      await page.evaluate("document.querySelector('.product-agent-stage').textContent"),
      "",
    );
    assert((await page.evaluate("advanceFrame()")) > 0);
    await page.waitFor("document.querySelector('.product-agent-stage').textContent.length > 0");
    const commentaryPrefix = await page.evaluate(
      "document.querySelector('.product-agent-stage').textContent",
    );
    assert(commentary.startsWith(commentaryPrefix));
    assert(commentaryPrefix.length < commentary.length, "One frame flushed the entire commentary");

    // A reconnect must reveal already-seen commentary immediately on the same item.
    await page.evaluate(
      `renderTurn(${JSON.stringify(commentary)},${commentary.length},'running',null,'commentary')`,
    );
    await page.waitFor(
      `document.querySelector('.product-agent-stage')?.textContent===${JSON.stringify(commentary)}`,
    );
    const commentaryWithSuffix = commentary + "继续检查后续行为，并确认输出正确。".repeat(8);
    await page.evaluate(
      `renderTurn(${JSON.stringify(commentaryWithSuffix)},${commentary.length},'running',null,'commentary')`,
    );
    // React may not have applied the new props when the CDP render call returns.
    // Pump the controlled clock until the newly scheduled suffix frame runs.
    await page.waitFor(
      `(advanceFrame(), document.querySelector('.product-agent-stage').textContent.length > ${commentary.length})`,
    );
    const continuedCommentary = await page.evaluate(
      "document.querySelector('.product-agent-stage').textContent",
    );
    assert(continuedCommentary.startsWith(commentary));
    assert(continuedCommentary.length < commentaryWithSuffix.length);

    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const reducedMotionCommentary = commentaryWithSuffix + "已完成检查。";
    await page.evaluate(
      `renderTurn(${JSON.stringify(reducedMotionCommentary)},${commentary.length},'running',null,'commentary')`,
    );
    await page.waitFor(
      `document.querySelector('.product-agent-stage').textContent===${JSON.stringify(reducedMotionCommentary)}`,
    );
    await page.send("Emulation.setEmulatedMedia", { features: [] });
    assert.equal(await page.evaluate("document.querySelector('.product-agent-answer')"), null);
    // Working survives already-rendered commentary and silent model intervals.
    await page.waitFor("document.querySelector('.product-run-status')");
    await page.evaluate(
      `runObservations.receive({type:'run.activity',generation:1,sessionId:'s',turnId:'turn',runId:'run',revision:1,phase:'waiting_model',observedAt:Date.now(),lastActivityAt:Date.now()-20000});runObservations.receive({type:'run.path',generation:1,sessionId:'s',turnId:'turn',runId:'run',sentAt:Date.now(),observedAt:Date.now()})`,
    );
    await page.waitFor(
      "document.querySelector('.product-run-status').dataset.runPhase==='waiting_model'",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-run-diagnostics').open"),
      false,
    );
    assert.doesNotMatch(
      await page.evaluate("document.querySelector('.product-run-status').innerText"),
      /秒前|等待运行链路确认/u,
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-run-status > small[role=status]')"),
      null,
    );
    await page.evaluate("document.querySelector('.product-run-diagnostics > summary').click()");
    assert.match(
      await page.evaluate("document.querySelector('.product-run-status').innerText"),
      /最近活动 (?:19|20|21) 秒前/u,
    );
    await page.evaluate(
      "runObservations.receive({type:'run.path',generation:1,sessionId:'s',turnId:'turn',runId:'run',sentAt:Date.now()+1,observedAt:Date.now()+1})",
    );
    assert.match(
      await page.evaluate("document.querySelector('.product-run-status').innerText"),
      /最近活动 (?:19|20|21) 秒前/u,
    );
    await page.evaluate(
      "runObservations.receive({type:'run.activity',generation:2,sessionId:'s',turnId:'turn',runId:'run',revision:1,phase:'executing_tool',observedAt:Date.now(),lastActivityAt:Date.now()})",
    );
    await page.waitFor(
      "document.querySelector('.product-run-status').dataset.runPhase==='executing_tool'",
    );
    await page.evaluate(
      "runObservations.receive({type:'run.activity',generation:1,sessionId:'s',turnId:'turn',runId:'run',revision:100,phase:'waiting_model',observedAt:Date.now(),lastActivityAt:Date.now()})",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-run-status').dataset.runPhase"),
      "executing_tool",
    );
    await page.evaluate(
      "runObservations.receive({type:'run.execution',generation:2,sessionId:'s',turnId:'turn',runId:'run',revision:1,observedAt:Date.now(),execution:{status:'confirmed',stage:'worker',sentAt:Date.now(),confirmedAt:Date.now()}});runObservations.receive({type:'run.path',generation:2,sessionId:'s',turnId:'turn',runId:'run',sentAt:Date.now(),observedAt:Date.now()})",
    );
    await page.waitFor(
      "document.querySelector('.product-run-diagnostics').innerText.includes('沙箱往返')",
    );
    await page.evaluate("document.querySelector('.product-run-diagnostics > summary').click()");
    assert.doesNotMatch(
      await page.evaluate("document.querySelector('.product-run-status').innerText"),
      /秒前|沙箱往返/u,
    );
    // Stale/disconnected warnings remain visible without opening diagnostics.
    await page.evaluate("window.statusClock=Date.now;Date.now=()=>statusClock()+46000");
    await page.waitFor(
      "document.querySelector('.product-run-status > small[role=status]')?.innerText==='运行状态更新延迟'",
    );
    await page.evaluate("Date.now=window.statusClock;delete window.statusClock");
    await page.evaluate("renderTurn('Status',0,'running',null,undefined,false)");
    await page.waitFor(
      "document.querySelector('.product-run-status > small[role=status]')?.innerText.includes('连接中断')",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-run-diagnostics').open"),
      false,
    );
    await page.evaluate("renderTurn('Status',0,'running')");
    await page.waitFor("!document.querySelector('.product-run-status > small[role=status]')");
    await page.evaluate("renderTurn('Status',0,'cancelling')");
    await page.waitFor(
      "document.querySelector('.product-run-status').dataset.runPhase==='cancelling'",
    );
    await page.evaluate("runObservations.reset();renderTurn('Status',0,'queued')");
    await page.waitFor(
      "document.querySelector('.product-run-status').dataset.runPhase==='queued' && !document.querySelector('.product-run-diagnostics')",
    );
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
    assert.equal(await page.evaluate("document.querySelector('.product-run-status')"), null);
    assert.equal(
      await page.evaluate("document.querySelector('.product-agent-answer p')===stableParagraph"),
      true,
      "Settlement must not replace already-rendered Markdown nodes",
    );
    await page.evaluate("renderTurn('',0,'completed','length')");
    await page.waitFor(
      "document.querySelector('.product-muted-line[role=status]')?.textContent.includes('输出上限')",
    );
    await page.evaluate("renderTurn('Complete',8,'completed','stop')");
    await page.waitFor("!document.querySelector('.product-muted-line[role=status]')");
    await page.evaluate("renderPanel()");
    await page.waitFor('document.querySelector("#panel")');
    await page.evaluate(
      'document.querySelector("#panel").dispatchEvent(new PointerEvent("pointerdown", {bubbles:true,clientX:100})); window.dispatchEvent(new PointerEvent("pointercancel"));',
    );
    assert.equal(
      await page.evaluate('document.body.classList.contains("product-panel-resizing")'),
      false,
    );
    // A cached failed Session must still be able to request server-authoritative
    // admission after its execution exit/seal recover; rejected input stays intact.
    await page.evaluate("renderChat('failed')");
    await page.waitFor('document.querySelector(".product-model-menu-trigger")');
    const fill = async (selector, value) => {
      await page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
        const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});
        el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const chooseFixtureWorkspace = async () => {
      await page.waitFor(
        "document.querySelector('.product-progressive-options select option[value=\"40000000-0000-4000-8000-000000000001\"]')",
      );
      await page.evaluate(`(()=>{
        const select=document.querySelector('.product-progressive-options select');
        select.value='40000000-0000-4000-8000-000000000001';
        select.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await page.waitFor(
        "document.querySelectorAll('.product-progressive-options input').length===1",
      );
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
    await chooseFixtureWorkspace();
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
      modelId: "gpt-6.1-sol",
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
    await page.evaluate("window.acceptTurns=true;window.loseTurnReply=true");
    await fill(".product-composer textarea", "one ordinary submission");
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor(
      "turnReceipts.size===1 && !document.querySelector('.product-send-button').disabled",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-composer textarea').value"),
      "one ordinary submission",
    );
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor("document.querySelector('.product-composer textarea').value===''");
    assert.equal(await page.evaluate("turnReceipts.size"), 1);
    assert.deepEqual(
      await page.evaluate("turnRequests.slice(-2).map(r=>r.key)"),
      Array(2).fill(await page.evaluate("turnRequests.at(-1).key")),
    );
    await fill(".product-composer textarea", "one ordinary submission");
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor(
      "turnReceipts.size===2 && document.querySelector('.product-composer textarea').value===''",
    );

    await page.evaluate("window.acceptTurns=false;window.deferTurn=true");
    await fill(".product-composer textarea", "submitted draft");
    await page.waitFor('!document.querySelector(".product-send-button").disabled');
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor("typeof window.finishTurn==='function'");
    await page.evaluate("document.querySelector('.product-new-chat').click()");
    assert.equal(
      await page.evaluate("document.querySelector('.product-workspace-modal')===null"),
      true,
      "New chat must not reset the view while an accepted-input request is in flight",
    );
    await fill(".product-composer textarea", "next draft");
    await page.evaluate("finishTurn()");
    await page.waitFor(
      'document.querySelector(".pending-input-content p")?.textContent==="submitted draft"',
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
    assert.equal(
      await page.evaluate(
        "[...document.querySelectorAll('button')].some(b=>['云手机','Cloud phone'].includes(b.textContent.trim()))",
      ),
      false,
      "The phone prototype must not have a product-page entry",
    );
    const mobileChat = await page.evaluate(
      "document.querySelector('.product-main').clientHeight===innerHeight",
    );
    await page.evaluate("renderAdmin()");
    await page.waitFor("document.querySelector('.product-admin-page')");
    await page.waitFor(
      "Array.from(document.querySelectorAll('.product-admin-page option')).some(o=>o.textContent==='Future model')",
    );
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
    await page.evaluate("window.holdWorkspaceList=true;renderChat('idle',true)");
    await page.waitFor("document.querySelector('.product-new-chat')");
    await page.evaluate("document.querySelector('.product-new-chat').click()");
    await page.waitFor("document.querySelector('.product-execution-mode-choice input')");
    await page.evaluate("document.querySelector('.product-execution-mode-choice input').click()");
    await page.waitFor("document.querySelector('.product-progressive-options input')");
    await page.waitFor("typeof window.releaseWorkspaceList==='function'");
    await page.evaluate("window.holdWorkspaceList=false;window.releaseWorkspaceList()");
    // Opening before the list arrives legitimately defaults to a new Workspace.
    // Select the fixture explicitly instead of racing that initialization.
    await chooseFixtureWorkspace();
    await fill(".product-progressive-options input", "Tree response race");
    assert.equal(
      await page.evaluate("document.querySelector('.product-workspace-modal').checkValidity()"),
      true,
    );
    await page.evaluate("document.querySelector('.product-workspace-modal').requestSubmit()");
    await page.waitFor("document.querySelector('.product-prune-action')?.disabled===false");
    await page.evaluate(
      "window.deferTrees=true;window.confirm=()=>true;document.querySelector('.product-prune-action').click()",
    );
    await page.waitFor("treeRequests.length===1");
    await page.evaluate("document.querySelectorAll('.product-tree-view-switch button')[1].click()");
    await page.waitFor("treeRequests.length===2");
    await page.evaluate("treeRequests[1].resolve('Current full tree')");
    await page.waitFor(
      "document.querySelector('.product-tree-panel').textContent.includes('Current full tree')",
    );
    await page.evaluate("treeRequests[0].resolve('Stale focus tree')");
    await page.wait(50);
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-tree-panel').textContent.includes('Current full tree')",
      ),
      true,
      "A late refresh from the old tree view must not replace the current tree",
    );
    // Exercise ChatApp's actual parent/child selection and snapshot path, not
    // just a ConversationTurn rendered with an already-disabled prop.
    await page.evaluate("renderChat('idle',true,true);window.confirm=()=>true");
    await page.waitFor("document.querySelectorAll('.product-delegated-session').length===2");
    const forkButton =
      "Array.from(document.querySelectorAll('.product-answer-actions button')).find(b=>b.textContent.includes('↳'))";
    const parentButton =
      ".product-conversation-row:not(.product-delegated-session) > button:first-child";
    await page.evaluate(`document.querySelector(${JSON.stringify(parentButton)}).click()`);
    await page.waitFor("document.querySelector('.product-prune-action')?.disabled===false");
    assert.equal(await page.evaluate(`${forkButton}.disabled`), false);
    for (const width of [1280, 390]) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.waitFor("document.querySelector('.product-answer-actions .product-message-copy')");
      const actions = await page.evaluate(`(()=>{
        const fork=${forkButton};
        const copy=fork.parentElement.querySelector('.product-message-copy');
        const a=copy.getBoundingClientRect(),b=fork.getBoundingClientRect();
        return {centerDifference:Math.abs(a.y+a.height/2-b.y-b.height/2),
          copies:document.querySelectorAll('.product-answer-actions .product-message-copy').length,
          bodyCopies:document.querySelectorAll('.product-agent-answer .product-message-copy').length};
      })()`);
      assert(actions.centerDifference < 1, `Copy and fork must share an action row at ${width}px`);
      assert.equal(actions.copies, 1);
      assert.equal(
        actions.bodyCopies,
        0,
        "The final answer must not retain a duplicate body button",
      );
    }
    assert.equal(
      await page.evaluate(`(async()=>{
        const descriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
        let copied;
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied=text;}}});
        try {
          document.querySelector('.product-answer-actions .product-message-copy').click();
          await Promise.resolve();
          return copied;
        } finally {
          if(descriptor)Object.defineProperty(navigator,'clipboard',descriptor);else delete navigator.clipboard;
        }
      })()`),
      "Tree answer",
    );
    await page.send("Emulation.clearDeviceMetricsOverride");
    for (const mode of ["branch", "fresh"]) {
      await page.evaluate(
        `document.querySelector('.product-delegated-session.${mode} > button').click()`,
      );
      await page.waitFor(`document.querySelector('.product-delegated-session.${mode}.active')`);
      await page.waitFor("document.querySelector('.product-prune-action')");
      assert.deepEqual(
        await page.evaluate(
          `({fork:${forkButton}.disabled,prune:document.querySelector('.product-prune-action').disabled})`,
        ),
        { fork: true, prune: true },
        `${mode} child history must remain read-only`,
      );
      await page.evaluate(
        `${forkButton}.click();document.querySelector('.product-prune-action').click()`,
      );
      assert.equal(
        await page.evaluate("document.querySelector('.product-fork-modal')===null"),
        true,
      );
      assert.deepEqual(await page.evaluate("historyMutations"), []);
    }
    await page.evaluate(`document.querySelector(${JSON.stringify(parentButton)}).click()`);
    await page.waitFor("document.querySelector('.product-prune-action')?.disabled===false");
    await page.evaluate(`${forkButton}.click()`);
    await page.waitFor("document.querySelector('.product-fork-modal')");
    await page.evaluate("document.querySelector('.product-fork-modal header button').click()");
    await page.evaluate("document.querySelector('.product-prune-action').click()");
    await page.waitFor("historyMutations.length===1");
    assert.deepEqual(await page.evaluate("historyMutations"), [
      { operation: "prune", sessionId: "10000000-0000-4000-8000-000000000001" },
    ]);
    await page.waitFor(
      "!document.querySelector('.product-delegated-session.branch > button').disabled",
    );
    await page.evaluate(
      "window.fixtureWorkspaceMissing=true;document.querySelector('.product-delegated-session.branch > button').click()",
    );
    await page.waitFor("document.querySelector('.product-workspace-missing-banner')");
    assert.equal(
      await page.evaluate("document.querySelector('.product-rebind-modal')===null"),
      true,
      "A read-only Child must not be asked to rebind its execution Workspace",
    );
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-workspace-missing-banner button').disabled",
      ),
      true,
    );
    await page.evaluate(`document.querySelector(${JSON.stringify(parentButton)}).click()`);
    await page.waitFor("document.querySelector('.product-rebind-modal')");
    await page.evaluate(
      "document.querySelector('.product-rebind-modal header button').click();window.fixtureWorkspaceMissing=false",
    );

    await page.evaluate("renderChat('running',true,true);window.confirm=()=>true");
    await page.waitFor("document.querySelector('.product-delete-conversation')");
    await page.evaluate(`document.querySelector(${JSON.stringify(parentButton)}).click()`);
    await page.waitFor("document.querySelector('.product-stop-button')");
    await page.evaluate("document.querySelector('.product-account-menu-trigger').click()");
    await page.waitFor("document.querySelector('.product-account-menu-panel:not([hidden])')");
    await page.evaluate(
      "document.querySelectorAll('.product-account-composer-setting button')[1].click()",
    );
    await fill(".product-composer textarea", "recover my direct instruction");
    await page.evaluate(
      "window.loseSteerReply=true;document.querySelector('.product-send-button').click()",
    );
    await page.waitFor(
      "document.body.textContent.includes('Control plane is unreachable') && !document.querySelector('.product-send-button').disabled",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-composer textarea').value"),
      "recover my direct instruction",
    );
    await page.evaluate("document.querySelector('.product-send-button').click()");
    await page.waitFor(
      "document.querySelector('.product-stop-button') && document.querySelector('.product-composer textarea').value===''",
    );
    assert.deepEqual(
      await page.evaluate(
        "({calls:steerRequests.length,keys:new Set(steerRequests.map(r=>r.key)).size,inputs:fixtureQueue.items.length,status:fixtureQueue.items[0].status})",
      ),
      { calls: 2, keys: 1, inputs: 1, status: "steering" },
    );
    await page.waitFor(
      "document.querySelector('.pending-input-queue')?.textContent.includes('recover my direct instruction')",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-steer-notice')===null"),
      true,
    );
    await page.evaluate("document.querySelector('.product-account-menu-trigger').click()");
    await page.evaluate(
      "document.querySelectorAll('.product-account-composer-setting button')[0].click()",
    );
    await page.evaluate("window.holdNextConversationList=true;finishFixtureTurn()");
    await page.waitFor("typeof window.finishOldConversationList==='function'");
    await page.evaluate("document.querySelector('.product-delete-conversation').click()");
    await page.waitFor("document.querySelectorAll('.product-conversation-row').length===0");
    await page.evaluate("finishOldConversationList()");
    await page.wait(50);
    assert.equal(
      await page.evaluate("document.querySelectorAll('.product-conversation-row').length"),
      0,
      "A late pre-deletion list must not resurrect a deleted conversation or its children",
    );

    // A first, image-only message survives Session creation and sends references,
    // while retries and picker cancellation keep the original upload identity.
    await page.evaluate(
      "window.deferTurn=false;window.acceptTurns=true;window.loseTurnReply=true;renderChat('idle')",
    );
    await page.waitFor('document.querySelector(".product-attach-button")');
    const countBeforeImage = await page.evaluate("turnBodies.length");
    await page.evaluate(`(() => {
      const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2uV8AAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'screenshot.png',{type:'image/png'}));
      const picker=document.querySelector('input[type=file]');picker.files=data.files;picker.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await page.waitFor('document.querySelector(".upload-card")');
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor('document.querySelector(".product-execution-mode-choice input")');
    await page.evaluate('document.querySelector(".product-execution-mode-choice input").click()');
    await chooseFixtureWorkspace();
    await fill(".product-progressive-options input", "Image input");
    await page.evaluate('document.querySelector(".product-workspace-modal").requestSubmit()');
    await page.waitFor(`turnBodies.length===${countBeforeImage + 1}`);
    const firstImageBody = await page.evaluate("turnBodies.at(-1)");
    assert.equal(firstImageBody.prompt, "");
    assert.equal(firstImageBody.uploadIds.length, 1);
    assert.equal(await page.evaluate("uploadCalls.at(-1).id"), firstImageBody.uploadIds[0]);
    assert.equal(
      await page.evaluate('document.querySelector(".product-composer textarea").value'),
      "",
    );
    await page.waitFor('!document.querySelector(".product-send-button").disabled');
    await page.evaluate('document.querySelector(".product-send-button").click()');
    await page.waitFor(`turnBodies.length===${countBeforeImage + 2}`);
    assert.deepEqual(await page.evaluate("turnBodies.at(-1).uploadIds"), firstImageBody.uploadIds);
    assert.equal(await page.evaluate("turnReceipts.size"), 1);
    assert.equal(await page.evaluate("turnRequests.at(-1).key===turnRequests.at(-2).key"), true);
    await page.waitFor('!document.querySelector(".upload-card")');
    await page.evaluate("window.acceptTurns=false");

    // Actual ChatApp + validated HTTP responses: Stop ends only the returned
    // admission identity, including when a newer post-Stop request loses its ACK.
    for (const newerSubmission of [false, true]) {
      await page.navigate(`http://127.0.0.1:${port}/review.html`);
      await page.waitFor("window.fixtureReady");
      await page.evaluate(
        "renderChat('running',true,true);window.acceptTurns=true;window.deferTurn=false",
      );
      await page.waitFor(`document.querySelector(${JSON.stringify(parentButton)})`);
      await page.evaluate(`document.querySelector(${JSON.stringify(parentButton)}).click()`);
      await page.waitFor("document.querySelector('.product-stop-button')");
      await fill(".product-composer textarea", "returned image instruction");
      await page.evaluate(`(() => {
        const files=new DataTransfer();
        files.items.add(new File(['image fixture'],'returned.png',{type:'image/png'}));
        const picker=document.querySelector('input[type=file]');picker.files=files.files;
        picker.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await page.waitFor(
        "document.querySelector('.upload-card') && document.querySelector('.product-send-button')?.disabled===false",
      );
      await page.evaluate(
        "window.loseTurnReply=true;document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
      );
      await page.waitFor(
        "turnReceipts.size===1 && document.querySelector('.product-send-button')?.disabled===false",
      );
      const original = await page.evaluate("turnRequests.at(-1)");
      assert.equal(original.body.uploadIds.length, 1);
      await fill(".product-composer textarea", "");
      await page.evaluate(
        "document.querySelector('.upload-card button[aria-label^=\"Remove attachment\"]').click()",
      );
      await page.evaluate(
        `window.returnInputsReady=${!newerSubmission};document.querySelector('.product-stop-button').click()`,
      );
      await page.waitFor(
        "window.returnedInputs && !document.querySelector('.product-composer textarea').disabled",
      );
      await page.evaluate("window.dispatchEvent(new Event('focus'))");
      if (newerSubmission) {
        await fill(".product-composer textarea", "newer instruction");
        await page.waitFor("document.querySelector('.product-send-button')?.disabled===false");
        await page.evaluate(
          "window.loseTurnReply=true;document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
        );
        await page.waitFor(
          "turnReceipts.size===2 && document.querySelector('.product-send-button')?.disabled===false",
        );
        await page.evaluate("window.returnInputsReady=true");
      }
      await page.waitFor(
        "document.querySelector('.product-composer textarea').value.includes('returned image instruction') && document.querySelector('.upload-card')",
      );
      if (newerSubmission) {
        assert.equal(
          await page.evaluate("document.querySelector('.product-composer textarea').value"),
          "newer instruction\n\nreturned image instruction",
        );
        await fill(".product-composer textarea", "newer instruction");
        await page.evaluate(
          "document.querySelector('.upload-card button[aria-label^=\"Remove attachment\"]').click()",
        );
      }
      await page.waitFor("document.querySelector('.product-send-button')?.disabled===false");
      await page.evaluate(
        "document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
      );
      await page.waitFor("document.querySelector('.product-composer textarea').value===''");
      assert.equal(await page.evaluate("turnReceipts.size"), 2);
      assert.deepEqual(await page.evaluate("[...turnStates.values()]"), ["cancelled", "queued"]);
      const last = await page.evaluate("turnRequests.at(-1)");
      if (newerSubmission) {
        assert.equal(
          last.key,
          await page.evaluate("turnRequests.at(-2).key"),
          "An old return must preserve the newer uncertain key",
        );
      } else {
        assert.notEqual(last.key, original.key, "Returned input must create a new admission");
        assert.deepEqual(last.body.uploadIds, original.body.uploadIds);
      }
      await page.waitFor("window.returnedInputs===null");
    }

    for (const status of [503, 0]) {
      await page.evaluate(`window.identityErrorStatus=${status};renderChat()`);
      await page.waitFor(
        "document.querySelector('.product-identity-error, form.product-auth-card')",
      );
      assert.equal(
        await page.evaluate("document.querySelector('form.product-auth-card')===null"),
        true,
        "Unavailable identity service must not masquerade as a logged-out user",
      );
      let reloads = 0;
      const stop = page.onRequest((url) => {
        if (url.endsWith("/review.html")) reloads++;
      });
      try {
        await page.evaluate("document.querySelector('.product-identity-error button').click()");
        await page.waitFor("window.fixtureReady && window.identityErrorStatus===undefined");
        assert(reloads > 0, "Retry must reload the identity check");
      } finally {
        stop();
      }
    }
    await page.evaluate("window.identityErrorStatus=401;renderChat()");
    await page.waitFor("document.querySelector('form.product-auth-card')");
    await page.evaluate("window.identityErrorStatus=undefined");
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
  // The SSE start may beat both the submit reply and the input metadata GET.
  // Observe every DOM mutation so a brief invented/old user bubble cannot pass.
  await withChromePage({}, async (page) => {
    const currentTurn =
      '.product-turn[data-conversation-turn-id="50000000-0000-4000-8000-000000000012"]';
    for (const first of ["acceptance", "discovery", "lost-acceptance"]) {
      await page.navigate(`http://127.0.0.1:${port}/review.html`);
      await page.waitFor("window.fixtureReady");
      await page.evaluate("renderChat('idle',true,true)");
      await page.waitFor(
        "document.querySelector('.product-conversation-row:not(.product-delegated-session)>button')",
      );
      await page.evaluate(
        "document.querySelector('.product-conversation-row:not(.product-delegated-session)>button').click()",
      );
      await page.waitFor(
        "document.querySelector('.product-turn .product-user-bubble')?.textContent==='Tree question' && window.emitFixtureEvent",
      );
      const fill = async (text) => {
        await page.evaluate(
          "document.querySelector('.product-composer textarea').focus();document.querySelector('.product-composer textarea').select()",
        );
        await page.send("Input.insertText", { text });
      };
      const input = "我的新消息：检查按钮闪动";
      await fill(input);
      await page.evaluate(
        `window.bubbleFrames=[];window.bubbleObserver=new MutationObserver(()=>{window.bubbleFrames.push([...document.querySelectorAll(${JSON.stringify(currentTurn + " .product-user-bubble")})].map(e=>e.textContent));});window.bubbleObserver.observe(document.querySelector('.product-transcript'),{subtree:true,childList:true,characterData:true});window.startBeforeAck=true;window.holdTurnMetadata=true;window.failRaceAck=${first === "lost-acceptance"};document.querySelector('.product-send-button').click()`,
      );
      await page.waitFor(
        `document.querySelector(${JSON.stringify(currentTurn + " .product-run-status")}) && window.releaseTurnMetadata && window.releaseTurnAck`,
      );
      // A new Run exists, but neither source has yet confirmed its input to the browser.
      assert.equal(
        await page.evaluate(
          `document.querySelector(${JSON.stringify(currentTurn + " .product-user-message")})===null`,
        ),
        true,
      );
      assert.equal(
        await page.evaluate(
          `document.querySelector(${JSON.stringify(currentTurn)})?.textContent.includes('Input was accepted')`,
        ),
        false,
      );
      await fill("发送过程中继续写的新草稿");
      if (first === "acceptance") await page.evaluate("releaseTurnAck()");
      else {
        if (first === "lost-acceptance") {
          await page.evaluate("releaseTurnAck()");
          await page.waitFor("document.body.textContent.includes('Control plane is unreachable')");
        }
        await page.evaluate("releaseTurnMetadata()");
      }
      await page.waitFor(
        `document.querySelector(${JSON.stringify(currentTurn + " .product-user-bubble")})?.textContent===${JSON.stringify(input)}`,
      );
      await page.evaluate(
        first === "acceptance"
          ? "releaseTurnMetadata()"
          : first === "discovery"
            ? "releaseTurnAck()"
            : "void 0",
      );
      await page.waitFor("document.querySelector('.product-send-button')?.disabled===false");
      assert.equal(
        await page.evaluate("document.querySelector('.product-composer textarea').value"),
        "发送过程中继续写的新草稿",
      );
      assert.equal(
        await page.evaluate(
          `document.querySelectorAll(${JSON.stringify(currentTurn + " .product-user-bubble")}).length`,
        ),
        1,
      );
      assert.equal(
        await page.evaluate(
          "bubbleFrames.flat().every(text=>text===" + JSON.stringify(input) + ")",
        ),
        true,
      );
      await page.waitFor(
        `[...document.querySelectorAll(${JSON.stringify(currentTurn)})].some(node=>node.textContent.includes('Working on the new request'))`,
      );
      await page.evaluate("bubbleObserver.disconnect()");
    }
  });
  // Composer keyboard/button choices use actual ChatApp effects and HTTP builders.
  await withChromePage({ width: 1280, height: 900 }, async (page) => {
    const parent = ".product-conversation-row:not(.product-delegated-session) > button";
    const fill = async (text) => {
      await page.evaluate(
        "document.querySelector('.product-composer textarea').focus();document.querySelector('.product-composer textarea').select()",
      );
      await page.send("Input.insertText", { text });
    };
    const key = async (key, extra = {}) =>
      page.evaluate(
        `document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key, bubbles: true, cancelable: true, ...extra })}))`,
      );
    const open = async (userId = "test-user") => {
      await page.navigate(`http://127.0.0.1:${port}/review.html`);
      await page.waitFor("window.fixtureReady");
      await page.evaluate(
        `window.fixtureUserId=${JSON.stringify(userId)};renderChat('running',true,true);window.acceptTurns=true`,
      );
      await page.waitFor(`document.querySelector(${JSON.stringify(parent)})`);
      await page.evaluate(`document.querySelector(${JSON.stringify(parent)}).click()`);
      await page.waitFor("document.querySelector('.product-stop-button')");
    };
    const chooseMode = async (index) => {
      await page.evaluate("document.querySelector('.product-account-menu-trigger').click()");
      await page.waitFor("document.querySelector('.product-account-menu-panel:not([hidden])')");
      await page.evaluate(
        `document.querySelectorAll('.product-account-composer-setting button')[${index}].click()`,
      );
    };
    await open();
    await key("Enter");
    assert.deepEqual(
      await page.evaluate("[turnRequests.length,steerRequests.length,!!window.returnedInputs]"),
      [0, 0, false],
    );
    await fill("第一条排队消息");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-send-button').getAttribute('aria-label')",
      ),
      "Queue message",
    );
    await key("Enter", { isComposing: true });
    await key("Enter", { keyCode: 229 });
    await key("Enter", { repeat: true });
    await key("Enter", { shiftKey: true });
    assert.equal(await page.evaluate("turnRequests.length"), 0);
    // Real Shift+Enter produces a newline rather than submitting.
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 8,
      text: "\r",
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 8,
    });
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-composer textarea').value.endsWith('\\n')",
      ),
      true,
    );
    await key("Enter");
    await page.waitFor("turnRequests.length===1 && document.querySelector('.product-stop-button')");
    assert.equal(await page.evaluate("steerRequests.length"), 0);
    assert.equal(await page.evaluate("fixtureQueue.items[0].status"), "queued");
    await fill("按钮也排队");
    await page.evaluate("document.querySelector('.product-send-button').click()");
    await page.waitFor("turnRequests.length===2 && document.querySelector('.product-stop-button')");
    await chooseMode(1);
    assert.equal(
      await page.evaluate("fixtureQueue.items.length"),
      2,
      "A preference change does not rewrite queued inputs",
    );
    await fill("现在引导");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-send-button').getAttribute('aria-label')",
      ),
      "Steer",
    );
    await key("Enter");
    await page.waitFor(
      "steerRequests.length===1 && document.querySelector('.product-stop-button')",
    );
    await fill("按钮也引导");
    await page.evaluate("document.querySelector('.product-send-button').click()");
    await page.waitFor(
      "steerRequests.length===2 && document.querySelector('.product-stop-button')",
    );
    assert.equal(await page.evaluate("document.querySelectorAll('.pending-input-row').length"), 3);
    await page.evaluate("document.querySelector('.pending-input-queue header button').click()");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===4");
    await page.screenshot("/tmp/pi-cloud-composer-desktop.png");
    // Persistence survives navigation, but never leaks to another account.
    await open();
    await fill("remember mode");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-send-button').getAttribute('aria-label')",
      ),
      "Steer",
    );
    await open("other-user");
    await fill("different account");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-send-button').getAttribute('aria-label')",
      ),
      "Queue message",
    );
    await open();
    // Attachment-only input uses the same preference; the queue uses compact chips.
    await page.evaluate(`(() => {const files=new DataTransfer();files.items.add(new File(['image'],'photo.png',{type:'image/png'}));
      const picker=document.querySelector('input[type=file]');picker.files=files.files;picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.waitFor("document.querySelector('.product-send-button')?.disabled===false");
    await key("Enter");
    await page.waitFor(
      "steerRequests.length===1 && document.querySelector('.product-stop-button')",
    );
    assert.equal(await page.evaluate("steerRequests[0].body.uploadIds.length"), 1);
    await page.waitFor("document.querySelector('.pending-input-queue .upload-chip img')");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.pending-input-queue .upload-card')===null && document.querySelector('.upload-chip').getBoundingClientRect().height<35",
      ),
      true,
    );
    // Escape inside the account menu closes only the menu, even with a draft.
    await fill("keep my draft");
    await page.evaluate(
      "document.querySelector('.product-account-menu-trigger').click();document.querySelector('.product-account-menu-trigger').focus()",
    );
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    assert.equal(await page.evaluate("!!window.returnedInputs"), false);
    await key("Escape", { isComposing: true });
    assert.equal(await page.evaluate("!!window.returnedInputs"), false);
    await key("Escape");
    await page.waitFor("window.returnedInputs");
    assert.equal(
      await page.evaluate("document.querySelector('.product-composer textarea').value"),
      "keep my draft",
    );
    // With disabled browser persistence, an in-document choice still works.
    await open();
    await page.evaluate("Storage.prototype.setItem=()=>{throw new Error('blocked')}");
    await chooseMode(0);
    await fill("storage blocked");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-send-button').getAttribute('aria-label')",
      ),
      "Queue message",
    );
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
    await page.waitFor(
      "document.querySelector('.product-sidebar').getBoundingClientRect().right<=0 && document.querySelector('.product-main').getBoundingClientRect().width===390",
    );
    assert.equal(await page.evaluate("innerWidth"), 390);
    await page.screenshot("/tmp/pi-cloud-composer-mobile.png");
  });
  await withChromePage({}, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.waitFor("window.fixtureReady");
    for (const status of ["running", "completed"]) {
      await page.evaluate(`renderPreviewPresentation(${JSON.stringify(status)})`);
      await page.waitFor(
        "document.querySelector('.product-markdown a')?.getAttribute('href')===previewFixturePath",
      );
      assert.equal(await page.evaluate("document.querySelectorAll('a').length"), 1);
      assert.equal(
        await page.evaluate("document.querySelector('.product-activity-group').dataset.expanded"),
        "false",
      );
      assert.equal(await page.evaluate("document.body.innerText.includes('5173')"), false);
      await page.evaluate("document.querySelector('.product-activity-group-toggle').click()");
      await page.waitFor("document.querySelector('[data-tool-name=preview] details')");
      assert.equal(
        await page.evaluate("document.querySelector('[data-tool-name=preview] details').open"),
        false,
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-tool-name=preview]').innerText.includes('5173')",
        ),
        false,
      );
      await page.evaluate("document.querySelector('[data-tool-name=preview] summary').click()");
      await page.waitFor(
        "document.querySelector('[data-tool-name=preview]').innerText.includes('5173')",
      );
      assert.equal(await page.evaluate("document.querySelectorAll('a').length"), 1);
      assert.equal(
        await page.evaluate("document.querySelector('.product-preview-tool-link')===null"),
        true,
      );
    }
    await page.evaluate("renderPreviewPresentation('completed',true,true)");
    await page.waitFor(
      "!document.querySelector('.product-activity-group') && document.querySelector('[data-tool-name=preview] details')",
    );
    assert.equal(
      await page.evaluate("document.querySelector('[data-tool-name=preview] details').open"),
      false,
    );
    assert.equal(await page.evaluate("document.body.innerText.includes('5173')"), false);
    assert.equal(await page.evaluate("document.querySelectorAll('a').length"), 1);
    await page.evaluate("renderPreviewPresentation('completed',false,true)");
    await page.waitFor("document.querySelector('.product-markdown')?.textContent==='应用已完成。'");
    assert.equal(
      await page.evaluate("document.querySelectorAll('a').length"),
      0,
      "Missing answer links must not generate a fallback action",
    );
    await page.screenshot("/tmp/pi-cloud-preview-tool-details.png");
  });
  await withChromePage({}, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.waitFor("window.fixtureReady");
    await page.evaluate("renderGeneratedImage()");
    await page.waitFor("document.querySelector('.product-session-image img')?.naturalWidth > 0");
    assert.equal(
      await page.evaluate("document.querySelector('.product-session-image img').alt"),
      "Character design",
    );
    for (const toolName of ["show_image", "generate_image"]) {
      for (const status of ["running", "completed"]) {
        await page.evaluate(
          `renderShownImage(${JSON.stringify(toolName)},${JSON.stringify(status)})`,
        );
        await page.waitFor("document.querySelector('.product-tool-images img')?.naturalWidth > 0");
        assert.equal(await page.evaluate("document.querySelectorAll('img').length"), 1);
        assert.equal(
          await page.evaluate(
            "document.querySelector('.product-tool-images').closest('.product-activity-group')",
          ),
          null,
        );
        assert.equal(
          await page.evaluate(
            "document.querySelector('.product-activity-group-toggle').getAttribute('aria-expanded')",
          ),
          "false",
        );
        assert.equal(
          await page.evaluate("document.body.innerText.includes('/workspace/screenshot.png')"),
          false,
        );
        assert.equal(
          await page.evaluate("document.querySelector('figcaption').textContent"),
          "页面效果 <script>",
        );
        assert.equal(await page.evaluate("document.querySelector('figcaption script')"), null);
        assert.equal(
          await page.evaluate(
            "document.querySelector('.product-tool-images a').getAttribute('target')",
          ),
          "_blank",
        );
        await page.evaluate("document.querySelector('.product-activity-group-toggle').click()");
        await page.waitFor(`document.querySelector('[data-tool-name=${toolName}] details')`);
        assert.equal(
          await page.evaluate(
            `document.querySelector('[data-tool-name=${toolName}] details').open`,
          ),
          false,
        );
        await page.evaluate(
          `document.querySelector('[data-tool-name=${toolName}] summary').click()`,
        );
        await page.waitFor("document.body.innerText.includes('/workspace/screenshot.png')");
        assert.equal(await page.evaluate("document.querySelectorAll('img').length"), 1);
      }
    }
    await page.screenshot("/tmp/pi-cloud-show-image-presentation.png");
  });
  // Input commands use the real composer and HTTP client, not model prompts.
  await withChromePage({ width: 1280, height: 900, commands: true }, async (page) => {
    const parent = ".product-conversation-row:not(.product-delegated-session) > button";
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.waitFor("window.fixtureReady");
    await page.evaluate(
      "window.fixtureUserId='command-contract-owner';renderChat('running',true,true);window.acceptTurns=true",
    );
    await page.waitFor(`document.querySelector(${JSON.stringify(parent)})`);
    await page.evaluate(`document.querySelector(${JSON.stringify(parent)}).click()`);
    await page.waitFor("document.querySelector('.product-stop-button')");
    const fill = async (text) => {
      await page.evaluate(
        "document.querySelector('.product-composer textarea').focus();document.querySelector('.product-composer textarea').select()",
      );
      await page.send("Input.insertText", { text });
    };
    const key = async (key, extra = {}) =>
      page.evaluate(
        `document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key, bubbles: true, cancelable: true, ...extra })}))`,
      );
    assert.equal(await page.evaluate("usageReads"), 0, "hidden usage must not load");
    await fill("/");
    await page.waitFor(
      "document.querySelectorAll('.product-command-menu [role=option]').length===2",
    );
    await key("Escape");
    await page.waitFor("!document.querySelector('.product-command-menu')");
    assert.equal(
      await page.evaluate("!!window.returnedInputs"),
      false,
      "menu Escape must not stop",
    );
    await fill("/usage");
    await key("Enter", { isComposing: true });
    assert.equal(await page.evaluate("usageReads"), 0);
    await key("Enter");
    await page.waitFor(
      "document.querySelector('.product-usage-panel')?.textContent.includes('7,000')",
    );
    assert.deepEqual(
      await page.evaluate("[turnRequests.length,steerRequests.length,compactRequests.length]"),
      [0, 0, 0],
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-composer textarea').value"),
      "",
    );
    await page.screenshot("/tmp/pi-cloud-usage-panel.png");
    await key("Escape");
    await page.waitFor("!document.querySelector('.product-usage-panel')");
    assert.equal(await page.evaluate("!!window.returnedInputs"), false);
    await fill("/compact 保留 API 和待办");
    await page.evaluate("window.loseCompactReply=true");
    await key("Enter");
    await page.waitFor(
      "compactRequests.length===1 && document.querySelector('.product-error-banner')",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-composer textarea').value"),
      "/compact 保留 API 和待办",
    );
    await key("Enter");
    await page.waitFor(
      "compactRequests.length===2 && document.querySelector('.product-composer textarea').value===''",
    );
    assert.equal(await page.evaluate("compactReceipts.size"), 1);
    assert.deepEqual(await page.evaluate("compactRequests.map(r=>r.body)"), [
      { instructions: "保留 API 和待办" },
      { instructions: "保留 API 和待办" },
    ]);
    assert.equal(await page.evaluate("compactRequests[0].key===compactRequests[1].key"), true);
    assert.deepEqual(await page.evaluate("[turnRequests.length,steerRequests.length]"), [0, 0]);
    await page.waitFor("document.querySelector('.product-compact-status.summarizing')");
    await page.evaluate(
      "window.compactValue={...window.compactValue,state:'awaiting_placement',nativeSequence:8};emitFixtureEvent({schemaVersion:1,eventId:crypto.randomUUID(),sessionId:compactValue.sessionId,turnId:compactValue.turnId,agentId:'root',occurredAt:new Date().toISOString(),seq:3,type:'model.sampling.started',payload:{stepSequence:1,stepSha256:'a'.repeat(64),samplingAttempt:1}})",
    );
    await page.waitFor("document.querySelector('.product-compact-status.awaiting_placement')");
    assert.equal(
      await page.evaluate("!!document.querySelector('.product-compact-status.applied')"),
      false,
    );
    await page.evaluate(
      "window.compactValue={...window.compactValue,state:'applied',nativeSequence:9};emitFixtureEvent({schemaVersion:1,eventId:crypto.randomUUID(),sessionId:compactValue.sessionId,turnId:compactValue.turnId,agentId:'root',occurredAt:new Date().toISOString(),seq:4,type:'model.sampling.completed',payload:{stepSequence:1,stepSha256:'a'.repeat(64),samplingAttempt:1,outcome:'completed',stopReason:'stop'}})",
    );
    await page.waitFor("document.querySelector('.product-compact-status.applied')");
    await fill("/compact keep decisions");
    await page.evaluate("window.deferCompactReply=true");
    await key("Enter");
    await page.waitFor('typeof window.releaseCompactReply==="function"');
    await fill("new unsent draft");
    await page.evaluate("releaseCompactReply()");
    await page.waitFor("!document.querySelector('.product-send-button').disabled");
    assert.equal(
      await page.evaluate("document.querySelector('.product-composer textarea').value"),
      "new unsent draft",
    );
    await fill("/workspace/file.ts");
    await key("Enter");
    await page.waitFor("turnRequests.length===1");
    assert.equal(await page.evaluate("turnRequests[0].body.prompt"), "/workspace/file.ts");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await fill("/usage");
    await key("Enter");
    await page.waitFor("document.querySelector('.product-usage-panel')");
    assert(await page.evaluate("document.documentElement.scrollWidth<=innerWidth"));
    await page.waitFor(
      "document.querySelector('.product-sidebar').getBoundingClientRect().right<=0 && document.querySelector('.product-main').getBoundingClientRect().width===390",
    );
    await page.waitFor(
      "document.querySelector('.product-usage-panel').getBoundingClientRect().left >= 0 && document.querySelector('.product-usage-panel').getBoundingClientRect().right <= innerWidth",
    );
    await page.screenshot("/tmp/pi-cloud-usage-mobile.png");
  });
  console.log(
    JSON.stringify(
      process.env.PI_CLOUD_BROWSER_SCOPE === "peer-forks"
        ? {
            accepted: true,
            scope: "peer-forks",
            flatHumanRows: true,
            delegatedSourcesReadOnly: true,
            sourceNavigation: true,
            prunedSourcePointFallback: true,
            independentDelete: true,
            deletedSourceLabel: true,
            boundedViewport: true,
          }
        : process.env.PI_CLOUD_BROWSER_SCOPE === "tool-groups"
          ? {
              accepted: true,
              scope: "tool-groups",
              groupingOnly: true,
              individualDetailsPreserved: true,
              boundedWidth: true,
              previewReplacedByFinalResult: true,
              latePreviewDiscarded: true,
              errorMarkerOnlyOnFailedTool: true,
            }
          : process.env.PI_CLOUD_BROWSER_SCOPE === "commands"
            ? {
                accepted: true,
                scope: "commands",
                slashUsageAndCompact: true,
                compactLostReplyAndDraftRetention: true,
                compactWaitsForPlacement: true,
              }
            : {
                accepted: true,
                scope: "all",
                slashUsageAndCompact: true,
                compactLostReplyAndDraftRetention: true,
                compactWaitsForPlacement: true,
                retainedSessionImageLoads: true,
                canonicalToolImagesOutsideCollapsedActivity: true,
                imageCaptionPlainTextAndDetailsNoDuplicate: true,
                previewUsesNamedAnswerLink: true,
                previewDetailsKeepPortAndResult: true,
                previewHasNoFallbackOrDuplicateCard: true,
                previewReplacedByFinalResult: true,
                latePreviewDiscarded: true,
                errorMarkerOnlyOnFailedTool: true,
                earlyRunNeverFabricatesUserInput: true,
                acceptanceDiscoveryRaceKeepsDraftAndStream: true,
                composerEnterPreference: true,
                composerButtonMatchesEnter: true,
                composerEmptyEnterSafe: true,
                composerImeAndShiftEnter: true,
                composerScopedEscapePreservesDraft: true,
                composerAccountIsolation: true,
                composerPreferencePersistenceFallback: true,
                directSteerRetryIdentity: true,
                ordinarySendRetryIdentity: true,
                initialImageSendRetryIdentity: true,
                directSteerPendingPresentation: true,
                machineWorkspaceRebind: true,
                rebindRetryUsesSameTargetAndKey: true,
                persistentRuntimeStatus: true,
                collapsedRuntimeDiagnostics: true,
                runtimeWarningsVisible: true,
                observationGenerationRecovery: true,
                separateActivityAndPath: true,
                firstImageOnlyMessage: true,
                uploadIdentityOnRetry: true,
                debuggerDisconnect: true,
                strictModeAnimation: true,
                commentaryAnimation: true,
                commentaryReconnectAndReducedMotion: true,
                outputLimitVisible: true,
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
                childHistoryReadOnlyAndParentActions: true,
                pendingInputNavigation: true,
                childWorkspaceReadOnly: true,
                unavailableIdentityRetry: true,
                staleConversationListAfterDelete: true,
                terminalSocketIsolation: true,
                directoryPickerLifecycle: true,
                responsivePageScrolling: true,
              },
    ),
  );
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
