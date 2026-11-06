import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { withChromePage } from "./lib/chrome-cdp.mjs";

const cacheDir = await mkdtemp(join(tmpdir(), "pi-billing-browser-"));
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ModelBilling } from "/src/ModelBilling.tsx";
import { I18nProvider } from "/src/i18n.tsx";
import "/src/product.css";
const context={invocationId:"fixture",requestedAt:"2026-11-06T08:00:00.000Z",model:"gpt-6-luna",purpose:"agent"};
const usage={model:"gpt-6-luna",failed:false,tokens:{input:60,cacheRead:40,cacheWrite:0,output:20,reasoning:10}};
const row={context,state:"unconfirmed",missingAttempts:1,interrupted:true,usage:[{executionId:"a",occurredAt:context.requestedAt,usage,valuation:{customer:{state:"priced",currency:"USD",amountPico:"230000000"},upstream_estimate:{state:"unpriced"}}}]};
window.queries=[];
const api={async modelBilling(q){queries.push(q.toString());return q.has("beforeId")?{items:[{context:{...context,invocationId:"next",model:"next-page-model"},state:"pending",missingAttempts:0,interrupted:false,usage:[]}],next:null}:{items:[row],next:{time:context.requestedAt,id:"00000000-0000-4000-8000-000000000001"}}},async modelBillingSummary(){return {collectionEnabled:false,categories:[{kind:"customer",state:"priced",currency:"USD",amountPico:"230000000",count:"1"},{kind:"customer",state:"unpriced",currency:null,amountPico:null,count:"1"}]}}};
createRoot(document.getElementById("root")).render(React.createElement(I18nProvider,null,React.createElement(ModelBilling,{api,sessionId:"00000000-0000-4000-8000-000000000002",onClose(){window.closedBilling=true}})));
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
      name: "billing-contract",
      resolveId(id) {
        if (id === "/billing-fixture.js") return "\0billing-fixture";
      },
      load(id) {
        if (id === "\0billing-fixture") return fixture;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/billing-contract") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><div id="root"></div><script type="module" src="/billing-fixture.js"></script>',
          );
        });
      },
    },
  ],
});
try {
  await server.listen();
  await withChromePage({ width: 1280, height: 800 }, async (page) => {
    await page.navigate(`http://127.0.0.1:${server.httpServer.address().port}/billing-contract`);
    await page.waitFor("document.body.innerText.includes('0.00023')");
    const text = await page.evaluate("document.body.innerText");
    assert.match(text, /未扣款|No collection/);
    assert.match(text, /部分用量未确认|Some usage is unconfirmed/);
    assert.match(text, /未定价|Unpriced/);
    assert.equal(
      await page.evaluate("document.querySelector('td:nth-child(3)').textContent"),
      "60",
    );
    await page.screenshot("/tmp/pi-cloud-model-billing.png");
    await page.evaluate("document.querySelector('footer button:last-child').click()");
    await page.waitFor("document.body.innerText.includes('next-page-model')");
    assert(await page.evaluate("queries.some(q=>q.includes('beforeId='))"));
    assert(await page.evaluate("document.querySelector('footer button:last-child').disabled"));
    await page.evaluate(
      "document.querySelector('input[type=checkbox]').click();document.querySelector('button[type=submit]').click()",
    );
    await page.waitFor("queries.some(q=>q.includes('sessionId='))");
    assert.equal(await page.evaluate("document.querySelector('footer span').textContent"), "1");
    assert(await page.evaluate("document.querySelector('footer button:first-child').disabled"));
    await page.evaluate("document.querySelector('header button').click()");
    assert(await page.evaluate("window.closedBilling"));
  });
  console.log("model_billing_browser_check_passed");
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
