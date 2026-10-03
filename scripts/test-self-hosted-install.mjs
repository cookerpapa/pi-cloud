import { execFile } from "node:child_process";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { validateProductionRuntimeEnvironment } from "./production-runtime-policy.mjs";
import { VOLUME_READER_UID } from "./lib/runtime-file-policy.mjs";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installer = fileURLToPath(new URL("install-self-hosted.sh", import.meta.url));

const help = await execute("bash", [installer, "--help"], { cwd: repositoryRoot });
assert.match(help.stdout, /--check-only/u);
assert.match(help.stdout, /never accepts a model API key/u);

const plan = await execute(
  "bash",
  [installer, "--print-plan", "--runtime-dir", "tmp/example-runtime", "--port", "18080"],
  { cwd: repositoryRoot },
);
assert.match(plan.stdout, /Runtime:.*existing K3s/u);
assert.match(plan.stdout, /tmp\/example-runtime/u);
assert.match(plan.stdout, /http:\/\/127\.0\.0\.1:18080/u);

const installerSource = await readFile(installer, "utf8");
assert.match(installerSource, /\/healthz/u);
assert.match(installerSource, /production:administrator -- --username/u);
assert.match(installerSource, /clean Git checkout/u);
assert.doesNotMatch(installerSource, /health_url=.*\/health(?:["'])/u);

validateProductionRuntimeEnvironment({
  PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY: "http://127.0.0.1:12450",
});
for (const proxy of ["socks5://127.0.0.1:12450", "http://proxy/path", "http://proxy\nEVIL=true"]) {
  assert.throws(
    () => validateProductionRuntimeEnvironment({ PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY: proxy }),
    /PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY/,
  );
}
validateProductionRuntimeEnvironment({});
validateProductionRuntimeEnvironment({
  PI_CLOUD_HTTP_PORT: "18080",
  PI_CLOUD_ADMIN_PORT: "19090",
  PI_CLOUD_PUBLIC_ORIGIN_BASE_URL: "https://chat.company.test",
  PI_CLOUD_ADMIN_ORIGIN_BASE_URL: "https://ops.company.test",
  PI_CLOUD_GRAFANA_URL: "https://monitor.company.test/grafana/",
});
for (const value of [
  "javascript:alert(1)",
  "http://user:secret@ops.company.test",
  "https://ops.company.test/admin",
]) {
  assert.throws(
    () => validateProductionRuntimeEnvironment({ PI_CLOUD_ADMIN_ORIGIN_BASE_URL: value }),
    /PI_CLOUD_ADMIN_ORIGIN_BASE_URL/,
  );
}
assert.throws(
  () =>
    validateProductionRuntimeEnvironment({
      PI_CLOUD_KAFKA_PARTITIONS: "not-an-integer",
    }),
  /must be an integer/u,
);
assert.throws(
  () =>
    validateProductionRuntimeEnvironment({
      PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS: "300000",
      PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_REQUEST_TIMEOUT_MS: "300000",
    }),
  /queue wait must be shorter/u,
);

await assert.rejects(
  execute("bash", [installer, "--print-plan", "--pi-workers", "invalid"], {
    cwd: repositoryRoot,
  }),
  (error) => {
    assert.match(error.stderr, /unknown option.*--pi-workers/u);
    return true;
  },
);

process.stdout.write("self_hosted_install_contract_ok\n");
