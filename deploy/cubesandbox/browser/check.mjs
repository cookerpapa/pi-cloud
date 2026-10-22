import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { chromium } from "./index.mjs";

const path = process.argv[2] ?? "/tmp/pi-cloud-browser-check.png";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body { font-family: "Noto Sans CJK SC", sans-serif; background: white; }
    button { font-size: 24px; } canvas { display: block; }
    </style><h1>骑行浏览器验收</h1><button>开始骑行</button><output>0</output>
    <canvas width="200" height="100"></canvas><script>
    document.querySelector('button').onclick = () => {
      document.querySelector('output').textContent = '1';
      const c = document.querySelector('canvas').getContext('2d');
      c.fillStyle = '#22c55e'; c.fillRect(0, 0, 200, 100);
    };</script>`);
  await page.getByRole("button", { name: "开始骑行" }).click();
  assert.equal(await page.locator("output").textContent(), "1");
  assert.deepEqual(
    await page
      .locator("canvas")
      .evaluate((canvas) => [...canvas.getContext("2d").getImageData(10, 10, 1, 1).data]),
    [34, 197, 94, 255],
  );
  await page.screenshot({ path });
  assert.equal((await readFile(path)).subarray(1, 4).toString(), "PNG");
  // An interaction error must still leave the browser to the finally cleanup.
  await assert.rejects(page.getByRole("button", { name: "不存在的按钮" }).click({ timeout: 100 }));
  console.log(
    JSON.stringify({
      browser: browser.version(),
      interaction: true,
      canvas: true,
      screenshot: true,
    }),
  );
} finally {
  await browser.close();
  if (!process.argv[2]) await rm(path, { force: true });
}
