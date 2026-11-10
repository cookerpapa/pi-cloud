import { randomUUID } from "node:crypto";
import { register } from "tsx/esm/api";

import { serviceAddress, kubectl } from "./lib/production-kubernetes.mjs";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { testPostgres } from "./lib/test-postgres.mjs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
register();
const { purgeOwnedAcceptanceTenant } = await import("./lib/owned-acceptance-cleanup.mjs");
const runtimeDirectory =
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ??
  fileURLToPath(new URL("../deploy/production/runtime", import.meta.url));

function assertEndpoint(value, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.host !== "string" ||
    value.host.length < 1 ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    throw new Error(`${label} evidence was invalid`);
  }
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function workspaceVolumeGatewayAddress() {
  return serviceAddress("workspace-volume-gateway");
}

const cluster = await readJson(`${runtimeDirectory}/cubesandbox/cluster.json`);
const template = await readJson(`${runtimeDirectory}/cubesandbox/template.json`);
const api = assertEndpoint(cluster.api, "Cube API");
const master = assertEndpoint(cluster.master, "Cube master");
const registry = assertEndpoint(cluster.registry, "Cube registry");
const proxy = assertEndpoint(cluster.proxy, "Cube proxy");
if (
  typeof cluster.sandboxDomain !== "string" ||
  template.formatVersion !== 2 ||
  typeof template.agent?.templateId !== "string" ||
  typeof template.imageRevision !== "string"
) {
  throw new Error("Cube cluster/template evidence was invalid");
}

const gatewayAddress = workspaceVolumeGatewayAddress();
// Native librdkafka resolves broker names itself. Keep Kubernetes Service
// aliases in an owned operator container, never in the host or product config.
const testDatabase = await testPostgres();
const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-native-live-"));
const nodePrefix = resolve(dirname(process.execPath), "..");
const build = await readJson(join(repositoryRoot, "deploy/cubesandbox/runtime-build.json"));
const kafkaServices = ["kafka-1", "kafka-2", "kafka-3"];
const runtimeDeployment = JSON.parse(
  kubectl(["get", "deployment/pi-cloud-session-runtime", "-o", "json"]),
);
const completionUrl = runtimeDeployment.spec.template.spec.containers[0].env.find(
  (e) => e.name === "PI_CLOUD_TOOL_COMPLETION_URL",
)?.value;
if (!completionUrl) throw new Error("Installed completion URL is missing");
const completionHost = new URL(completionUrl).hostname;
await writeFile(
  join(temporary, "completion-ca.crt"),
  Buffer.from(
    kubectl([
      "get",
      "secret",
      "pi-cloud-tool-completion-tls",
      "-o",
      "jsonpath={.data.ca\\.crt}",
    ]).trim(),
    "base64",
  ),
);
const scope = process.env.PI_CLOUD_CUBE_LIVE_SCOPE ?? "all";
if (!["all", "provider", "guest"].includes(scope)) throw new Error("Unknown Cube live scope");
const liveFiles = [
  ...(scope !== "guest" ? ["test/cubesandbox-live-provider.integration.test.ts"] : []),
  ...(scope !== "provider" ? ["test/cubesandbox-guest-executor.live.test.ts"] : []),
];
const owned = [];
let businessDb;
const ownershipPath = join(temporary, "owned-resources.json");
const saveOwned = () =>
  writeFile(ownershipPath, JSON.stringify(owned.map(({ api, ...identity }) => identity)), {
    mode: 0o600,
  });
