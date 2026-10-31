// Production React components, synthetic content and real browser geometry.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { build, preview } from "vite";
import { withChromePage } from "./lib/chrome-cdp.mjs";

const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/history-layout",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const root = resolve("packages/web-ui");
const baseline = process.env.PI_CLOUD_LAYOUT_BASELINE_REVISION;
if (baseline) assert(/^[a-f0-9]{7,40}$/.test(baseline), "Use a committed baseline revision");
const scratch = await mkdtemp(join(tmpdir(), "pi-cloud-layout-"));
const entry = `
import React,{useState,useRef} from 'react';import{createRoot}from'react-dom/client';
import{ConversationTimeline}from'${root}/src/ConversationTimeline.tsx';
import{ConversationTurn}from'${root}/src/ConversationTurn.tsx';
import{createInitialSessionView,sessionViewReducer}from'${root}/src/session-view.ts';
import{I18nProvider}from'${root}/src/i18n.tsx';import'${root}/src/product.css';
const paragraph='A coding conversation mixes short progress notes, longer explanations and completed tool calls. 中文文本会随着容器宽度变化重新换行。 ';
function turn(i,session='one'){const id=session+'-turn-'+i;return {turnId:id,runId:id,mailboxPosition:i+1,prompt:'Review request '+i,acceptedAt:null,status:'completed',startedSequence:i*10+1,terminalSequence:i*10+9,stopReason:'stop',failure:null,cancellation:null,items:[
{kind:'text',key:id+'-text',messageId:'entry:'+(i*10+2)+':0',text:paragraph.repeat(2+i%5),firstSequence:i*10+2,lastSequence:i*10+2,recoveredTextLength:10000},
{kind:'tool',key:id+'-tool',toolCallId:'task:'+(i*10+3),toolName:'bash',input:{command:'npm test'},output:{content:[{type:'text',text:'Test output\\n'.repeat(30)}]},status:'completed',firstSequence:i*10+3,lastSequence:i*10+4,startedAt:'2026-10-27T00:00:00Z',completedAt:'2026-10-27T00:00:01Z'},
{kind:'tool',key:id+'-tool2',toolCallId:'task:'+(i*10+5),toolName:'preview',input:{port:8080},output:{content:[{type:'text',text:'Preview output'}]},status:'completed',firstSequence:i*10+5,lastSequence:i*10+6,startedAt:'2026-10-27T00:00:00Z',completedAt:'2026-10-27T00:00:01Z'},
{kind:'text',key:id+'-final',messageId:'entry:'+(i*10+5)+':0',text:'Completed '+i+'\\n\\n'+paragraph.repeat(1+i%3),firstSequence:i*10+5,lastSequence:i*10+5,recoveredTextLength:10000}]};}
function state(id='one',start=0){return {...createInitialSessionView(),session:{sessionId:id},turns:Array.from({length:80},(_,i)=>turn(start+i,id)),history:{before:null,after:null,hasBefore:false,hasAfter:false}};}
window.historyRequests=[];window.historyResponses=[];
const api={getConversation:async(id,query)=>{historyRequests.push(query);if(!query.after&&query.direction!=='after')throw Error('Unexpected history direction');await new Promise(r=>setTimeout(r,80));return {project:{},session:{sessionId:id,state:'running'},inheritedMessages:[],turns:[],history:{before:null,after:null,hasBefore:false,hasAfter:false},...historyResponses.shift()};}};
window.layoutErrors=[];window.layoutSamples=[];window.resizeSamples=[];window.layoutLabel='open';window.firstRowsAt=null;
addEventListener('error',e=>layoutErrors.push(e.message));addEventListener('unhandledrejection',e=>layoutErrors.push(String(e.reason)));
window.geometry=()=>{const p=document.querySelector('.product-chat-scroll');if(!p)return null;const box=p.getBoundingClientRect();const rows=[...p.querySelectorAll('[data-history-row-key]')].map(n=>({i:Number(n.dataset.index),key:n.dataset.historyRowKey,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,height:n.getBoundingClientRect().height}));let gap=0,overlap=0;for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i];if(b.i===a.i+1&&b.top>box.top&&a.bottom<box.bottom){gap=Math.max(gap,b.top-a.bottom);overlap=Math.max(overlap,a.bottom-b.top);}}return {gap,overlap,rows:rows.length,scroll:p.scrollTop,total:p.scrollHeight,end:p.scrollHeight-p.scrollTop-p.clientHeight,key:rows.find(n=>n.bottom>box.top+2)?.key,offset:(rows.find(n=>n.bottom>box.top+2)?.top??box.top)-box.top};};
window.watchLayout=()=>{const p=document.querySelector('.product-chat-scroll');const observed=new WeakSet();const ro=new ResizeObserver(()=>{const g=geometry();if(g)resizeSamples.push({label:layoutLabel,t:performance.now(),...g});});const watch=()=>{for(const n of p.querySelectorAll('[data-history-row-key]'))if(!observed.has(n)){observed.add(n);ro.observe(n);}};watch();new MutationObserver(watch).observe(p,{childList:true,subtree:true});};
function sample(){requestAnimationFrame(()=>setTimeout(()=>{const g=geometry();if(g){if(g.rows&&!firstRowsAt)window.firstRowsAt=performance.now();layoutSamples.push({label:layoutLabel,t:performance.now(),...g});if(layoutSamples.length>10000)layoutSamples.shift();}sample();},0));}sample();
function Fixture(){const[live,setLive]=useState(()=>state()),[width,setWidth]=useState(940),[toolGroupsExpanded,setToolGroupsExpanded]=useState();const scroll=useRef(null),control=useRef(null);window.showToolGroups=value=>{control.current?.resetToolGroups();setToolGroupsExpanded(value)};window.narrow=()=>setWidth(580);window.wide=()=>setWidth(940);window.latest=()=>control.current?.latest();window.swap=()=>setLive(state('two'));window.trim=()=>setLive(s=>({...s,turns:s.turns.slice(20)}));window.reset=()=>setLive(state());window.grow=()=>setLive(s=>({...s,turns:s.turns.map((t,i)=>i!==s.turns.length-1?t:{...t,items:t.items.map((x,j)=>j!==t.items.length-1?x:{...x,text:x.text+'\\n\\n'+paragraph.repeat(3)})})}));
window.longToolGroup=()=>setLive(s=>({...s,turns:s.turns.map((t,i)=>i!==s.turns.length-1?t:{...t,status:'running',items:[{...t.items[0],text:'Progress before the tools.'},...Array.from({length:12},(_,j)=>({...t.items[1],key:t.turnId+'-large-'+j,toolCallId:'task:large-'+j,toolName:'bash',input:{command:'echo '+j},status:j===11?'running':'completed',output:j===11?undefined:t.items[1].output})),{...t.items.at(-1),text:'SELECTABLE alpha beta gamma delta epsilon. This text should stay still while reading.'}]})}));
window.growInline=()=>setLive(s=>({...s,turns:s.turns.map((t,i)=>i!==s.turns.length-1?t:{...t,items:t.items.map((x,j)=>j!==t.items.length-1?x:{...x,text:x.text+' More streamed words.'})})}));
window.missedStream=()=>setLive(s=>({...s,turns:s.turns.map((t,i)=>i!==s.turns.length-1?t:{...t,items:t.items.map((x,j)=>j!==t.items.length-1?x:{...x,recoveredTextLength:0,text:x.text+' Unseen streamed text.'.repeat(1800)+' MISSED_STREAM_TAIL'})})}));
window.codeFixture=()=>setLive(s=>({...s,turns:s.turns.map((t,i)=>i!==s.turns.length-1?t:{...t,status:'completed',items:[{...t.items[1],key:t.turnId+'-code',toolCallId:'task:code',toolName:'read',input:{path:'/workspace/example.txt'},output:{content:[{type:'text',text:Array.from({length:1100},(_,j)=>'CODE_LINE_'+String(j).padStart(4,'0')+' stable selectable source text.').join('\\n')}]}}]})}));
const sequence=useRef(100000);window.emit=(type,payload)=>{const event={schemaVersion:1,eventId:'40000000-0000-4000-8000-000000000001',sessionId:live.session.sessionId,turnId:live.turns.at(-1).turnId,agentId:'root',occurredAt:new Date().toISOString(),seq:++sequence.current,type,payload};setLive(s=>sessionViewReducer(s,{type:'stream.event',event}));control.current?.event(event);};
window.appendPagedTurn=()=>{const t=turn(80);historyResponses.push({turns:[{...t,state:t.status,transcript:{items:t.items,startedSequence:t.startedSequence,terminalSequence:t.terminalSequence,stopReason:t.stopReason,failure:null,cancellation:null}}],history:{before:'following-page',after:'following-tail',hasBefore:true,hasAfter:false}});setLive(s=>({...s,turns:[...s.turns,t]}));};
return React.createElement('div',{style:{display:'grid',height:700,width,maxWidth:'100vw',margin:'20px auto'}},React.createElement(ConversationTimeline,{api,live,toolGroupsExpanded,scrollerRef:scroll,controlRef:control,jump:null,onJumpSettled:()=>{},renderRow:row=>React.createElement(ConversationTurn,{turn:row.turn,fragment:row.fragment})}));}
createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(Fixture)));
`;
let server, failure;
const report = { at: new Date().toISOString(), accepted: false, scenarios: [] };
try {
  await build({
    root,
    configFile: false,
    logLevel: "error",
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "layout-fixture",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:layout") return "\0layout-fixture";
        },
        load(id) {
          if (id === "\0layout-fixture") return entry;
          if (
            baseline &&
            [root + "/src/ConversationTimeline.tsx", root + "/src/product.css"].includes(id)
          )
            return execFileSync(
              "git",
              ["show", baseline + ":packages/web-ui" + id.slice(root.length)],
              { encoding: "utf8" },
            );
        },
      },
    ],
    build: {
      outDir: join(scratch, "dist"),
      emptyOutDir: true,
      rollupOptions: {
        input: "virtual:layout",
        output: { entryFileNames: "fixture.js", assetFileNames: "[name][extname]" },
      },
    },
  });
  const sheets = (await readdir(join(scratch, "dist"))).filter((name) => name.endsWith(".css"));
  assert(sheets.length, "The actual product stylesheet must be bundled");
  await writeFile(
    join(scratch, "dist/index.html"),
    '<!doctype html><html><head><meta charset="utf-8">' +
      sheets.map((name) => '<link rel="stylesheet" href="/' + name + '">').join("") +
      '</head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
  );
  server = await preview({
    root: scratch,
    configFile: false,
    logLevel: "error",
    build: { outDir: "dist" },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await withChromePage({ width: 1280, height: 900 }, async (page) => {
    await page.navigate(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.waitFor("document.querySelector('[data-history-row-key]')");
    assert.equal(
      await page.evaluate(
        "getComputedStyle(document.querySelector('.product-chat-scroll')).overflowY",
      ),
      "auto",
    );
    // Observe after the virtualizer has installed its own RO. This sees the
    // intermediate layout after measurement delivery. Both collectors can see
    // React work not painted yet, so require prompt settlement without another
    // gesture and reject sustained mismatches across frames, not a single callback.
    await page.evaluate("watchLayout()");
    const check = async (name, action) => {
      await page.evaluate(
        `${name === "initial" ? "" : "layoutSamples=[];resizeSamples=[];"}layoutLabel=${JSON.stringify(name)}`,
      );
      await action();
      await page.wait(700);
      const sample = await page.evaluate(
        "({samples:layoutSamples,resizeSamples,last:geometry(),errors:layoutErrors,firstRowsAt})",
      );
      const maxGap = Math.max(0, ...sample.samples.map((s) => s.gap)),
        maxOverlap = Math.max(0, ...sample.samples.map((s) => s.overlap));
      const measuredGap = Math.max(sample.last.gap, ...sample.resizeSamples.map((s) => s.gap));
      const measuredOverlap = Math.max(
        sample.last.overlap,
        ...sample.resizeSamples.map((s) => s.overlap),
      );
      let since = null,
        longestMismatchMs = 0;
      for (const frame of sample.samples) {
        if (frame.gap > 4 || frame.overlap > 4) since ??= frame.t;
        else if (since !== null) {
          longestMismatchMs = Math.max(longestMismatchMs, frame.t - since);
          since = null;
        }
      }
      if (since !== null)
        longestMismatchMs = Math.max(longestMismatchMs, sample.samples.at(-1).t - since);
      report.scenarios.push({
        name,
        maxGap,
        maxOverlap,
        measuredGap,
        measuredOverlap,
        longestMismatchMs,
        ...sample,
      });
      console.log(
        JSON.stringify({
          name,
          maxGap,
          maxOverlap,
          measuredGap,
          measuredOverlap,
          last: sample.last,
        }),
      );
    };
    await check("initial", async () => {});
    await check("read-history", async () => {
      await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop-=1800");
    });
    const toolAnchor = await page.evaluate("geometry()");
    await check("expand-tool-groups", async () => {
      await page.evaluate("showToolGroups(true)");
    });
    const expandedAnchor = await page.evaluate("geometry()");
    assert.equal(expandedAnchor.key, toolAnchor.key, "Global expansion lost the reading row");
    assert(
      Math.abs(expandedAnchor.offset - toolAnchor.offset) < 4,
      "Global expansion moved the reader",
    );
    await check("collapse-tool-groups", async () => {
      await page.evaluate("showToolGroups(false)");
    });
    await page.evaluate("showToolGroups(undefined)");
    await page.wait(350);
    await check("narrow", async () => {
      await page.evaluate("narrow()");
    });
    await check("widen", async () => {
      await page.evaluate("wide()");
    });
    await check("expand-tool", async () => {
      await page.evaluate(
        `(()=>{const p=document.querySelector('.product-chat-scroll'),r=p.getBoundingClientRect();const b=[...p.querySelectorAll('.product-activity-group-toggle')].find(n=>{const box=n.getBoundingClientRect();return box.top>r.top&&box.bottom<r.bottom});if(!b)throw Error('No visible group to expand');b.click();})()`,
      );
    });
    await check("expand-details", async () => {
      await page.evaluate(
        "document.querySelector('.product-activity-group[data-expanded=true] details summary').click()",
      );
    });
    await check("collapse-details", async () => {
      await page.evaluate(
        "document.querySelector('.product-activity-group[data-expanded=true] details[open] summary').click()",
      );
    });
    await check("collapse-tool", async () => {
      await page.evaluate(
        "document.querySelector('.product-activity-group-toggle[aria-expanded=true]').click()",
      );
    });
    await page.evaluate("latest()");
    await page.wait(600);
    await check("trim-live-window", async () => {
      await page.evaluate("trim()");
    });
    await check("stream-grow", async () => {
      for (let i = 0; i < 8; i++) {
        await page.evaluate("grow()");
        await page.wait(30);
      }
    });
    await check("live-commentary", async () => {
      await page.evaluate(
        "emit('assistant.text.delta',{messageId:'live:layout',phase:'commentary',text:'I am checking the application and its tool results. '.repeat(6)})",
      );
    });
    await check("tool-preparing", async () => {
      await page.evaluate(
        "emit('assistant.tool_call.preparing',{toolCallId:'task:10001',toolName:'bash'})",
      );
    });
    await check("tool-started", async () => {
      await page.evaluate(
        "emit('tool.started',{toolCallId:'task:10001',toolName:'bash',input:{command:'npm test'}})",
      );
    });
    await check("tool-completed", async () => {
      await page.evaluate(
        "emit('tool.completed',{toolCallId:'task:10001',outcome:'completed',output:{content:[{type:'text',text:'Tests passed'}]}})",
      );
    });
    await check("continuous-output", async () => {
      for (let i = 0; i < 6; i++) {
        await page.evaluate(
          "emit('assistant.text.delta',{messageId:'live:final',phase:'final_answer',text:'The application is ready; all checks passed. '.repeat(3)})",
        );
        await page.wait(40);
      }
      await page.evaluate(
        "emit('assistant.text.delta',{messageId:'live:final',phase:'final_answer',text:' LIVE_LAYOUT_FINAL_MARKER'})",
      );
      await page.waitFor(
        "document.querySelector('.product-chat-scroll').textContent.includes('LIVE_LAYOUT_FINAL_MARKER')",
      );
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: -420,
    });
    await page.waitFor("document.querySelector('.product-return-to-latest')");
    await page.wait(250);
    const reading = await page.evaluate("geometry()");
    await check("live-output-while-reading", async () => {
      await page.evaluate(
        "emit('assistant.text.delta',{messageId:'live:later',phase:'commentary',text:'Later output must not pull the reader away. '.repeat(20)})",
      );
    });
    const held = await page.evaluate("geometry()");
    assert.equal(held.key, reading.key, "New output changed the reading anchor");
    assert(Math.abs(held.offset - reading.offset) < 4, "New output moved the reader");
    await check("manual-return-to-live", async () => {
      const before = await page.evaluate("historyRequests.length");
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 640,
        y: 400,
        deltaX: 0,
        deltaY: 1,
      });
      await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop=1e9");
      await page.waitFor("!document.querySelector('.product-return-to-latest')");
      assert.equal(
        await page.evaluate("historyRequests.length"),
        before + 1,
        "Confirm the canonical tail once",
      );
      await page.evaluate("grow()");
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: -420,
    });
    await page.waitFor("document.querySelector('.product-return-to-latest')");
    await page.wait(250);
    await page.evaluate("appendPagedTurn()");
    await check("load-newer-before-joining-live", async () => {
      const before = await page.evaluate("historyRequests.length");
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 640,
        y: 400,
        deltaX: 0,
        deltaY: 1,
      });
      await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop=1e9");
      await page.waitFor(`historyRequests.length>${before}`);
      await page.wait(500);
      assert(
        await page.evaluate("!!document.querySelector('.product-return-to-latest')"),
        "Do not skip unread canonical content",
      );
      assert(
        (await page.evaluate("geometry()")).end > 80,
        "Newer history should remain below the reading point",
      );
    });
    await check("manual-return-after-newer-page", async () => {
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 640,
        y: 400,
        deltaX: 0,
        deltaY: 1,
      });
      await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop=1e9");
      await page.waitFor("!document.querySelector('.product-return-to-latest')");
      await page.evaluate("grow()");
    });
    await check("switch-session", async () => {
      await page.evaluate("swap()");
    });
    // A small wheel gesture must win against end following, including just
    // after a manual disclosure. Large wheel deltas alone miss this failure.
    await page.evaluate("longToolGroup();showToolGroups(false);latest()");
    await page.wait(700);
    const groupBefore = await page.evaluate(
      `(()=>{const p=document.querySelector('.product-chat-scroll'),r=p.getBoundingClientRect();const button=[...p.querySelectorAll('.product-activity-group-toggle')].findLast(n=>{const b=n.getBoundingClientRect();return b.top>r.top&&b.bottom<r.bottom});if(!button)throw Error('No visible collapsed tool group');window.readerGroup=button;return button.getBoundingClientRect().top;})()`,
    );
    await page.evaluate("readerGroup.click()");
    await page.wait(450);
    const groupAfter = await page.evaluate("readerGroup.getBoundingClientRect().top");
    await page.evaluate(
      "emit('tool.completed',{toolCallId:'task:large-11',outcome:'completed',output:{content:[{type:'text',text:'TOOL_SETTLED_WHILE_READING'}]}})",
    );
    await page.wait(100);
    report.toolUpdatesAfterDisclosure = await page.evaluate(
      "document.querySelector('.product-chat-scroll').textContent.includes('TOOL_SETTLED_WHILE_READING')",
    );
    report.groupMovedAfterToolUpdate =
      (await page.evaluate("readerGroup.getBoundingClientRect().top")) - groupBefore;
    for (let i = 0; i < 5; i++) {
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 640,
        y: 400,
        deltaX: 0,
        deltaY: -24,
      });
      await page.evaluate("growInline()");
      await page.wait(45);
    }
    const reader = await page.evaluate(
      "({geometry:geometry(),reading:!!document.querySelector('.product-return-to-latest')})",
    );
    report.disclosureReading = { groupMovedPixels: groupAfter - groupBefore, ...reader };
    // Native mouse selection, not a programmatically supplied Range, also
    // needs to survive append and moving its origin outside normal overscan.
    await page.evaluate("showToolGroups(false);latest()");
    await page.wait(700);
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: -12,
    });
    await page.evaluate("growInline()");
    await page.wait(450);
    report.smallWheel = await page.evaluate(
      "({reading:!!document.querySelector('.product-return-to-latest'),end:geometry().end})",
    );
    await page.evaluate("latest()");
    await page.wait(500);
    const textBox = await page.evaluate(
      `(()=>{const p=[...document.querySelectorAll('.product-agent-answer p')].find(n=>n.textContent.startsWith('SELECTABLE'));if(!p)throw Error('No selection fixture');const n=document.createTreeWalker(p,NodeFilter.SHOW_TEXT).nextNode(),r=document.createRange();r.setStart(n,1);r.setEnd(n,2);const a=r.getBoundingClientRect();r.setStart(n,22);r.setEnd(n,23);const b=r.getBoundingClientRect();return {x:a.left+1,y:a.top+a.height/2,endX:b.left+1};})()`,
    );
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: textBox.x, y: textBox.y });
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      x: textBox.x,
      y: textBox.y,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: textBox.endX,
      y: textBox.y,
    });
    const selected = await page.evaluate(
      "window.selectionOriginNode=getSelection().anchorNode;getSelection().toString()",
    );
    report.selectionStart = {
      textBox,
      selected,
      debug: await page.evaluate(
        "({geometry:geometry(),atStart:document.elementFromPoint(" +
          textBox.x +
          "," +
          textBox.y +
          ")?.tagName})",
      ),
    };
    if (selected.length <= 5) await page.screenshot(join(directory, "selection-start.png"));
    assert(selected.length > 5, "Native drag must select real text");
    for (let i = 0; i < 5; i++) {
      await page.evaluate("growInline()");
      await page.wait(40);
    }
    const afterAppend = await page.evaluate("getSelection().toString()");
    const requestsBefore = await page.evaluate("historyRequests.length");
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      buttons: 1,
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: -2600,
    });
    await page.wait(500);
    const selection = await page.evaluate(
      "({originRetained:selectionOriginNode.isConnected,anchorRetained:getSelection().anchorNode===selectionOriginNode,rows:geometry().rows,requests:historyRequests.length})",
    );
    report.selection = { selected, afterAppend, ...selection };
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      x: 640,
      y: 400,
    });
    await page.evaluate("getSelection().removeAllRanges()");
    await page.wait(200);
    assert((await page.evaluate("geometry()")).rows < 70, "Selection pins must be released");
    await page.evaluate("missedStream()");
    await page.wait(100);
    await page.evaluate("latest()");
    await page.wait(400);
    report.resumeShowsBufferedText = await page.evaluate(
      "document.querySelector('.product-chat-scroll').textContent.includes('MISSED_STREAM_TAIL')",
    );
    await page.evaluate("codeFixture();latest()");
    await page.wait(600);
    await page.evaluate(
      "[...document.querySelectorAll('[data-tool-name=read] .product-tool-text button')].at(-1).click()",
    );
    await page.waitFor("document.querySelector('.product-large-code')");
    await page.evaluate(
      "document.querySelector('.product-large-code').scrollIntoView({block:'center'})",
    );
    await page.wait(200);
    const codeBox = await page.evaluate(
      `(()=>{const p=document.querySelector('.product-large-code'),n=p.querySelector('[data-virtual-selection-key="line:2"] code').firstChild,r=document.createRange();r.setStart(n,1);r.setEnd(n,2);const a=r.getBoundingClientRect();r.setStart(n,20);r.setEnd(n,21);const b=r.getBoundingClientRect();return {x:a.left+1,y:a.top+a.height/2,endX:b.left+1};})()`,
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      x: codeBox.x,
      y: codeBox.y,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: codeBox.endX,
      y: codeBox.y,
    });
    assert(
      (await page.evaluate("getSelection().toString()")).length > 5,
      "Select code with a real drag",
    );
    await page.evaluate("window.codeOrigin=getSelection().anchorNode");
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      buttons: 1,
      x: codeBox.endX,
      y: codeBox.y,
      deltaX: 0,
      deltaY: 1200,
    });
    await page.wait(400);
    report.codeSelection = await page.evaluate(
      "({originRetained:codeOrigin.isConnected,anchorRetained:getSelection().anchorNode===codeOrigin,scroll:document.querySelector('.product-large-code').scrollTop})",
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      x: codeBox.endX,
      y: codeBox.y,
    });
    await page.evaluate("getSelection().removeAllRanges()");
    await page.wait(200);
    report.codeSelection.releasedLines = await page.evaluate(
      "document.querySelector('.product-large-code').querySelectorAll('[data-virtual-selection-key]').length",
    );
    await page.evaluate("latest()");
    await page.wait(400);
    const insideCode = await page.evaluate(
      "(()=>{const r=document.querySelector('.product-large-code').getBoundingClientRect();return {x:r.left+100,y:r.top+100};})()",
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: insideCode.x,
      y: insideCode.y,
      deltaX: 0,
      deltaY: 100,
    });
    await page.wait(400);
    report.innerCodeReading = await page.evaluate(
      "!!document.querySelector('.product-return-to-latest')",
    );
    assert(
      report.innerCodeReading,
      "Scrolling an inner code view must not resume outer tail following",
    );
    await page.screenshot(join(directory, "layout.png"));
    assert(
      report.toolUpdatesAfterDisclosure,
      "The expanded Tool must still receive its final result",
    );
    assert(
      Math.abs(report.groupMovedAfterToolUpdate) < 4,
      "Live trimming must not move the opened group",
    );
    assert(
      report.smallWheel.reading,
      "A small upward wheel must remain reading even within the end threshold",
    );
    assert(
      report.resumeShowsBufferedText,
      "Returning to live must show buffered text without replaying its typing animation",
    );
    assert(
      report.codeSelection.originRetained &&
        report.codeSelection.anchorRetained &&
        report.codeSelection.scroll > 800,
      "Large code selection must retain its origin while scrolling",
    );
    assert(report.codeSelection.releasedLines < 60, "Large code selection pins must be released");
    assert(
      Math.abs(groupAfter - groupBefore) < 4,
      "Manual expansion must keep the clicked group in place",
    );
    assert(
      reader.reading && reader.geometry.end > 80,
      "Small upward wheel gestures must leave live following",
    );
    assert.equal(afterAppend, selected, "Streaming updates must preserve native text selection");
    assert(
      selection.originRetained && selection.anchorRetained,
      "Virtualization must retain the selection origin",
    );
    assert.equal(
      selection.requests,
      requestsBefore,
      "Selection must not load or evict historical pages",
    );
    for (const scenario of report.scenarios) {
      assert.deepEqual(scenario.errors, [], scenario.name + " browser errors");
      assert(
        scenario.last.gap <= 4,
        scenario.name + " retained a gap without another gesture: " + scenario.last.gap,
      );
      assert(
        scenario.last.overlap <= 4,
        scenario.name + " retained overlapping rows: " + scenario.last.overlap,
      );
      assert(
        scenario.longestMismatchMs < 80,
        scenario.name + " sustained a layout mismatch across frames: " + scenario.longestMismatchMs,
      );
      assert(scenario.last.rows < 70, "Mounted rows must remain bounded");
    }
    for (const name of [
      "tool-preparing",
      "tool-started",
      "tool-completed",
      "continuous-output",
      "manual-return-to-live",
      "manual-return-after-newer-page",
    ])
      assert(
        report.scenarios.find((s) => s.name === name).last.end <= 80,
        name + " lost following at the live edge",
      );
    report.accepted = true;
  });
} catch (e) {
  failure = e;
  report.failure = String(e);
} finally {
  if (server) await new Promise((r) => server.httpServer.close(r));
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}
if (failure) throw failure;
