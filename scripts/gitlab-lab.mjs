import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const runtime = resolve(root, "deploy/gitlab/runtime");
const compose = resolve(root, "deploy/gitlab/compose.yaml");
const command = process.argv[2] ?? "up";
const environment = { ...process.env, PI_CLOUD_GITLAB_RUNTIME_DIRECTORY: runtime };

async function initialize() {
  await mkdir(resolve(runtime, "secrets"), { recursive: true, mode: 0o700 });
  await Promise.all(
    ["config", "logs", "data"].map((directory) =>
      mkdir(resolve(runtime, directory), { recursive: true, mode: 0o700 }),
    ),
  );
  const passwordPath = resolve(runtime, "secrets/root-password");
  try {
    const existing = (await readFile(passwordPath, "utf8")).trim();
    if (existing.length < 16 || existing.length > 128) throw new Error("invalid password");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(passwordPath, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
  }
  await chmod(passwordPath, 0o600);
}

function dockerCompose(args) {
  const result = spawnSync("docker", ["compose", "--file", compose, ...args], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function dockerComposeCapture(args) {
  const result = spawnSync("docker", ["compose", "--file", compose, ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function connectPiCloudNetwork() {
  const network = "pi-cloud-production_model-egress";
  const inspected = spawnSync("docker", ["network", "inspect", network], {
    cwd: root,
    env: environment,
    stdio: "ignore",
  });
  if (inspected.status !== 0) return;
  const connected = spawnSync(
    "docker",
    [
      "network",
      "connect",
      "--alias",
      "gitlab.localhost",
      "--alias",
      "gitlab.internal",
      network,
      "pi-cloud-gitlab-gitlab-1",
    ],
    { cwd: root, env: environment, encoding: "utf8" },
  );
  if (
    connected.status !== 0 &&
    !`${connected.stdout}${connected.stderr}`.includes("already exists")
  ) {
    process.stderr.write(connected.stderr);
    process.exit(connected.status ?? 1);
  }
}

async function configureLocalWebhookDelivery() {
  const marker = resolve(runtime, "secrets/local-webhook-delivery-v1");
  try {
    if ((await readFile(marker, "utf8")).trim() === "configured") return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  dockerComposeCapture([
    "exec",
    "--no-TTY",
    "gitlab",
    "gitlab-rails",
    "runner",
    "-e",
    "production",
    "setting = ApplicationSetting.current; setting.update!(allow_local_requests_from_web_hooks_and_services: true); puts 'configured'",
  ]);
  await writeFile(marker, "configured\n", { mode: 0o600, flag: "wx" });
}

if (command === "init") {
  await initialize();
  process.stdout.write(`${JSON.stringify({ initialized: true, runtime })}\n`);
} else if (command === "password") {
  await initialize();
  process.stdout.write(await readFile(resolve(runtime, "secrets/root-password"), "utf8"));
} else {
  await initialize();
  const argumentsByCommand = {
    up: ["up", "--detach", "--wait"],
    down: ["down"],
    ps: ["ps"],
    logs: ["logs", "--follow"],
  };
  const args = argumentsByCommand[command];
  if (args === undefined) throw new Error(`Unsupported GitLab command: ${command}`);
  dockerCompose(args);
  if (command === "up") {
    await configureLocalWebhookDelivery();
    connectPiCloudNetwork();
  }
}
