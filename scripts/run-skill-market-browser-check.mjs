import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { withChromePage } from "./lib/chrome-cdp.mjs";
const cacheDir = await mkdtemp(join(tmpdir(), "pi-cloud-skill-browser-"));
const entry = String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';
import {SkillMarket} from '/src/SkillMarket.tsx';import {I18nProvider} from '/src/i18n.tsx';import {PiCloudApiError} from '@pi-cloud/session-client';import '/src/product.css';
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),encode=value=>btoa(unescape(encodeURIComponent(value)));
const make=(n,name,description)=>({versionId:id(n),packageId:id(n+100),name,label:'2.0',description,compatibility:'',digest:'a'.repeat(64),byteLength:100,requirements:{tools:[],runtime:'none',software:[]},source:{kind:'files'},availability:{state:'available',reasons:[]}});
const design=make(1,'frontend-design','设计有辨识度的页面和交互'),review=make(2,'code-review','检查代码变更与回归风险'),report=make(3,'weekly-report','整理进展并生成周报');
let packages=[],generation=0,revisionSequence=1;
const files=id=>({name:'fixture',requirements:design.requirements,files:[{path:'SKILL.md',base64:encode('---\nname: fixture\n---\n# Preview '+id+'\n\nFollow the project conventions.')},{path:'scripts/check.mjs',base64:encode('console.log("keep this file")')},{path:'assets/icon.bin',base64:btoa(String.fromCharCode(0,255,128))}]});
const same=(a,b)=>a.kind===b.kind&&(a.kind!=='project'||a.projectId===b.projectId);
window.calls=[];window.reads=[];window.fileReads=[];window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
const api={
 async listSkills(project,cursor,signal){window.reads.push(cursor??'first');if(window.failList){window.failList--;throw new PiCloudApiError(503,'unavailable','list unavailable');}const index=cursor?Number(cursor):0,value={packages:structuredClone(packages.slice(index,index+2)),nextCursor:index+2<packages.length?String(index+2):null};if(window.holdList){window.holdList=false;await new Promise(resolve=>window.releaseList=resolve);}return value;},
 async installSkill(packageId,change){const pack=packages.find(p=>p.packageId===packageId),old=pack.installations.find(i=>same(i.scope,change.scope));window.calls.push({action:'install',packageId,...change});if(window.conflict){window.conflict=false;old.revision=String(++revisionSequence);window.conflictRevision=old.revision;throw new PiCloudApiError(409,'conflict','changed');}if(change.revision!==(old?.revision??null))throw new PiCloudApiError(409,'conflict','changed');const next={...change,revision:String(++revisionSequence)};pack.installations=[...pack.installations.filter(i=>!same(i.scope,change.scope)),next];if(window.loseReply){window.loseReply=false;throw Error('reply lost');}return structuredClone(next);},
 async uninstallSkill(packageId,change){window.calls.push({action:'uninstall',packageId,...change});const pack=packages.find(p=>p.packageId===packageId);pack.installations=pack.installations.filter(i=>!same(i.scope,change.scope));},
 async exportSkill(versionId){window.fileReads.push(versionId);if(window.failFiles){window.failFiles--;throw new PiCloudApiError(503,'unavailable','preview unavailable');}if(window.holdVersion===versionId)await new Promise(resolve=>window.releaseVersion=resolve);return files(versionId);},
 async importSkill(input){window.calls.push({action:'publish',input});if(window.failPublish){window.failPublish=false;throw Error('save unavailable');}return {...design,versionId:id(50)};}
};
const root=createRoot(document.getElementById('root'));
window.render=(owner=true,canMutate=true)=>{revisionSequence=1;packages=[{packageId:design.packageId,ownerUserId:'owner',versions:[design,{...design,versionId:id(9),label:'1.0',description:'旧版页面设计'}],installations:[]},{packageId:review.packageId,ownerUserId:'colleague',versions:[review],installations:[{scope:{kind:'tenant'},versionId:review.versionId,revision:'1',enabled:true}]},{packageId:report.packageId,ownerUserId:'colleague',versions:[report],installations:[]}];window.calls=[];window.reads=[];window.fileReads=[];window.packages=packages;root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,{initialLanguage:'zh-CN'},React.createElement(SkillMarket,{key:++generation,api,owner,canMutate,userId:'owner',projectId:id(300),onClose:()=>{},onCreate:()=>{window.createRequests=(window.createRequests??0)+1}}))));};window.fixtureId=id;render();
`;
const server = await createServer({
  root: resolve("packages/web-ui"),
  cacheDir,
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
            res.end(
              '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/skill-entry.js"></script>',
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
  await withChromePage({ width: 1280, height: 900 }, async (page) => {
    await page.navigate(`http://127.0.0.1:${server.httpServer.address().port}/skill-fixture`);
    const click = async (text, scope = "document") =>
      page.evaluate(
        `[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`,
      );
    const select = async (label, value) =>
      page.evaluate(
        `(()=>{const e=document.querySelector('dialog select[aria-label="'+${JSON.stringify(label)}+'"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    const fill = async (selector, text) => {
      await page.evaluate(
        `document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`,
      );
      await page.send("Input.insertText", { text });
    };
    const ready = () =>
      page.waitFor(
        "document.querySelectorAll('[data-skill]').length===2 && !document.querySelector('.skill-loading')",
      );
    const close = () => page.evaluate("document.querySelector('dialog .skill-close').click()");
    await ready();
    assert.equal(await page.evaluate("fileReads.length"), 0);
    assert.equal(
      await page.evaluate(
        "document.body.innerText.includes('skill')||document.body.innerText.includes('aaaaaaaa')||document.body.innerText.includes('无环境依赖')",
      ),
      false,
    );
    await page.screenshot("/tmp/pi-cloud-skill-market.png");
    await fill("input[type=search]", "weekly");
    await page.waitFor(
      "document.querySelector('[data-skill=weekly-report]') && !document.querySelector('.skill-loading')",
    );
    assert.equal(await page.evaluate('reads.includes("2")'), true);
    await fill("input[type=search]", "missing");
    await page.waitFor("document.body.innerText.includes('没有找到匹配的 Skill')");
    await fill("input[type=search]", "");
    await ready();
    await click("安装", "document.querySelector('[data-skill=frontend-design]')");
    await page.waitFor(
      "document.querySelector('[data-skill=frontend-design]').textContent.includes('已安装')",
    );
    await click("已安装", "document.querySelector('.skill-market-toolbar')");
    await ready();
    await page.evaluate(
      "document.querySelector('[data-skill=frontend-design] .skill-card-content').focus();document.querySelector('[data-skill=frontend-design] .skill-card-content').click()",
    );
    await page.waitFor("document.querySelector('.skill-preview')");
    await click("停用");
    await page.waitFor(
      "[...document.querySelectorAll('dialog button')].some(b=>b.textContent==='启用')",
    );
    await click("启用");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='已启用'");
    await select("使用范围", "tenant");
    await click("安装", "document.querySelector('dialog')");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='已启用'");
    await select("使用范围", "personal");
    await page.evaluate("document.querySelector('.skill-more').open=true");
    await click("卸载");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='安装'");
    assert.deepEqual(await page.evaluate("packages[0].installations.map(i=>i.scope.kind)"), [
      "tenant",
    ]);
    await select("使用范围", "tenant");
    await page.evaluate("window.conflict=true");
    await click("停用");
    await page.waitFor(
      "document.querySelector('dialog [role=alert]')?.textContent.includes('内容已更新') && !document.querySelector('.skill-loading')",
    );
    await click("停用");
    await page.waitFor("document.querySelector('dialog .skill-primary').textContent==='启用'");
    assert.equal(
      await page.evaluate("calls.at(-1).revision"),
      await page.evaluate("conflictRevision"),
    );
    await page.evaluate("window.holdVersion=fixtureId(9)");
    await select("版本", await page.evaluate("fixtureId(9)"));
    await page.waitFor("window.releaseVersion");
    await select("版本", await page.evaluate("fixtureId(1)"));
    await page.waitFor(
      "document.querySelector('.skill-preview')?.textContent.includes(fixtureId(1))",
    );
    await page.evaluate("releaseVersion()");
    await page.wait(50);
    assert.equal(
      await page.evaluate(
        "document.querySelector('.skill-preview').textContent.includes(fixtureId(9))",
      ),
      false,
    );
    await click("文件");
    await select("文件", "scripts/check.mjs");
    await page.waitFor(
      "document.querySelector('.skill-preview')?.textContent.includes('keep this file')",
    );
    await select("文件", "assets/icon.bin");
    await page.waitFor("document.body.innerText.includes('此文件不提供文本预览')");
    await click("说明");
    await page.screenshot("/tmp/pi-cloud-skill-details.png");
    await page.evaluate("document.querySelector('.skill-more').open=true");
    await click("导入新版本");
    await page.waitFor("document.querySelector('.skill-publisher')");
    await page.evaluate("window.failPublish=true");
    await click("分享到组织");
    await page.waitFor("document.querySelector('.skill-publisher [role=alert]')");
    assert.equal(
      await page.evaluate(
        "document.querySelector('.skill-publisher .skill-preview').textContent.includes('Follow the project')",
      ),
      true,
    );
    await click("分享到组织");
    await page.waitFor("!document.querySelector('dialog')");
    assert.equal(await page.evaluate("calls.at(-1).input.source.kind"), "files");
    assert.deepEqual(await page.evaluate("calls.at(-1).input.source.files.map(f=>f.path)"), [
      "SKILL.md",
      "scripts/check.mjs",
      "assets/icon.bin",
    ]);
    await click("＋ 创建 Skill");
    assert.equal(await page.evaluate("createRequests"), 1);
    assert.equal(await page.evaluate("document.querySelector('dialog')===null"), true);
    assert.equal(
      await page.evaluate(
        "[...document.querySelectorAll('.skill-market-header button')].some(button => button.textContent.trim() === '导入')",
      ),
      false,
    );
    await page.evaluate(
      "document.querySelector('[data-skill=frontend-design] .skill-card-content').click()",
    );
    await page.waitFor("document.querySelector('.skill-preview')");
    await page.evaluate("document.querySelector('.skill-more').open=true");
    await click("导入新版本");
    await page.waitFor("document.querySelector('.skill-publisher')");
    assert.equal(
      await page.evaluate("document.querySelector('dialog').innerText.includes('GitHub')"),
      false,
    );
    await page.evaluate(
      String.raw`(()=>{const data=new DataTransfer();data.items.add(new File([JSON.stringify({label:'3.0',requirements:{runtime:'none',tools:[],software:[]},source:{kind:'files',files:[{path:'SKILL.md',base64:btoa('---\nname: frontend-design\ndescription: Imported\n---\n# Imported workflow')},{path:'assets/a.txt',base64:btoa('asset')}]}})],'test.skill.json',{type:'application/json'}));const e=document.querySelector('dialog input[accept=".json"]');e.files=data.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await page.waitFor(
      "document.querySelector('.skill-publisher .skill-preview')?.textContent.includes('Imported workflow')",
    );
    await click("分享到组织");
    await page.waitFor("!document.querySelector('dialog')");
    assert.equal(await page.evaluate("calls.at(-1).input.source.files.length"), 2);
    await page.evaluate("render(false,true)");
    await ready();
    await page.evaluate(
      "document.querySelector('[data-skill=code-review] .skill-card-content').click()",
    );
    await page.waitFor("document.querySelector('.skill-preview')");
    assert.equal(
      await page.evaluate("document.querySelector('dialog .skill-primary').disabled"),
      true,
    );
    assert.equal(
      await page.evaluate(
        "[...document.querySelectorAll('dialog button')].some(b=>['停用','卸载','导入新版本'].includes(b.textContent))",
      ),
      false,
    );
    await select("使用范围", "personal");
    assert.equal(
      await page.evaluate("document.querySelector('dialog .skill-primary').disabled"),
      false,
    );
    await close();
    await page.evaluate("render(false,false)");
    await ready();
    assert.equal(
      await page.evaluate(
        "document.querySelector('.skill-market-header .skill-primary')===null && document.querySelector('.skill-install')===null",
      ),
      true,
    );
    await page.evaluate("window.failList=2;render()");
    await page.waitFor(
      "document.querySelector('[role=alert]')?.textContent.includes('list unavailable')",
    );
    await page.evaluate("window.failList=0");
    await click("重试");
    await ready();
    await page.evaluate(
      "window.failFiles=2;document.querySelector('[data-skill=frontend-design] .skill-card-content').focus();document.querySelector('[data-skill=frontend-design] .skill-card-content').click()",
    );
    await page.waitFor(
      "document.querySelector('dialog [role=alert]')?.textContent.includes('preview unavailable')",
    );
    await page.evaluate("window.failFiles=0");
    await click("重试", "document.querySelector('dialog')");
    await page.waitFor("document.querySelector('.skill-preview')");
    await close();
    await page.evaluate("window.holdList=true");
    await fill("input[type=search]", "review");
    await page.waitFor("window.releaseList");
    await fill("input[type=search]", "weekly");
    await page.waitFor("document.querySelector('[data-skill=weekly-report]')");
    await page.evaluate("releaseList()");
    await page.wait(50);
    assert.equal(
      await page.evaluate(
        "document.querySelectorAll('[data-skill]').length===1 && document.querySelector('[data-skill]').dataset.skill==='weekly-report'",
      ),
      true,
    );
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await fill("input[type=search]", "");
    await ready();
    await page.screenshot("/tmp/pi-cloud-skill-market-mobile.png");
    assert.equal(await page.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
    await page.evaluate(
      "document.querySelector('[data-skill=frontend-design] .skill-card-content').focus();document.querySelector('[data-skill=frontend-design] .skill-card-content').click()",
    );
    await page.waitFor("document.querySelector('.skill-preview')");
    assert.equal(
      await page.evaluate(
        "document.querySelector('dialog').getBoundingClientRect().right<=innerWidth && document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth",
      ),
      true,
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
    await page.waitFor("!document.querySelector('dialog')");
    assert.equal(await page.evaluate("document.activeElement.tagName"), "BUTTON");
    assert.deepEqual(await page.evaluate("errors"), []);
  });
  console.log(
    JSON.stringify({
      skillMarketBrowser: true,
      organizationOnly: true,
      paginatedSearch: true,
      installedView: true,
      scopedMutations: true,
      versionReadRace: true,
      preserveSupportingFiles: true,
      localImport: true,
      viewer: true,
      readFailureRecovery: true,
      mobile: true,
      keyboard: true,
    }),
  );
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
