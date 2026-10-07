// Real ChatApp/PiCloudApi lost-ACK regression. No provider or production calls.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createServer } from "vite";
import { withChromePage } from "../../lib/chrome-cdp.mjs";
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), "pi-cloud-review-submit-"));
const source = await readFile(
  resolve(repositoryRoot, "scripts/run-browser-presentation-check.mjs"),
  "utf8",
);
const start = source.indexOf("const fixture = "),
  end = source.indexOf("\nconst server = ", start);
assert(start >= 0 && end > start, "Maintained browser fixture boundary changed");
const fixture = runInNewContext(source.slice(start, end) + "\nfixture");
const server = await createServer({
  configFile: false,
  root: resolve(repositoryRoot, "packages/web-ui"),
  cacheDir,
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "presentation-fixture",
      resolveId(id) {
        if (id === "/presentation-fixture.js") return "\0presentation-fixture";
      },
      load(id) {
        if (id === "\0presentation-fixture") return fixture;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/ui-config.json") {
            const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
            res.setHeader("content-type", "application/json");
            return res.end(
              JSON.stringify({
                productUrl: origin,
                adminUrl: origin,
                managementUrls: {
                  providerGateway: "",
                  grafana: "",
                  prometheus: "",
                  alertmanager: "",
                  jaeger: "",
                },
              }),
            );
          }
          if (req.url === "/v1/identity") {
            res.statusCode = 401;
            res.setHeader("content-type", "application/json");
            return res.end(
              JSON.stringify({
                error: { code: "authentication_required", message: "Login required" },
              }),
            );
          }
          if (req.url === "/v1/auth/providers") {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ local: { login: true, registration: true } }));
          }
          if (req.url !== "/review.html") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><div id="root"></div><script type="module" src="/presentation-fixture.js"></script>',
          );
        });
      },
    },
  ],
});

try {
  await server.listen();
  const port = server.httpServer.address().port;
  await withChromePage({}, async (page) => {
    await page.navigate(`http://127.0.0.1:${port}/review.html`);
    await page.waitFor("window.fixtureReady");
    await page.evaluate("renderChat('idle',true,true)");
    await page.waitFor(
      "document.querySelector('.product-conversation-row:not(.product-delegated-session) > button:first-child')",
    );
    await page.evaluate(
      "document.querySelector('.product-conversation-row:not(.product-delegated-session) > button:first-child').click()",
    );
    await page.waitFor(
      "document.querySelector('.product-composer textarea') && !document.querySelector('.product-composer textarea').disabled",
    );
    await page.evaluate(
      `window.acceptTurns=true;window.loseTurnReply=true;const input=document.querySelector('.product-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Run the project test once');input.dispatchEvent(new Event('input',{bubbles:true}));`,
    );
    await page.waitFor("!document.querySelector('.product-send-button').disabled");
    await page.evaluate("document.querySelector('.product-send-button').click()");
    await page.waitFor(
      "turnRequests.length===1 && !document.querySelector('.product-send-button').disabled",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-composer textarea').value"),
      "Run the project test once",
    );
    await page.evaluate("document.querySelector('.product-send-button').click()");
    await page.waitFor("turnRequests.length===2");
    const result = await page.evaluate("({calls:turnRequests,acceptedRuns:turnReceipts.size})");
    assert.equal(result.acceptedRuns, 1);
    assert.equal(result.calls[0].key, result.calls[1].key);
    if (process.argv[2])
      await writeFile(
        process.argv[2],
        JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            scope:
              "Real ChatApp DOM with isolated response-loss fixture; no provider or production data",
            ...result,
          },
          null,
          2,
        ),
      );
    console.log(
      JSON.stringify({
        sameDraft: true,
        attempts: 2,
        distinctAcceptedRuns: result.acceptedRuns,
        keysDiffer: false,
      }),
    );
  });
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
