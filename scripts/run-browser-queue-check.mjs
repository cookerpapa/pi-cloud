import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { withChromePage } from "./lib/chrome-cdp.mjs";

const cacheDir = await mkdtemp(join(tmpdir(), "pi-cloud-queue-vite-"));
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import {PendingInputQueue} from "/src/PendingInputQueue.tsx";
import {PiCloudApiError} from "/src/api.ts";
import {I18nProvider} from "/src/i18n.tsx";
import "/src/product.css";
const root = createRoot(document.getElementById("root"));
const id = n => "10000000-0000-4000-8000-"+String(n).padStart(12,"0");
window.queueId=id;
window.actions=[];window.snapshots=[];window.restored=[];
let generation=0, receipts=new Map();
const reset = (count=3) => ({sessionId:id(90),revision:1,viewVersion:"1",afterPosition:0,hasMore:false,hasPausedInputs:false,activeTurnId:id(99),items:Array.from({length:count},(_,i)=>({text:["A","B","C"][i]??"Input "+(i+1),i})).map(({text,i})=>({turnId:id(i+1),runId:id(i+11),text,mailboxPosition:i+1,acceptedAt:"2026-09-26T00:00:00.000Z",status:"queued",paused:false}))});
window.queue=reset();window.queueReads=0;
const pageOf = (page) => {
  if(page && window.conflictPage){window.conflictPage=false;window.queue.revision++;window.queue.viewVersion=String(window.queue.revision);}
  if(page && page.viewVersion!==window.queue.viewVersion)throw new PiCloudApiError(409,"conflict","page changed");
  const afterPosition=page?.afterPosition??0, items=window.queue.items.filter(i=>i.mailboxPosition>afterPosition);
  return {...structuredClone(window.queue),hasPausedInputs:window.queue.items.some(i=>i.paused),afterPosition,hasMore:items.length>20,items:structuredClone(items.slice(0,20))};
};
const api = {
  async getInputQueue(_session,_signal,page) {
    window.queueReads++;
    const snapshot=pageOf(page);
    if(window.failRead){window.failRead=false;throw new TypeError("read failed");}
    if(window.delayRead){window.delayRead=false;return new Promise(resolve=>{window.releaseRead=()=>resolve(snapshot);});}
    return snapshot;
  },
  async mutateQueuedInput(sessionId,turnId,action,key){
    window.actions.push({sessionId,turnId,action:structuredClone(action),key});
    if(receipts.has(key))return {...structuredClone(receipts.get(key)),replayed:true};
    if(window.conflict){window.conflict=false;window.queue.revision++;window.queue.viewVersion=String(window.queue.revision);throw new PiCloudApiError(409,"conflict","changed");}
    if(action.revision!==window.queue.revision)throw new PiCloudApiError(409,"conflict","stale");
    const items=window.queue.items,index=items.findIndex(i=>i.turnId===turnId),item=items[index];
    if(!item)throw new PiCloudApiError(409,"conflict","started");
    if(action.action==="edit")item.text=action.text;
    if(action.action==="cancel")items.splice(index,1);
    if(action.action==="send"){item.paused=false;items.push(...items.splice(index,1));}
    if(action.action==="move"){const other=index+(action.direction==="up"?-1:1);[items[index],items[other]]=[items[other],items[index]];}
    if(action.action==="steer"){if(action.text!==undefined)item.text=action.text;item.status="steering";}
    window.queue.revision++;window.queue.viewVersion=String(window.queue.revision);
    window.queue.items.forEach((item,i)=>item.mailboxPosition=i+1);
    const result={queue:pageOf(),replayed:false};receipts.set(key,result);
    if(window.loseReply){window.loseReply=false;throw new TypeError("reply lost");}
    return result;
  },
  async resumeInputQueue(sessionId,action,key){
    window.actions.push({sessionId,action:{...action,action:"resume"},key});
    if(receipts.has(key))return {...structuredClone(receipts.get(key)),replayed:true};
    if(action.revision!==window.queue.revision)throw new PiCloudApiError(409,"conflict","stale");
    window.queue.items.forEach(item=>item.paused=false);
    window.queue.revision++;window.queue.viewVersion=String(window.queue.revision);
    const result={queue:pageOf(),replayed:false};receipts.set(key,result);
    if(window.loseReply){window.loseReply=false;throw new TypeError("reply lost");}
    return result;
  }
};
window.renderQueue=(canMutate=true,count=3)=>{
  window.queue=reset(count);window.queueReads=0;receipts=new Map();window.actions=[];window.restored=[];window.snapshots=[];
  root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,{initialLanguage:"zh-CN"},
    React.createElement(PendingInputQueue,{key:++generation,api,sessionId:window.queue.sessionId,canMutate,refreshSignal:String(generation),streamQueue:null,
      onSnapshot:q=>window.snapshots.push(q),onRestoreDraft:text=>window.restored.push(text)}))));
};
window.refreshQueue=()=>window.dispatchEvent(new Event("focus"));
window.renderQueue();window.fixtureReady=true;
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
      name: "queue-fixture",
      resolveId(id) {
        if (id === "/queue-fixture.js") return "\0queue-fixture";
      },
      load(id) {
        if (id === "\0queue-fixture") return fixture;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/queue.html") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:20px;background:#212121}#root{max-width:780px;margin:auto}</style><div id="root"></div><script type="module" src="/queue-fixture.js"></script>',
          );
        });
      },
    },
  ],
});
try {
  await server.listen();
  const port = server.httpServer.address().port;
  await withChromePage({ width: 1000, height: 800 }, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/queue.html`);
    await page.waitFor(
      "window.fixtureReady && document.querySelectorAll('.pending-input-row').length===3",
    );
    const initialReads = await page.evaluate("window.queueReads");
    await page.wait(4500);
    assert.equal(
      await page.evaluate("window.queueReads"),
      initialReads,
      "Idle queue must not poll",
    );
    const click = async (selector, text) =>
      page.evaluate(
        `(()=>{const root=document.querySelector(${JSON.stringify(selector)});const b=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('Button unavailable');b.click();})()`,
      );
    const row = (n) =>
      `.pending-input-row[data-turn-id="10000000-0000-4000-8000-${String(n).padStart(12, "0")}"]`;
    const draft = async (text) => {
      await page.evaluate(
        "document.querySelector('.pending-input-editor textarea').focus();document.querySelector('.pending-input-editor textarea').select()",
      );
      await page.send("Input.insertText", { text });
    };
    await click(row(2), "编辑");
    await page.waitFor("document.querySelector('.pending-input-editor textarea')");
    await draft("B revised");
    await click(".pending-input-editor", "保存");
    await page.waitFor(
      "!document.querySelector('.pending-input-editor') && window.queue.items[1].text==='B revised'",
    );
    await click(row(3), "↑");
    await page.waitFor("window.queue.items[1].text==='C'");
    await click(row(1), "↓");
    await page.waitFor("window.queue.items[0].text==='C'");
    await click(row(3), "取消发送");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===2");
    assert.deepEqual(await page.evaluate("window.queue.items.map(i=>i.text)"), ["A", "B revised"]);

    await click(row(2), "编辑");
    await draft("B steer edited");
    await page.evaluate("window.loseReply=true");
    await click(".pending-input-editor", "立即引导");
    await page.waitFor(
      "!document.querySelector('.pending-input-editor') && window.queue.items[1].status==='steering'",
    );
    const promoted = await page.evaluate("window.actions.filter(a=>a.action.action==='steer')");
    assert.equal(promoted.length, 2);
    assert.equal(promoted[0].key, promoted[1].key);
    assert.equal(promoted[0].action.text, "B steer edited");
    assert.equal(
      await page.evaluate(
        `Array.from(document.querySelector(${JSON.stringify(row(2))}).querySelectorAll('button')).every(b=>b.disabled)`,
      ),
      true,
    );
    await page.evaluate(
      "window.queue.items.splice(1,1);window.queue.revision++;window.queue.viewVersion=String(window.queue.revision);window.refreshQueue()",
    );
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===1");

    await click(row(1), "编辑");
    await draft("retained draft");
    await page.evaluate("window.conflict=true");
    await click(".pending-input-editor", "保存");
    await page.waitFor("document.querySelector('.pending-input-error')");
    assert.equal(
      await page.evaluate("document.querySelector('.pending-input-editor textarea').value"),
      "retained draft",
    );
    await page.evaluate(
      "window.queue.items=[];window.queue.revision++;window.queue.viewVersion=String(window.queue.revision);window.refreshQueue()",
    );
    await page.waitFor("document.querySelector('.pending-input-editor [role=status]')");
    await click(".pending-input-editor", "放回输入框");
    assert.deepEqual(await page.evaluate("window.restored"), ["retained draft"]);

    await page.evaluate("window.renderQueue()");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===3");
    await page.evaluate("window.delayRead=true;window.refreshQueue()");
    await page.waitFor("typeof window.releaseRead==='function'");
    await click(row(3), "↑");
    await page.waitFor("window.queue.items[1].text==='C'");
    await page.evaluate("window.releaseRead()");
    await page.wait(100);
    assert.deepEqual(
      await page.evaluate(
        "Array.from(document.querySelectorAll('.pending-input-content p')).map(p=>p.textContent)",
      ),
      ["A", "C", "B"],
    );
    await page.evaluate("window.failRead=true;window.refreshQueue()");
    await page.waitFor("document.querySelector('.pending-input-error')");
    await page.evaluate("window.refreshQueue()");
    await page.waitFor("!document.querySelector('.pending-input-error')");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await click(row(1), "编辑");
    await page.waitFor("document.querySelector('.pending-input-editor')");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await page.screenshot("/tmp/pi-cloud-queue-browser.png");
    await page.evaluate("window.renderQueue(false)");
    await page.waitFor(
      "document.querySelectorAll('.pending-input-row').length===3 && !document.querySelector('.pending-input-editor')",
    );
    assert.equal(
      await page.evaluate(
        "Array.from(document.querySelectorAll('.pending-input-row button')).every(b=>b.disabled)",
      ),
      true,
    );
    await page.evaluate("window.renderQueue()");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===3");
    await click(row(2), "编辑");
    await draft("draft before Stop");
    await page.evaluate(
      "window.queue.items.forEach(i=>i.paused=true);window.queue.activeTurnId=null;window.queue.revision++;window.queue.viewVersion=String(window.queue.revision);window.refreshQueue()",
    );
    await page.waitFor(
      "document.querySelector('.pending-input-queue header').textContent.includes('继续队列')",
    );
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await page.screenshot("/tmp/pi-cloud-paused-queue-browser.png");
    assert.equal(
      await page.evaluate("document.querySelector('.pending-input-editor textarea').value"),
      "draft before Stop",
    );
    await click(".pending-input-editor", "保存");
    await page.waitFor(
      "!document.querySelector('.pending-input-editor') && window.queue.items[1].text==='draft before Stop'",
    );
    await click(row(3), "↑");
    await page.waitFor("window.queue.items[1].text==='C'");
    await click(row(1), "发送");
    await page.waitFor(
      "window.queue.items.at(-1).paused===false && document.querySelectorAll('.pending-input-status').length===2",
    );
    await page.evaluate("window.refreshQueue()");
    await page.wait(100);
    assert.equal(
      await page.evaluate("document.querySelectorAll('.pending-input-status').length"),
      2,
    );
    await page.evaluate("window.loseReply=true");
    await click(".pending-input-queue header", "继续队列");
    await page.waitFor("document.querySelectorAll('.pending-input-status').length===0");
    const resumed = await page.evaluate("window.actions.filter(a=>a.action.action==='resume')");
    assert.equal(resumed.length, 2);
    assert.equal(resumed[0].key, resumed[1].key);
    await page.evaluate("window.renderQueue(true,45)");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===20");
    await click(".pending-input-queue", "显示更多");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===40");
    await page.evaluate("window.refreshQueue()");
    await page.wait(100);
    assert.equal(await page.evaluate("document.querySelectorAll('.pending-input-row').length"), 40);
    await click(row(25), "编辑");
    await draft("draft on a later page");
    await page.evaluate("window.conflictPage=true");
    await click(".pending-input-queue", "显示更多");
    await page.waitFor(
      "document.querySelectorAll('.pending-input-row').length===20 && document.querySelector('.pending-input-error')",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.pending-input-editor textarea').value"),
      "draft on a later page",
    );
    await click(".pending-input-queue", "显示更多");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===40");
    await click(".pending-input-editor", "保存");
    await page.waitFor(
      "!document.querySelector('.pending-input-editor') && window.queue.items[24].text==='draft on a later page'",
    );
    await click(".pending-input-queue", "显示更多");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===40");
    await click(".pending-input-queue", "显示更多");
    await page.waitFor("document.querySelectorAll('.pending-input-row').length===45");
    assert.equal(
      await page.evaluate(
        "Array.from(document.querySelectorAll('.pending-input-queue>button')).some(b=>b.textContent==='显示更多')",
      ),
      false,
    );
  });
  console.log(
    "browser_queue_check_passed no_poll edit order cancel edited_steer lost_reply draft_retention stale_read read_recovery viewer mobile pagination page_conflict late_page_edit paused_draft send_one resume_retry",
  );
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
