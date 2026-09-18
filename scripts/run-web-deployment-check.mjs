import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createServer as portReservation } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { withChromePage } from "./lib/chrome-cdp.mjs";

// Uses the built Web image/Caddy and current dist, but no production accounts,
// database, providers or Cube. Fake API responses test only origin navigation.
const execute = promisify(execFile);
const docker = async (...args) =>
  (await execute("docker", args, { timeout: 60_000 })).stdout.trim();
const root = fileURLToPath(new URL("..", import.meta.url));
const reservations = [];
const containers = [];
const fixtureDirectory = await mkdtemp(join(tmpdir(), "pi-cloud-protocol-csp-"));
let administrator = true;
const api = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/v1/identity") {
    response.end(
      JSON.stringify({
        tenantId: "10000000-0000-4000-8000-000000000001",
        tenantSlug: "fixture",
        userId: "10000000-0000-4000-8000-000000000002",
        displayName: "Origin fixture",
        role: "owner",
        authenticationKind: "local",
        platformAdministrator: administrator,
      }),
    );
  } else {
    response.writeHead(403);
    response.end(
      JSON.stringify({ error: { code: "forbidden", message: "Outside origin fixture" } }),
    );
  }
});
const listen = async (server, host) => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
};
const close = (server) =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
let failure;
try {
  await cp(`${root}/packages/web-ui/dist`, join(fixtureDirectory, "site"), { recursive: true });
  // Exercise the same browser package conditions under Caddy's real strict CSP.
  await writeFile(
    join(fixtureDirectory, "entry.js"),
    `
    import { createPiCloudEventFactory, parsePiCloudEvent } from ${JSON.stringify(root + "/packages/protocol/src/index.ts")};
    const event = createPiCloudEventFactory({sessionId:'session',turnId:'turn',agentId:'root'})
      .next({type:'assistant.text.delta',payload:{text:'CSP 中文😀'}});
    if(parsePiCloudEvent(event)!==event) throw new Error('Event identity changed');
    let rejected=false;
    try { parsePiCloudEvent({...event,seq:0}); } catch { rejected=true; }
    if(!rejected) throw new Error('Invalid event accepted');
    document.body.dataset.protocolReady='true';
  `,
  );
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      outDir: join(fixtureDirectory, "site"),
      emptyOutDir: false,
      lib: {
        entry: join(fixtureDirectory, "entry.js"),
        formats: ["es"],
        fileName: () => "protocol-fixture.js",
      },
    },
  });
  await writeFile(
    join(fixtureDirectory, "site/protocol-fixture.html"),
    '<!doctype html><body><script type="module" src="/protocol-fixture.js"></script></body>',
  );
  const apiPort = await listen(api, "0.0.0.0");
  for (let index = 0; index < 2; index++) {
    const server = portReservation();
    reservations.push({ server, port: await listen(server, "127.0.0.1") });
  }
  const [product, admin] = reservations.map(({ port }) => `http://127.0.0.1:${port}`);
  const ports = reservations.flatMap(({ port }, index) => [
    "--publish",
    `127.0.0.1:${port}:${8080 + index}`,
  ]);
  await Promise.all(reservations.map(({ server }) => close(server)));
  containers.push(
    await docker(
      "create",
      "--memory",
      "128m",
      "--cpus",
      "0.5",
      "--add-host",
      "host.docker.internal:host-gateway",
      ...ports,
      "--env",
      `PI_CLOUD_CONTROL_PLANE_UPSTREAM=host.docker.internal:${apiPort}`,
      "--env",
      `PI_CLOUD_PUBLIC_ORIGIN_BASE_URL=${product}`,
      "--env",
      `PI_CLOUD_ADMIN_ORIGIN_BASE_URL=${admin}`,
      "--env",
      "PI_CLOUD_PROVIDER_MANAGEMENT_URL=https://models.company.test/management.html",
      "--volume",
      `${root}/packages/web-ui/Caddyfile:/etc/caddy/Caddyfile:ro`,
      "--volume",
      `${fixtureDirectory}/site:/srv:ro`,
      process.env.PI_CLOUD_WEB_TEST_IMAGE ?? "pi-cloud/web-ui:production",
    ),
  );
  await docker("start", containers.at(-1));
  let ready = false;
  for (let index = 0; index < 50 && !ready; index++) {
    try {
      const result = await fetch(`${product}/healthz`);
      ready = result.ok;
      await result.text();
    } catch {
      /* Only the owned listener's startup is being awaited. */
    }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, "Owned Caddy did not become ready");
  for (const origin of [product, admin]) {
    const response = await fetch(`${origin}/ui-config.json`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const config = await response.json();
    assert.equal(config.productUrl, product);
    assert.equal(config.adminUrl, admin);
    assert.equal(config.managementUrls.grafana, "");
  }
  await withChromePage({}, async (page) => {
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      window.cspViolations=[];
      document.addEventListener('securitypolicyviolation', event=>window.cspViolations.push(event.violatedDirective));
    `,
    });
    const fixtureResponse = await fetch(`${product}/protocol-fixture.html`);
    assert.match(fixtureResponse.headers.get("content-security-policy"), /script-src 'self'/);
    assert(!fixtureResponse.headers.get("content-security-policy").includes("unsafe-eval"));
    await fixtureResponse.text();
    await page.navigate(`${product}/protocol-fixture.html`);
    await page.waitFor("document.body.dataset.protocolReady === 'true'");
    assert.deepEqual(await page.evaluate("window.cspViolations"), []);
    const requests = [];
    page.onRequest((url) => requests.push(url));
    await page.navigate(product);
    await page.waitFor(
      `location.origin === ${JSON.stringify(admin)} && document.querySelector('.product-admin-page') !== null`,
    );
    assert.deepEqual(await page.evaluate("window.cspViolations"), []);
    const links = await page.evaluate(
      "Array.from(document.querySelectorAll('.product-admin-service-grid a'), a => a.href)",
    );
    assert.deepEqual(links, ["https://models.company.test/management.html"]);
    administrator = false;
    await page.navigate(admin);
    await page.waitFor(
      `location.origin === ${JSON.stringify(product)} && document.querySelector('.product-shell') !== null`,
    );
    assert.deepEqual(await page.evaluate("window.cspViolations"), []);
    assert(
      !requests.some((url) => /^http:\/\/127\.0\.0\.1:(8080|8081|8318)(\/|$)/.test(url)),
      "UI guessed a production port",
    );
  });
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  for (const id of containers) {
    try {
      assert.match(id, /^[a-f0-9]{64}$/);
      await docker("rm", "--force", id);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const server of [api, ...reservations.map((entry) => entry.server)]) {
    if (server.listening) {
      try {
        await close(server);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  await rm(fixtureDirectory, { recursive: true, force: true });
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Web deployment acceptance failed",
    );
}
console.log(
  JSON.stringify({
    accepted: true,
    customMappedPorts: true,
    administratorRedirect: true,
    productRedirect: true,
    configuredLinksOnly: true,
    strictCspProtocolValidation: true,
    cleaned: true,
  }),
);
