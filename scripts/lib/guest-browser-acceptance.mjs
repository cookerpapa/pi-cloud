import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { dirname } from "node:path/posix";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
import { withChromePage } from "./chrome-cdp.mjs";
import { imageReferences, nativeMessages } from "./native-session-history.mjs";

/** One owned local application, exercised by the guest and the real product UI. */
export async function guestBrowserAcceptance({
  api,
  tenant,
  session,
  baseUrl,
  completed,
  progress,
}) {
  const code = String(randomInt(100000, 999999));
  const html = `<!doctype html><meta charset="utf-8"><title>Guest browser acceptance</title>
<style>body{font-family:sans-serif;background:white;font-size:32px}h1{font-size:64px}</style>
<h1>${code}</h1><button id="ride">开始骑行</button><p id="count">0</p>
<canvas width="300" height="100"></canvas><script>
document.querySelector('#ride').onclick=()=>{document.querySelector('#count').textContent='1';
const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#22c55e';c.fillRect(0,0,300,100)};
</script>`;
  const upload = (name, content) =>
    api.uploadWorkspaceFile(
      session.sessionId,
      randomUUID(),
      new Blob([content], { type: "text/plain" }),
      name,
    );
  const application = await upload("index.html", html);
  const screenshotPath = "/workspace/guest-browser.png";
  const script = await upload(
    "guest-browser.mjs",
    `import assert from 'node:assert/strict';
import { chromium } from '/opt/pi-cloud/browser/index.mjs';
for(let n=0;;n++){try{const r=await fetch('http://127.0.0.1:5173/');assert(r.ok);break}
catch(e){if(n===30)throw e;await new Promise(r=>setTimeout(r,100))}}
const browser=await chromium.launch();
try{
const page=await browser.newPage({viewport:{width:800,height:600}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:5173/');
await page.getByRole('button',{name:'开始骑行'}).click();
assert.equal(await page.locator('#count').textContent(),'1');
assert.deepEqual(await page.locator('canvas').evaluate(c=>[...c.getContext('2d').getImageData(5,5,1,1).data]),[34,197,94,255]);
assert.deepEqual(errors,[]);await page.screenshot({path:${JSON.stringify(screenshotPath)}});
console.log('GUEST_BROWSER_INTERACTION_OK');
}finally{await browser.close()}
`,
  );
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `setsid python3 -m http.server 5173 --bind 0.0.0.0 --directory ${quote(dirname(application.path))} </dev/null >/tmp/guest-browser-server.log 2>&1 &\nnode ${quote(script.path)}`;
  let history;
  progress("guest Chromium interaction, screenshot Read and live preview action");
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + tenant.credential.token },
    });
    const conversationUrl = baseUrl + "/?session=" + session.sessionId;
    await page.navigate(conversationUrl);
    await page.waitFor("document.querySelector('.product-composer textarea')");
    const accepted = await api.acceptTurn(
      session.sessionId,
      `按顺序执行这三步，不要搜索或委派。1. 调用一次 bash，command 精确为以下 JSON 字符串：${JSON.stringify(command)}。2. 调用 read 查看 ${screenshotPath}。3. 调用 preview 发布端口 5173。最终回答图片顶部的六位数字，并用 Markdown 链接提供 preview 返回的地址。不要读取测试源码或其他文件，不要安装任何软件。`,
      newIdempotencyKey("guest-browser"),
      "low",
    );
    const path = `/v1/conversations/${session.sessionId}/preview/5173/`;
    const link = `.product-preview-tool-link[href="${path}"]`;
    const visible = `(()=>{const e=document.querySelector(${JSON.stringify(link)});return e&&e.getBoundingClientRect().height>0})()`;
    // The page is already mounted before the Run. This must arrive through SSE,
    // independently of a later cold-history read or manual expansion.
    await page.waitFor(visible, 240000);
    history = await completed(accepted.runId);
    const turn = (await api.getConversation(session.sessionId)).turns.find(
      (t) => t.runId === accepted.runId,
    );
    const tools = turn.transcript.items.filter((item) => item.kind === "tool");
    const preview = tools.find((item) => item.toolName === "preview");
    assert.equal(preview?.status, "completed");
    assert.equal(preview.output.details.previewPath, path);
    assert(preview.output.content.some((part) => part.type === "text" && part.text.includes(path)));
    assert(
      nativeMessages(history).some(
        (m) =>
          m.role === "toolResult" &&
          m.toolName === "bash" &&
          !m.isError &&
          m.content.some(
            (p) => p.type === "text" && p.text.includes("GUEST_BROWSER_INTERACTION_OK"),
          ),
      ),
    );
    assert(
      imageReferences(history).length > 0,
      "Native Read screenshot did not use attachment storage",
    );
    const answer = nativeMessages(history)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    assert(answer.includes(code), "Model did not read the screenshot");
    assert(answer.includes(path), "Model omitted the returned application link");
    await page.navigate(conversationUrl);
    await page.waitFor(visible);
    assert(await page.evaluate("Boolean(document.querySelector('[data-expanded=\"false\"]'))"));
    await page.navigate(baseUrl + path);
    await page.waitFor("document.querySelector('#ride')");
    await page.evaluate("document.querySelector('#ride').click()");
    assert.equal(await page.evaluate("document.querySelector('#count').textContent"), "1");
  });
  return {
    guestInteraction: true,
    canvas: true,
    screenshotVision: true,
    liveLink: true,
    coldCollapsedLink: true,
    actualApplicationNavigation: true,
  };
}
