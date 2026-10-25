import assert from "node:assert/strict";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { dirname, join } from "node:path/posix";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
import { withChromePage } from "./chrome-cdp.mjs";
import { imageReferences, nativeMessages } from "./native-session-history.mjs";

/** One owned local application, exercised by the guest and the real product UI. */
export async function guestBrowserAcceptance({
  api,
  tenant,
  session,
  baseUrl,
  directory,
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
  progress("guest Chromium screenshot, show_image snapshot and live named answer link");
  await withChromePage({}, async (page) => {
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + tenant.credential.token },
    });
    const conversationUrl = baseUrl + "/?session=" + session.sessionId;
    await page.navigate(conversationUrl);
    await page.waitFor("document.querySelector('.product-composer textarea')");
    const accepted = await api.acceptTurn(
      session.sessionId,
      `按顺序执行以下步骤，不要搜索、委派或生图。1. 调用一次 bash，command 精确为以下 JSON 字符串：${JSON.stringify(command)}。2. 调用 read 查看 ${screenshotPath}。3. 调用 show_image 展示这张截图，caption 为「骑行示例页面」。4. 调用 bash，精确执行 ${JSON.stringify(`rm -- ${screenshotPath}; sleep 3; test ! -e ${screenshotPath} && echo SCREENSHOT_SOURCE_REMOVED`)}，这是验证历史图片不会依赖原文件。5. 调用 preview 发布端口 5173。应用名为「骑行示例」。最终回答图片顶部的六位数字，并用具名 Markdown 链接提供 preview 返回的地址，不要再嵌入图片。不要读取测试源码或其他文件，不要安装任何软件。`,
      newIdempotencyKey("guest-browser"),
      "low",
    );
    const shown = `.product-tool-images img`;
    await page.waitFor(`document.querySelector(${JSON.stringify(shown)})?.naturalWidth>0`, 240000);
    const liveImagePath = await page.evaluate(
      `document.querySelector(${JSON.stringify(shown)}).getAttribute('src')`,
    );
    const assertInlineImage = async () => {
      assert.equal(
        await page.evaluate(`document.querySelectorAll(${JSON.stringify(shown)}).length`),
        1,
      );
      assert.equal(
        await page.evaluate("document.querySelectorAll('.product-session-image img').length"),
        1,
        "Read must not display a second model-only image",
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('.product-tool-images').closest('.product-activity-group')===null",
        ),
        true,
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('.product-tool-images figcaption').textContent",
        ),
        "骑行示例页面",
      );
      assert.equal(
        await page.evaluate("document.querySelector('.product-tool-images a').target"),
        "_blank",
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('.product-activity-group-toggle').getAttribute('aria-expanded')",
        ),
        "false",
      );
    };
    await assertInlineImage();
    await page.evaluate(
      "document.querySelector('.product-tool-images').scrollIntoView({block:'center'})",
    );
    if (directory) await page.screenshot(join(directory, "guest-image-live.png"));
    const path = `/v1/conversations/${session.sessionId}/preview/5173/`;
    const link = `.product-agent-answer .product-markdown a[href="${path}"]`;
    const visible = `(()=>{const e=document.querySelector(${JSON.stringify(link)});return e&&e.getBoundingClientRect().height>0})()`;
    // The page is already mounted before the Run. This must arrive through SSE,
    // independently of a later cold-history read or manual expansion.
    await page.waitFor(visible, 240000);
    history = await completed(accepted.runId);
    await page.waitFor("!document.querySelector('.product-run-status')");
    const assertSingleAnswerLink = async () => {
      assert.equal(
        await page.evaluate(`document.querySelectorAll(${JSON.stringify(link)}).length`),
        1,
      );
      assert(
        (
          await page.evaluate(`document.querySelector(${JSON.stringify(link)}).textContent`)
        ).includes("骑行示例"),
      );
      assert.equal(
        await page.evaluate("document.querySelector('.product-preview-tool-link')===null"),
        true,
      );
      const visibleAnswer = await page.evaluate(
        "[...document.querySelectorAll('.product-agent-answer .product-markdown')].map(e=>e.innerText).join('\\n')",
      );
      assert(
        !/端口\s*[:：]?\s*5173|port\s*[:：]?\s*5173/i.test(visibleAnswer),
        "Ordinary answer must not advertise the internal port",
      );
    };
    await assertSingleAnswerLink();
    const turn = (await api.getConversation(session.sessionId)).turns.find(
      (t) => t.runId === accepted.runId,
    );
    const tools = turn.transcript.items.filter((item) => item.kind === "tool");
    const shownTools = tools.filter((item) => item.toolName === "show_image");
    assert.equal(shownTools.length, 1);
    assert.equal(shownTools[0].status, "completed");
    assert.equal(
      tools.some((item) => item.toolName === "generate_image"),
      false,
    );
    const publicImage = shownTools[0].output.content.find((part) => part.type === "image");
    assert.equal(
      publicImage?.previewPath,
      liveImagePath,
      "Live and cold image identity must match",
    );
    const reference = imageReferences(history).find((ref) => ref.id === publicImage.imageId);
    assert(reference);
    assert(
      nativeMessages(history).some(
        (m) =>
          m.role === "toolResult" &&
          m.toolName === "bash" &&
          !m.isError &&
          m.content.some((p) => p.type === "text" && p.text.includes("SCREENSHOT_SOURCE_REMOVED")),
      ),
    );
    const retained = await fetch(new URL(liveImagePath, baseUrl), {
      headers: { Authorization: "Bearer " + tenant.credential.token },
    });
    assert.equal(retained.status, 200, "Retained display must survive source deletion");
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(await retained.arrayBuffer()))
        .digest("hex"),
      reference.sha256,
    );
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
    await page.waitFor(`document.querySelector(${JSON.stringify(shown)})?.naturalWidth>0`);
    await assertInlineImage();
    assert.equal(
      await page.evaluate(`document.querySelector(${JSON.stringify(shown)}).getAttribute('src')`),
      liveImagePath,
    );
    await page.evaluate(
      "document.querySelector('.product-tool-images').scrollIntoView({block:'center'})",
    );
    if (directory) await page.screenshot(join(directory, "guest-image-cold.png"));
    await assertSingleAnswerLink();
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
    showImageLiveAndCold: true,
    collapsedActivityStillShowsImage: true,
    modelOnlyReadDoesNotDuplicate: true,
    retainedImageAfterSourceDeletion: true,
    liveLink: true,
    coldCollapsedLink: true,
    actualApplicationNavigation: true,
    noDuplicatePreviewAction: true,
    namedLinkWithoutPortLabel: true,
  };
}
