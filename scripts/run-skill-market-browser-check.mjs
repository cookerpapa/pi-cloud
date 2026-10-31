import assert from "node:assert/strict";
import { createServer } from "vite";
import { resolve } from "node:path";
import { withChromePage } from "./lib/chrome-cdp.mjs";
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {SkillMarket} from '/src/SkillMarket.tsx';import {I18nProvider} from '/src/i18n.tsx';import '/src/product.css';
localStorage.setItem('pi-cloud:ui-language','zh-CN');
window.calls=[];window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
const version={versionId:'10000000-0000-4000-8000-000000000001',packageId:'20000000-0000-4000-8000-000000000001',name:'fixture-skill',label:'1',description:'可复用的工作流程',compatibility:'',digest:'a'.repeat(64),byteLength:100,requirements:{tools:[],runtime:'none',software:[]},source:{kind:'files'},availability:{state:'available',reasons:[]}};
let installations=[];const api={listSkills:async()=>({packages:[{packageId:version.packageId,ownerUserId:'owner',versions:[version],installations}],nextCursor:null}),
installSkill:async(id,change)=>{calls.push({action:'install',...change});installations=[{...change,revision:String(Number(change.revision??0)+1)}];return installations[0]},
uninstallSkill:async(id,change)=>{calls.push({action:'uninstall',...change});installations=[]},
importSkill:async(input)=>{calls.push({action:'publish',input});return version},exportSkill:async()=>({name:version.name,files:[],requirements:version.requirements})};
const root=createRoot(document.getElementById('root'));window.render=(owner=true)=>root.render(React.createElement(I18nProvider,null,React.createElement(SkillMarket,{api,owner,canMutate:true,userId:'owner',projectId:'30000000-0000-4000-8000-000000000001',onClose:()=>{}})));render();
`;
const server = await createServer({
  root: resolve("packages/web-ui"),
  configFile: false,
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "skill-fixture",
      resolveId(id) {
        if (id === "/skill-entry.js") return "\0skill-fixture";
      },
      load(id) {
        if (id === "\0skill-fixture") return entry;
      },
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === "/skill-fixture") {
            res.setHeader("content-type", "text/html");
            res.end('<div id="root"></div><script type="module" src="/skill-entry.js"></script>');
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
  await withChromePage({}, async (page) => {
    await page.navigate(`http://127.0.0.1:${server.httpServer.address().port}/skill-fixture`);
    const click = (text) =>
      page.evaluate(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`,
      );
    await page.waitFor("document.querySelector('[data-skill]')");
    await click("安装");
    await page.waitFor("document.body.innerText.includes('已启用')");
    await click("停用");
    await page.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent==='启用')");
    await click("启用");
    await page.waitFor("document.body.innerText.includes('已启用')");
    await click("卸载");
    await page.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent==='安装')");
    assert.deepEqual(
      (await page.evaluate("calls")).map((c) => [c.action, c.enabled, c.revision]),
      [
        ["install", true, null],
        ["install", false, "1"],
        ["install", true, "2"],
        ["uninstall", true, "3"],
      ],
    );
    await click("发布 Skill");
    await page.waitFor("document.querySelector('[aria-label=\"SKILL.md\"]')");
    await click("发布版本");
    await page.waitFor("!document.querySelector('.skill-publisher')");
    assert.equal(await page.evaluate("calls.at(-1).input.source.files[0].path"), "SKILL.md");
    await page.screenshot("/tmp/pi-cloud-skill-market.png");
    assert.deepEqual(await page.evaluate("errors"), []);
    assert.equal(await page.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
  });
  console.log(
    JSON.stringify({
      skillMarketBrowser: true,
      installation: true,
      disableEnable: true,
      uninstall: true,
      publishInstructions: true,
    }),
  );
} finally {
  await server.close();
}
