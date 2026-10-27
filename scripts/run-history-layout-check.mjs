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
function Fixture(){const[live,setLive]=useState(()=>state()),[width,setWidth]=useState(940),[toolsExpanded,setToolsExpanded]=useState();const scroll=useRef(null),control=useRef(null);window.showTools=value=>{control.current?.resetToolDisclosures();setToolsExpanded(value)};window.narrow=()=>setWidth(580);window.wide=()=>setWidth(940);window.latest=()=>control.current?.latest();window.swap=()=>setLive(state('two'));window.trim=()=>setLive(s=>({...s,turns:s.turns.slice(20)}));window.reset=()=>setLive(state());window.grow=()=>setLive(s=>({...s,turns:s.turns.map((t,i)=>i!==s.turns.length-1?t:{...t,items:t.items.map((x,j)=>j!==t.items.length-1?x:{...x,text:x.text+'\\n\\n'+paragraph.repeat(3)})})}));
const sequence=useRef(100000);window.emit=(type,payload)=>{const event={schemaVersion:1,eventId:'40000000-0000-4000-8000-000000000001',sessionId:live.session.sessionId,turnId:live.turns.at(-1).turnId,agentId:'root',occurredAt:new Date().toISOString(),seq:++sequence.current,type,payload};setLive(s=>sessionViewReducer(s,{type:'stream.event',event}));control.current?.event(event);};
window.appendPagedTurn=()=>{const t=turn(80);historyResponses.push({turns:[{...t,state:t.status,transcript:{items:t.items,startedSequence:t.startedSequence,terminalSequence:t.terminalSequence,stopReason:t.stopReason,failure:null,cancellation:null}}],history:{before:'following-page',after:'following-tail',hasBefore:true,hasAfter:false}});setLive(s=>({...s,turns:[...s.turns,t]}));};
return React.createElement('div',{style:{display:'grid',height:700,width,maxWidth:'100vw',margin:'20px auto'}},React.createElement(ConversationTimeline,{api,live,toolsExpanded,scrollerRef:scroll,controlRef:control,jump:null,onJumpSettled:()=>{},renderRow:row=>React.createElement(ConversationTurn,{turn:row.turn,fragment:row.fragment})}));}
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
    await check("expand-all-tools", async () => {
      await page.evaluate("showTools(true)");
    });
    const expandedAnchor = await page.evaluate("geometry()");
    assert.equal(expandedAnchor.key, toolAnchor.key, "Global expansion lost the reading row");
    assert(
      Math.abs(expandedAnchor.offset - toolAnchor.offset) < 4,
      "Global expansion moved the reader",
    );
    await check("collapse-all-tools", async () => {
      await page.evaluate("showTools(false)");
    });
    await page.evaluate("showTools(undefined)");
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
      await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop=1e9");
      await page.waitFor("!document.querySelector('.product-return-to-latest')");
      await page.evaluate("grow()");
    });
    await check("switch-session", async () => {
      await page.evaluate("swap()");
    });
    await page.screenshot(join(directory, "layout.png"));
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
