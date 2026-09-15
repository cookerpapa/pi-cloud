import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createServer as portReservation } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withChromePage } from "./lib/chrome-cdp.mjs";

// Uses the built Web image/Caddy and current dist, but no production accounts,
// database, providers or Cube. Fake API responses test only origin navigation.
const execute = promisify(execFile);
const docker = async (...args) =>
  (await execute("docker", args, { timeout: 60_000 })).stdout.trim();
const root = fileURLToPath(new URL("..", import.meta.url));
const reservations = [];
const containers = [];
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
      "run",
      "--detach",
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
      `${root}/packages/web-ui/dist:/srv:ro`,
      process.env.PI_CLOUD_WEB_TEST_IMAGE ?? "pi-cloud/web-ui:production",
    ),
  );
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
    const requests = [];
    page.onRequest((url) => requests.push(url));
    await page.navigate(product);
    await page.waitFor(
      `location.origin === ${JSON.stringify(admin)} && document.querySelector('.product-admin-page') !== null`,
    );
    const links = await page.evaluate(
      "Array.from(document.querySelectorAll('.product-admin-service-grid a'), a => a.href)",
    );
    assert.deepEqual(links, ["https://models.company.test/management.html"]);
    administrator = false;
    await page.navigate(admin);
    await page.waitFor(
      `location.origin === ${JSON.stringify(product)} && document.querySelector('.product-shell') !== null`,
    );
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
    cleaned: true,
  }),
);