async function prepareBusinessFixtures() {
  if (scope === "guest") return;
  const { PiCloudApi } = await import("../packages/web-ui/src/api.ts");
  const { createDatabase } = await import("../packages/database/src/index.ts");
  const dbUrl = new URL(
    (await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim(),
  );
  dbUrl.hostname = serviceAddress("postgres");
  businessDb = createDatabase({ connectionString: dbUrl.toString(), maxConnections: 2 });
  const httpPort = (await readFile(`${runtimeDirectory}/.env`, "utf8")).match(
    /^PI_CLOUD_HTTP_PORT=(\d+)$/m,
  )?.[1];
  if (!httpPort) throw new Error("Production API port is missing");
  const fetchApi = (url, init) => fetch(new URL(String(url), `http://127.0.0.1:${httpPort}`), init);
  for (let i = 0; i < 4; i++) {
    const tenantSlug = "cube-check-provider-" + randomUUID();
    const entry = { tenantSlug };
    owned.push(entry);
    await saveOwned();
    const registration = await new PiCloudApi(fetchApi).registerTenant(
      tenantSlug,
      "Owned native Provider acceptance",
    );
    Object.assign(entry, registration, { api: new PiCloudApi(fetchApi, registration.apiToken) });
    await saveOwned();
    const project = await entry.api.createProject("Native Provider acceptance", { kind: "empty" });
    Object.assign(entry, {
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      sessionId: randomUUID(),
    });
    await saveOwned();
  }
}
async function cleanupBusinessFixtures() {
  for (const entry of owned) {
    if (!entry.tenantId)
      throw new Error("Registration outcome needs reconciliation using the saved owned slug");
    if (entry.workspaceId) {
      await entry.api.deleteWorkspace(entry.workspaceId, randomUUID());
      const end = Date.now() + 180000;
      for (;;) {
        const row = await businessDb
          .selectFrom("workspaces")
          .select("storage_purged_at")
          .where("id", "=", entry.workspaceId)
          .where("tenant_id", "=", entry.tenantId)
          .executeTakeFirst();
        if (!row || row.storage_purged_at) break;
        if (Date.now() > end) throw new Error("Owned Workspace cleanup remains unconfirmed");
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await purgeOwnedAcceptanceTenant(businessDb, entry, {
      delete: async () => {
        throw new Error("Unexpected retained image in native Provider fixture");
      },
    });
  }
}
const environment = {
  PI_CLOUD_POSTGRES_INTEGRATION_URL: testDatabase.url,
  PI_CLOUD_TOOL_COMPLETION_URL: completionUrl,
  PI_CLOUD_TOOL_COMPLETION_IP: serviceAddress("tool-completion"),
  PI_CLOUD_COMPLETION_CA_FILE: "/operator-test/completion-ca.crt",
  PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE: `${runtimeDirectory}/secrets/supervisor-management-token`,
  PI_CLOUD_CUBESANDBOX_TEST: "1",
  PI_CLOUD_CUBE_LIVE_ASSIGNMENTS_FILE: "/operator-test/owned-resources.json",
  PI_CLOUD_KAFKA_BROKERS: kafkaServices.map((name) => name + ":9092").join(","),
  PI_CLOUD_KAFKA_REPLICAS: "3",
  PI_CLOUD_CUBESANDBOX_API_URL: `http://${api.host}:${api.port}`,
  PI_CLOUD_CUBESANDBOX_API_KEY_FILE: `${runtimeDirectory}/secrets/cubesandbox-api-key`,
  PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP: proxy.host,
  PI_CLOUD_CUBESANDBOX_PROXY_PORT: String(proxy.port),
  PI_CLOUD_CUBESANDBOX_DOMAIN: cluster.sandboxDomain,
  PI_CLOUD_CUBESANDBOX_TEMPLATE_ID: template.agent.templateId,
  PI_CLOUD_IMAGE_REVISION: template.imageRevision,
  PI_CLOUD_CUBESANDBOX_FORBIDDEN_ENDPOINTS: `${master.host}:${master.port},${registry.host}:${registry.port}`,
  PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL: `http://${gatewayAddress}:4500`,
  PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: `${runtimeDirectory}/secrets/workspace-volume-gateway-token`,
};
try {
  await prepareBusinessFixtures();
  await writeFile(
    join(temporary, "vitest.mjs"),
    "export default {cacheDir:'/tmp/pi-cloud-test-cache',test:{maxWorkers:1,testTimeout:300000,hookTimeout:60000}};\n",
  );
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "host",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--add-host",
      `${completionHost}:${serviceAddress("tool-completion")}`,
      ...kafkaServices.flatMap((name) => ["--add-host", `${name}:${serviceAddress(name)}`]),
      "--mount",
      `type=bind,src=${repositoryRoot},dst=${repositoryRoot},readonly`,
      "--mount",
      `type=bind,src=${nodePrefix},dst=/opt/operator-node,readonly`,
      "--mount",
      `type=bind,src=${temporary},dst=/operator-test`,
      "--workdir",
      join(repositoryRoot, "packages/sandbox-control"),
      "--env",
      "PATH=/opt/operator-node/bin:/usr/local/bin:/usr/bin:/bin",
      ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      build.buildImages.ubuntu24,
      "/opt/operator-node/bin/node",
      join(repositoryRoot, "node_modules/vitest/vitest.mjs"),
      "run",
      ...liveFiles,
      "--no-file-parallelism",
      "--config",
      "/operator-test/vitest.mjs",
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`CubeSandbox Provider live gate failed (${code})`)),
    );
  });
} finally {
  let cleaned = false;
  try {
    await cleanupBusinessFixtures();
    cleaned = true;
    console.log(JSON.stringify({ nativeFixtureCleanup: true, tenants: owned.length }));
  } finally {
    await businessDb?.destroy();
    await testDatabase.close();
    if (cleaned) await rm(temporary, { recursive: true, force: true });
    else
      console.error(
        `Owned resource receipt retained at ${ownershipPath}; no ownership records discarded`,
      );
  }
}
