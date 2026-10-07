import { serviceAddress } from "./lib/production-kubernetes.mjs";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { testPostgres } from "./lib/test-postgres.mjs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
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
const environment = {
  PI_CLOUD_POSTGRES_INTEGRATION_URL: testDatabase.url,
  PI_CLOUD_CUBESANDBOX_TEST: "1",
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
      "test/cubesandbox-live-provider.integration.test.ts",
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
  await testDatabase.close();
  await rm(temporary, { recursive: true, force: true });
}
