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

async function configureOauth() {
  await initialize();
  const clientIdPath = resolve(runtime, "secrets/oauth-client-id");
  const clientSecretPath = resolve(runtime, "secrets/oauth-client-secret");
  let clientId;
  let clientSecret;
  try {
    [clientId, clientSecret] = await Promise.all([
      readFile(clientIdPath, "utf8"),
      readFile(clientSecretPath, "utf8"),
    ]);
    clientId = clientId.trim();
    clientSecret = clientSecret.trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const ruby = [
      "require 'json'",
      "name = 'PiCloud local acceptance'",
      "Doorkeeper::Application.where(name: name).destroy_all",
      "organization = Organizations::Organization.default_organization",
      "raise 'default GitLab organization is unavailable' unless organization",
      "redirects = ['http://127.0.0.1:8080/v1/auth/oidc/gitlab/callback', 'http://127.0.0.1:8080/v1/source-control/gitlab/authorization/callback'].join(\"\\n\")",
      "app = Doorkeeper::Application.create!(name: name, redirect_uri: redirects, scopes: 'openid profile email read_user api read_repository write_repository', confidential: true, trusted: false, organization_id: organization.id)",
      "puts({client_id: app.uid, client_secret: app.plaintext_secret}.to_json)",
    ].join("; ");
    const output = dockerComposeCapture([
      "exec",
      "--no-TTY",
      "gitlab",
      "gitlab-rails",
      "runner",
      "-e",
      "production",
      ruby,
    ]);
    const line = output
      .trim()
      .split("\n")
      .reverse()
      .find((candidate) => candidate.startsWith("{"));
    if (line === undefined) throw new Error("GitLab OAuth application did not return credentials");
    const parsed = JSON.parse(line);
    if (
      typeof parsed.client_id !== "string" ||
      parsed.client_id.length < 16 ||
      typeof parsed.client_secret !== "string" ||
      parsed.client_secret.length < 16
    ) {
      throw new Error("GitLab OAuth application returned invalid credentials");
    }
    clientId = parsed.client_id;
    clientSecret = parsed.client_secret;
    await Promise.all([
      writeFile(clientIdPath, `${clientId}\n`, { mode: 0o600, flag: "wx" }),
      writeFile(clientSecretPath, `${clientSecret}\n`, { mode: 0o600, flag: "wx" }),
    ]);
  }
  const reconcile = [
    `app = Doorkeeper::Application.find_by!(uid: '${clientId}')`,
    "app.update!(redirect_uri: ['http://127.0.0.1:8080/v1/auth/oidc/gitlab/callback', 'http://127.0.0.1:8080/v1/source-control/gitlab/authorization/callback'].join(\"\\n\"), scopes: 'openid profile email read_user api read_repository write_repository')",
  ].join("; ");
  dockerComposeCapture([
    "exec",
    "--no-TTY",
    "gitlab",
    "gitlab-rails",
    "runner",
    "-e",
    "production",
    reconcile,
  ]);
  process.stdout.write(
    [
      "PI_CLOUD_GITLAB_ENABLED=true",
      "PI_CLOUD_GITLAB_WEBHOOK_URL=http://control-plane.internal:3000/v1/source-control/gitlab/webhook",
      "PI_CLOUD_GITLAB_INTERNAL_BASE_URL=http://gitlab.internal:8929",
      "PI_CLOUD_OIDC_GITLAB_ENABLED=true",
      "PI_CLOUD_OIDC_GITLAB_ISSUER=http://gitlab.localhost:8929",
      `PI_CLOUD_OIDC_GITLAB_CLIENT_ID=${clientId}`,
      `PI_CLOUD_OIDC_GITLAB_CLIENT_SECRET_PATH=${clientSecretPath}`,
    ].join("\n") + "\n",
  );
}

if (command === "init") {
  await initialize();
  process.stdout.write(`${JSON.stringify({ initialized: true, runtime })}\n`);
} else if (command === "password") {
  await initialize();
  process.stdout.write(await readFile(resolve(runtime, "secrets/root-password"), "utf8"));
} else if (command === "oauth") {
  await configureOauth();
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
