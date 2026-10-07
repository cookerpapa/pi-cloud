// Characterizes stale identity across ordinary send -> Steer -> fresh ordinary send.
// Verifies repaired behavior; original defect evidence is retained in the review JSON.
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
    const cases = [];
    for (const firstKind of ["turn", "steer"]) {
      await page.navigate(`http://127.0.0.1:${port}/review.html`);
      await page.waitFor("window.fixtureReady");
      await page.evaluate("renderChat('running',true,true)");
      await page.waitFor(
        "document.querySelector('.product-conversation-row:not(.product-delegated-session) > button:first-child')",
      );
      await page.evaluate(
        "document.querySelector('.product-conversation-row:not(.product-delegated-session) > button:first-child').click()",
      );
      await page.waitFor(
        "document.querySelector('.product-composer textarea') && !document.querySelector('.product-composer textarea').disabled",
      );
      const fill = async (text) =>
        page.evaluate(
          `(()=>{const input=document.querySelector('.product-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
      const submit = async (kind) => {
        await page.waitFor("!document.querySelector('.product-steer-button').disabled");
        await page.evaluate(
          kind === "steer"
            ? "document.querySelector('.product-steer-button').click()"
            : "document.querySelector('.product-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
        );
      };
      await page.evaluate(
        `window.acceptTurns=true;window.${firstKind === "turn" ? "loseTurnReply" : "loseSteerReply"}=true;`,
      );
      await fill("Run the project test once");
      await submit(firstKind);
      const requests = firstKind === "turn" ? "turnRequests" : "steerRequests";
      await page.waitFor(
        `${requests}.length===1 && !document.querySelector('.product-steer-button').disabled`,
      );
      assert.equal(
        await page.evaluate("document.querySelector('.product-composer textarea').value"),
        "Run the project test once",
      );
      await fill("A different instruction using the other action");
      await submit(firstKind === "turn" ? "steer" : "turn");
      await page.waitFor("document.querySelector('.product-composer textarea').value===''");
      await fill("Run the project test once");
      await submit(firstKind);
      await page.waitFor(
        `${requests}.length===2 && document.querySelector('.product-composer textarea').value===''`,
      );
      const result = await page.evaluate(
        `({calls:${requests},ordinaryAdmissions:turnReceipts.size,steerAdmissions:steerReceipts.size})`,
      );
      assert.equal(result.ordinaryAdmissions, firstKind === "turn" ? 2 : 1);
      assert.equal(result.steerAdmissions, firstKind === "steer" ? 2 : 1);
      assert.notEqual(result.calls[0].key, result.calls[1].key);
      cases.push({
        firstKind,
        ordinaryAdmissions: result.ordinaryAdmissions,
        steerAdmissions: result.steerAdmissions,
        keysDiffer: true,
      });
    }
    const report = {
      observedAt: new Date().toISOString(),
      scope: "Actual ChatApp/PiCloudApi with response-loss fixture; no model or production data",
      cases,
    };
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  });
} finally {
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
