import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rename, stat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fetch, ProxyAgent } from "undici";
import { stringify } from "yaml";
import { createDatabase } from "../packages/database/src/index.ts";
import { PostgresTenantApiAuthenticator } from "../packages/control-plane/src/tenant-identity.ts";
import { PlatformRuntimeSettingsService } from "../packages/control-plane/src/platform-runtime-settings.ts";
import { serializeRelease } from "./lib/release-lock.mjs";
import {
  configuredUpstreamProxy,
  normalizeUpstreamProxy,
  proxyEnvironment,
  replaceEnvironmentValue,
} from "./lib/upstream-proxy.mjs";
import {
  repositoryRoot,
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  kubeconfig,
  namespace,
  kubectl,
} from "./lib/production-kubernetes.mjs";

if (process.argv[2] === "--help") {
  console.log(
    "Usage: npm run production:proxy -- HTTP(S)_ORIGIN\nOmit the address to reapply runtime/upstream-proxy. Synchronizes Docker/K3s service proxies, model Relay and Cube egress; preserves the Cube enabled setting. Host administrator access and idle Docker are required. Normal K3s service restart preserves workload containers.",
  );
  process.exit(0);
}
assert(process.argv.length <= 3, "Expected a single proxy address");
const proxy = normalizeUpstreamProxy(process.argv[2] ?? configuredUpstreamProxy() ?? "");
serializeRelease(runtimeDirectory);
const environment = runtimeEnvironment();
const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";
const helmArgs = ["--kubeconfig", kubeconfig, "--namespace", namespace];
const helmCapture = (args) =>
  execFileSync(helm, [...args, ...helmArgs], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
  });
const installed = JSON.parse(
  helmCapture(["get", "values", "pi-cloud-infrastructure", "--output", "json"]),
);
assert(installed.provider, "Installed infrastructure provider values are missing");
const databaseUrl = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
databaseUrl.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: databaseUrl.toString(), maxConnections: 1 });
let phase = "preflight";
async function save(path, text) {
  const old = await readFile(path, "utf8").catch((e) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (old === text) return;
  const mode = old === undefined ? 0o600 : (await stat(path)).mode & 0o777;
  const temporary = path + `.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}
try {
  const token = (await readFile(resolve(runtimeDirectory, "secrets/api-token"), "utf8")).trim();
  const identity = await new PostgresTenantApiAuthenticator({ database }).authenticate(token);
  const settings = new PlatformRuntimeSettingsService({
    database,
    platformOperatorTenantId: environment.PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID,
  });
  assert(
    identity && settings.isPlatformAdministrator(identity),
    "The configured API credential must belong to the existing platform operator",
  );
  await settings.get(identity);
  const dispatcher = new ProxyAgent(proxy);
  try {
    const response = await fetch("https://registry.npmjs.org/-/ping", {
      dispatcher,
      signal: AbortSignal.timeout(20000),
    });
    assert(response.ok, "The requested upstream proxy failed its HTTPS connectivity check");
    await response.body?.cancel();
  } finally {
    await dispatcher.close();
  }
  const hostScript = resolve(repositoryRoot, "scripts/apply-host-proxy.mjs");
  const proxyFile = resolve(runtimeDirectory, "upstream-proxy");
  // Establish host administration before changing persisted destinations.
  const elevated =
    process.getuid?.() === 0
      ? []
      : process.env.WSL_DISTRO_NAME
        ? ["wsl.exe", "--distribution", process.env.WSL_DISTRO_NAME, "--user", "root", "--exec"]
        : ["sudo", "-n"];
  if (elevated.length)
    execFileSync(elevated[0], [...elevated.slice(1), "id", "-u"], { stdio: "ignore" });
  phase = "persist requested address";
  await save(proxyFile, proxy + "\n");
  const envPath = resolve(runtimeDirectory, ".env");
  await save(
    envPath,
    replaceEnvironmentValue(
      await readFile(envPath, "utf8"),
      "PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY",
      proxy,
    ),
  );
  Object.assign(process.env, proxyEnvironment(process.env, proxy));
  phase = "model Relay";
  let relayChanged = false;
  const live = JSON.parse(
    kubectl(["get", "deployment", "provider-host-egress-relay", "-o", "json"]),
  );
  const liveProxy = live.spec.template.spec.containers[0].env.find(
    (v) => v.name === "PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY",
  )?.value;
  if (installed.provider.upstreamProxy !== proxy || liveProxy !== proxy) {
    const override = resolve(runtimeDirectory, "k3s/upstream-proxy.values.json");
    await mkdir(resolve(runtimeDirectory, "k3s"), { recursive: true, mode: 0o700 });
    await save(override, JSON.stringify({ provider: { upstreamProxy: proxy } }, null, 2) + "\n");
    execFileSync(
      helm,
      [
        "upgrade",
        "pi-cloud-infrastructure",
        resolve(repositoryRoot, "deploy/helm/pi-cloud-infrastructure"),
        ...helmArgs,
        "--reuse-values",
        "--values",
        override,
        "--wait",
        "--timeout",
        "180s",
      ],
      { stdio: "inherit", timeout: 200000 },
    );
    relayChanged = true;
  }
  const applied = JSON.parse(
    helmCapture(["get", "values", "pi-cloud-infrastructure", "--output", "json"]),
  );
  await save(resolve(runtimeDirectory, "k3s/infrastructure.yaml"), stringify(applied));
  await save(
    resolve(runtimeDirectory, "k3s/infrastructure-rendered.yaml"),
    helmCapture(["get", "manifest", "pi-cloud-infrastructure"]),
  );
  phase = "Cube egress";
  const cube = await settings.replaceUpstreamProxy(identity, proxy);
  phase = "host Docker/K3s services";
  const command = elevated.length ? elevated[0] : process.execPath;
  const args = elevated.length
    ? [...elevated.slice(1), process.execPath, hostScript, proxyFile]
    : [hostScript, proxyFile];
  execFileSync(command, args, { stdio: "inherit", timeout: 630000 });
  console.log(
    JSON.stringify({
      upstreamProxy: proxy,
      relayChanged,
      cubeRevision: cube.revision,
      cubeEgressEnabled: cube.enabled,
      configured: true,
    }),
  );
} catch (error) {
  console.error(
    `Upstream proxy update failed during ${phase}: ${error instanceof Error ? error.message : "unknown error"}. Reapply the same command after resolving this phase.`,
  );
  process.exitCode = 1;
} finally {
  await database.destroy();
}
