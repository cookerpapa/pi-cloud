import assert from "node:assert/strict";
import { createServer } from "vite";
import { resolve } from "node:path";
import { withChromePage } from "./lib/chrome-cdp.mjs";
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {SessionSchedules} from '/src/SessionSchedules.tsx';import {I18nProvider} from '/src/i18n.tsx';import '/src/product.css';
localStorage.setItem('pi-cloud:ui-language','zh-CN');
const plan={id:'10000000-0000-4000-8000-000000000001',sessionId:'20000000-0000-4000-8000-000000000001',name:'每日进展',prompt:'总结项目进展',timing:{kind:'cron',expression:'0 8 * * *',timezone:'Asia/Shanghai'},missed:'latest',revision:'1',state:'scheduled',nextFireAt:'2026-10-27T00:00:00.000Z',lastRun:{runId:'30000000-0000-4000-8000-000000000001',turnId:'40000000-0000-4000-8000-000000000001',state:'queued',scheduledAt:'2026-10-26T00:00:00.000Z',admittedAt:'2026-10-26T00:00:01.000Z'},lastSkippedAt:null,error:null,createdAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:00.000Z'};
let present=true;window.calls=[];window.errors=[];addEventListener('error',e=>window.errors.push(e.message));addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
const api={listSchedules:async()=>{await new Promise(r=>setTimeout(r,50));const {prompt,...summary}=plan;return {schedules:present?[structuredClone(summary)]:[],nextCursor:null}},getSchedule:async()=>structuredClone(plan),changeSchedule:async(s,id,change)=>{window.calls.push(change);if(change.revision!==plan.revision)throw Error('stale revision');if(change.action==='update')Object.assign(plan,change.patch);else plan.state=change.action==='pause'?'paused':'scheduled';plan.revision=String(Number(plan.revision)+1);return structuredClone(plan)},deleteSchedule:async(s,id,revision)=>{window.calls.push({action:'delete',revision});present=false;return {id,deleted:true,lastRunId:plan.lastRun.runId,activeRun:plan.lastRun}},cancelTurn:async(s,id)=>{window.calls.push({action:'stop',turnId:id});}};
const root=createRoot(document.getElementById('root'));window.render=(canMutate=true)=>root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(SessionSchedules,{api,sessionId:plan.sessionId,canMutate,onClose:()=>{}}))));window.render();
`;
const server = await createServer({
  root: resolve("packages/web-ui"),
  configFile: false,
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "schedule-fixture",
      resolveId(id) {
        if (id === "/schedule-entry.js") return "\0schedule-fixture";
      },
      load(id) {
        if (id === "\0schedule-fixture") return entry;
      },
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === "/schedule-fixture") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<div id="root"></div><script type="module" src="/schedule-entry.js"></script>',
            );
            return;
          }
          next();
        });
      },
    },
  ],
});
try {
  await server.listen();
  const port = server.httpServer.address().port;
  await withChromePage({}, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/schedule-fixture`);
    const click = (text) =>
      page.evaluate(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`,
      );
    await page.waitFor("document.querySelector('[data-schedule-id]')");
    await click("编辑");
    await page.waitFor("document.querySelector('.product-schedule-editor input')");
    await page.evaluate(
      `(()=>{const input=document.querySelector('.product-schedule-editor input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'新的进展名称');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click("保存");
    await page.waitFor(
      "!document.querySelector('.product-schedule-editor')&&document.body.innerText.includes('新的进展名称')",
    );
    assert.deepEqual(await page.evaluate("calls[0]"), {
      action: "update",
      revision: "1",
      patch: { name: "新的进展名称" },
    });
    await click("暂停");
    await page.waitFor("document.body.innerText.includes('已暂停')");
    await click("恢复");
    await page.waitFor("document.body.innerText.includes('待触发')");
    await page.screenshot("/tmp/pi-cloud-schedules-ui.png");
    await click("删除");
    await page.waitFor(
      "!document.querySelector('[data-schedule-id]')&&document.body.innerText.includes('已触发')",
    );
    await click("停止本次");
    await page.waitFor("calls.some(x=>x.action==='stop')");
    assert.equal(
      (await page.evaluate("calls.find(x=>x.action==='stop')")).turnId,
      "40000000-0000-4000-8000-000000000001",
    );
    assert.deepEqual(await page.evaluate("errors"), []);
    console.log(
      JSON.stringify({
        scheduleBrowser: true,
        editWithoutTimingChange: true,
        pauseResume: true,
        directDelete: true,
        stopAdmittedRun: true,
      }),
    );
  });
} finally {
  await server.close();
}
