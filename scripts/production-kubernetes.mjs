import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import {
  repositoryRoot,
  runtimeDirectory,
  runtimeEnvironment,
  kubectl,
  kubectlAsync,
  kubeconfig,
  namespace,
  workload,
  workloads,
  podFor,
  execIn,
  runtimeImages,
} from "./lib/production-kubernetes.mjs";
import { selfHostedValues } from "./lib/self-hosted-values.mjs";
import { validateProductionRuntimeEnvironment } from "./production-runtime-policy.mjs";
import { guestBuildIdentity } from "./lib/guest-build-identity.mjs";

const [action, ...args] = process.argv.slice(2);
const environment = { ...runtimeEnvironment(), ...process.env };
const directory = resolve(runtimeDirectory, "k3s");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";
function run(command, argv, options = {}) {
  return execFileSync(command, argv, { cwd: repositoryRoot, stdio: "inherit", ...options });
}
function helmRun(argv) {
  run(helm, [...argv, "--kubeconfig", kubeconfig]);
}
async function values() {
  validateProductionRuntimeEnvironment(environment);
  const cluster = JSON.parse(readFileSync(resolve(runtimeDirectory, "cubesandbox/cluster.json")));
  const template = JSON.parse(readFileSync(resolve(runtimeDirectory, "cubesandbox/template.json")));
  if (template.imageRevision !== (await guestBuildIdentity(repositoryRoot))) {
    throw new Error(
      "Register an immutable Cube template matching the current guest build inputs before deployment",
    );
  }
  const config = selfHostedValues({
    environment,
    runtime: runtimeDirectory,
    cluster,
    template,
    images: runtimeImages(),
  });
  for (const key of ["infrastructure", "platform"]) {
    const path = resolve(directory, `${key}.yaml`);
    writeFileSync(path, stringify(config[key]), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return config;
}
function chart(key) {
  return resolve(repositoryRoot, `deploy/helm/pi-cloud-${key}`);
}
function flags(key) {
  return ["-f", resolve(directory, `${key}.yaml`), "--namespace", namespace];
}
async function build() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const version =
    process.env.PI_CLOUD_BUILD_TAG ?? `k3s-${revision.slice(0, 12)}-${Date.now().toString(36)}`;
  const definitions = {
    controlPlane: ["control-plane", "packages/control-plane/Dockerfile"],
    worker: ["supervisor-host", "packages/supervisor-host/Dockerfile"],
    web: ["web-ui", "packages/web-ui/Dockerfile"],
    volumeGateway: [
      "workspace-volume-gateway",
      "packages/sandbox-control/Dockerfile.volume-gateway",
    ],
    sshGateway: ["ssh-gateway", "packages/ssh-gateway/Dockerfile"],
    relay: ["provider-egress-relay", "packages/provider-egress-relay/Dockerfile"],
    provider: ["cli-proxy-api", "deploy/provider-gateway/Dockerfile"],
  };
  const images = {};
  for (const [key, [name, file]] of Object.entries(definitions)) {
    images[key] = `pi-cloud/${name}:${version}`;
    run(
      "docker",
      [
        "build",
        "--network=host",
        "-f",
        file,
        "-t",
        images[key],
        "--build-arg",
        `PI_CLOUD_REVISION=${revision}`,
        "--build-arg",
        `PI_CLOUD_VERSION=${version}`,
        "--build-arg",
        `NPM_CONFIG_REGISTRY=${environment.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org"}`,
        "--build-arg",
        "HTTP_PROXY",
        "--build-arg",
        "HTTPS_PROXY",
        ".",
      ],
      { env: environment },
    );
  }
  writeFileSync(resolve(directory, "images.json"), JSON.stringify(images, null, 2) + "\n", {
    mode: 0o600,
  });
}
async function importImages() {
  const images = runtimeImages();
  const { parse } = await import("yaml");
  const pinned = parse(readFileSync(resolve(chart("infrastructure"), "values.yaml"), "utf8"));
  const aliases = [];
  for (const [name, image] of [
    ["postgres", pinned.postgres.image],
    ["kafka", pinned.kafka.image],
    ["session-images", pinned.sessionImages.image],
    ...(environment.PI_CLOUD_OBSERVABILITY_ENABLED === "1"
      ? Object.entries(pinned.observability.images)
      : []),
  ]) {
    try {
      execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    } catch {
      run("docker", ["pull", image]);
    }
    const alias = `pi-cloud/import-${name}:${image.split("sha256:")[1].slice(0, 16)}`;
    run("docker", ["tag", image, alias]);
    aliases.push({ alias, image });
  }
  await new Promise((ok, fail) => {
    const save = spawn(
      "docker",
      ["save", ...Object.values(images), ...aliases.map((x) => x.alias)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const load = spawn("/usr/local/bin/k3s", ["ctr", "images", "import", "-"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    save.stdout.pipe(load.stdin);
    save.on("error", fail);
    load.on("error", fail);
    Promise.all([
      new Promise((r, j) =>
        save.on("exit", (c) => (c === 0 ? r() : j(new Error("docker save failed")))),
      ),
      new Promise((r, j) =>
        load.on("exit", (c) => (c === 0 ? r() : j(new Error("K3s image import failed")))),
      ),
    ]).then(ok, fail);
  });
  for (const { alias, image } of aliases) {
    const [repository, digest] = image.split("@");
    const name = repository.replace(/:[^/]+$/, "");
    const canonical = `docker.io/${name.includes("/") ? name : `library/${name}`}@${digest}`;
    run("/usr/local/bin/k3s", ["ctr", "images", "tag", "--force", `docker.io/${alias}`, canonical]);
  }
}
function installSecrets() {
  const data = {};
  const names = [
    "grafana-admin-password",
    "postgres-password",
    "database-url",
    "api-token",
    "cli-proxy-api-key",
    "supervisor-enrollment-token",
    "supervisor-management-token",
    "sandbox-control-token",
    "workspace-service-token",
    "workspace-terminal-token",
    "metrics-token",
    "cube-egress-config-token",
    "cube-persistent-state-key",
    "workspace-volume-gateway-token",
    "cubesandbox-api-key",
    "ssh-host-key.pem",
    "session-image-s3-credentials.json",
    "session-image-s3-server.json",
    "source-control-credential-master-key",
  ];
  if (environment.PI_CLOUD_GITHUB_APP_ID)
    names.push("github-app-private-key.pem", "github-webhook-secret");
  for (const name of names)
    data[name] = readFileSync(resolve(runtimeDirectory, "secrets", name)).toString("base64");
  data["database-notification-url"] = data["database-url"];
  kubectl(["apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "pi-cloud-platform-secrets", namespace },
      type: "Opaque",
      data,
    }),
    stdio: ["pipe", "inherit", "inherit"],
  });
}
async function deploy() {
  const { platform } = await values();
  installSecrets();
  if (environment.PI_CLOUD_OBSERVABILITY_ENABLED === "1") {
    const files = {
      "prometheus.yml": "prometheus.yml",
      "alerts.yml": "alerts/pi-cloud.yml",
      "alertmanager.yml": "alertmanager.yml",
      "datasources.yml": "grafana/provisioning/datasources/pi-cloud.yml",
      "dashboards.yml": "grafana/provisioning/dashboards/pi-cloud.yml",
      "platform.json": "grafana/dashboards/platform.json",
    };
    const data = Object.fromEntries(
      Object.entries(files).map(([key, path]) => [
        key,
        readFileSync(resolve(repositoryRoot, "deploy/observability", path), "utf8"),
      ]),
    );
    kubectl(["apply", "-f", "-"], {
      input: JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "pi-cloud-observability", namespace },
        data,
      }),
      stdio: ["pipe", "inherit", "inherit"],
    });
  }

  kubectl(["label", "namespace", namespace, "pi-cloud.io/trusted-plane=true", "--overwrite"], {
    stdio: "inherit",
  });
  helmRun([
    "upgrade",
    "--install",
    "pi-cloud-infrastructure",
    chart("infrastructure"),
    ...flags("infrastructure"),
    "--wait",
    "--timeout",
    "10m",
  ]);
  execIn(
    "session-images",
    [
      "/bin/sh",
      "-eu",
      "-c",
      readFileSync(resolve(repositoryRoot, "deploy/session-images/initialize.sh"), "utf8"),
    ],
    { stdio: "inherit" },
  );
  run(helm, ["dependency", "build", chart("platform")]);
  run(process.execPath, ["scripts/configure-cube-completion.mjs"]);
  helmRun([
    "upgrade",
    "--install",
    "pi-cloud",
    chart("platform"),
    ...flags("platform"),
    "--wait",
    "--timeout",
    "15m",
  ]);
  const endpoint = JSON.parse(kubectl(["get", "service", "control-plane", "-o", "json"])).spec
    .clusterIP;
  const token = readFileSync(
    resolve(runtimeDirectory, "secrets/supervisor-management-token"),
    "utf8",
  ).trim();
  const deadline = Date.now() + 60000;
  let available = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://${endpoint}:3000/internal/v1/session-publication/health`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) },
      );
      const health = await response.json();
      if (response.ok && health.partitions?.length === platform.global.kafka.partitions) {
        available = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!available)
    throw new Error("Pods started but all publication partitions did not become available");
  process.stdout.write(`PiCloud is ready at ${platform.controlPlane.publicOriginBaseUrl}\n`);
}
if (action === "build") await build();
else if (action === "import-images") await importImages();
else if (action === "config" || action === "render") {
  await values();
  run(helm, ["dependency", "build", chart("platform")]);
  for (const key of ["infrastructure", "platform"]) {
    const output = execFileSync(
      helm,
      [
        "template",
        key === "platform" ? "pi-cloud" : "pi-cloud-infrastructure",
        chart(key),
        ...flags(key),
      ],
      { encoding: "utf8" },
    );
    writeFileSync(resolve(directory, `${key}-rendered.yaml`), output, { mode: 0o600 });
  }
  process.stdout.write(
    "Kubernetes manifests validated; private rendered files are in runtime/k3s\n",
  );
} else if (action === "deploy") await deploy();
else if (action === "down") {
  helmRun(["uninstall", "pi-cloud", "--namespace", namespace, "--wait", "--timeout", "25m"]);
  helmRun([
    "uninstall",
    "pi-cloud-infrastructure",
    "--namespace",
    namespace,
    "--wait",
    "--timeout",
    "5m",
  ]);
} else if (action === "status") await kubectlAsync(["get", "pods,svc,pvc", "-o", "wide"]);
else if (action === "logs")
  await kubectlAsync(["logs", "--follow", workload(args[0] ?? "control-plane"), "--tail=100"]);
else if (action === "exec")
  await kubectlAsync([
    "exec",
    "-i",
    podFor(args[0]),
    "--",
    ...args.slice(1).filter((x, i) => !(i === 0 && x === "--")),
  ]);
else if (action === "restart") {
  const target = workload(args[0]);
  if (target.startsWith("pod/")) await kubectlAsync(["delete", target]);
  else {
    await kubectlAsync(["rollout", "restart", target]);
    await kubectlAsync(["rollout", "status", target, "--timeout=15m"]);
  }
} else if (action === "stop" || action === "start") {
  const target = workload(args[0]);
  if (target.startsWith("pod/"))
    throw new Error(
      "Scale the Worker pool explicitly; individual Pods are reconciled automatically",
    );
  await kubectlAsync([
    "scale",
    target,
    `--replicas=${action === "stop" ? 0 : args[0] === "pi-workers" ? 2 : 1}`,
  ]);
} else
  throw new Error(
    "Usage: production-kubernetes.mjs build|import-images|config|deploy|status|logs [service]|exec service -- command|restart service|stop service|start service",
  );
