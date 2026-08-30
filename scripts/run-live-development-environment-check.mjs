import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import ssh2 from "ssh2";
import {
  OfficialCubeSandboxRuntimeClient,
  workspaceVolumeId,
} from "../packages/tool-broker/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.PI_CLOUD_LIVE_DEVELOPMENT_ENVIRONMENT_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_DEVELOPMENT_ENVIRONMENT_CHECK=1 to acknowledge real Cube/model usage",
  );
}
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);

async function readPrivate(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > maximumBytes) {
      throw new Error(`${label} is not a private bounded file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

const environment = Object.fromEntries(
  (await readPrivate(resolve(runtimeDirectory, ".env"), 64 * 1_024, "Production environment"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
const bootstrapTenantId = environment.PI_CLOUD_TENANT_ID;
if (bindAddress === undefined || port === undefined || bootstrapTenantId === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const token = (
  await readPrivate(resolve(runtimeDirectory, "secrets/api-token"), 4_096, "Production API token")
).trim();
const fetchFromProduction = async (input, init = {}) => {
  const request = new URL(String(input), baseUrl);
  const response = await fetch(request, { ...init, redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || location === null) return response;
  const target = new URL(location, request);
  if (!target.hostname.endsWith(".preview.localhost")) return response;
  return new Promise((resolvePromise, rejectPromise) => {
    const forwarded = httpRequest(
      {
        hostname: connectHost,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: { ...Object.fromEntries(new Headers(init.headers)), host: target.host },
        signal: init.signal,
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.once("end", () =>
          resolvePromise(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              headers: incoming.headers,
            }),
          ),
        );
      },
    );
    forwarded.once("error", rejectPromise);
    forwarded.end();
  });
};
const api = new PiCloudApi(fetchFromProduction, token);

const databaseUrl = new URL(
  (
    await readPrivate(
      resolve(runtimeDirectory, "secrets/database-url"),
      4_096,
      "Production database URL",
    )
  ).trim(),
);
const databaseUser = decodeURIComponent(databaseUrl.username);
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));

function capture(command, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 4 * 1_024 * 1_024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(stderr.trim().slice(-2_000) || error.message));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function psql(query) {
  return capture(process.execPath, [
    "scripts/production-compose.mjs",
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username",
    databaseUser,
    "--dbname",
    databaseName,
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
}

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function shellEnvelope(command) {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return `printf '%s' '${encoded}' | base64 -d | /bin/bash`;
}

async function waitForRun(runId) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(`Run ${runId} ended as ${run.state}: ${JSON.stringify(run.failure)}`);
    }
    await wait(100);
  }
  throw new Error(`Run ${runId} did not settle`);
}

async function waitForEnvironment(environmentId, expectedState) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const current = (await api.listDevelopmentEnvironments()).environments.find(
      (environment) => environment.environmentId === environmentId,
    );
    if (current?.state === expectedState) return current;
    if (current?.state === "failed" || current?.state === "unknown") {
      throw new Error(
        `Development environment ${environmentId} ended as ${current.state}: ${current.failureCode ?? "unknown"}`,
      );
    }
    await wait(250);
  }
  throw new Error(`Development environment ${environmentId} did not reach ${expectedState}`);
}

async function waitForWorkspacePurge(workspaceId) {
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    const state = await psql(
      `select case
          when deleted_at is null then 'attached'
          when storage_purged_at is null then 'pending'
          else 'purged'
        end
       from workspaces
       where id = ${sqlLiteral(workspaceId)}`,
    );
    if (state === "purged") return;
    await wait(250);
  }
  throw new Error(`Development machine Workspace ${workspaceId} was not purged`);
}

async function waitForToolBrokerReady() {
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    try {
      await capture(process.execPath, [
        "scripts/production-compose.mjs",
        "exec",
        "-T",
        "tool-broker",
        "node",
        "-e",
        "fetch('http://127.0.0.1:4300/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ]);
      return;
    } catch {
      await wait(250);
    }
  }
  throw new Error("Tool Broker did not become ready after restart");
}

async function terminalCommand(path, command, marker) {
  const target = new URL(path, baseUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(target, { headers: { authorization: `Bearer ${token}` } });
  let output = "";
  let ready = false;
  let finished = false;
  let closing = false;
  const deadline = Date.now() + 120_000;
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setInterval(() => {
      if (Date.now() < deadline) return;
      clearInterval(timeout);
      socket.terminate();
      rejectPromise(new Error(`Terminal did not produce ${marker}: ${output.slice(-2_000)}`));
    }, 250);
    const finish = () => {
      if (finished || closing) return;
      closing = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.close",
          }),
        );
      }
    };
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type === "workspace_terminal.ready" && !ready) {
        ready = true;
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.input",
            data: Buffer.from(`${shellEnvelope(command)}\n`, "utf8").toString("base64"),
          }),
        );
      } else if (frame.type === "workspace_terminal.output") {
        output += Buffer.from(frame.data, "base64").toString("utf8");
        if (output.includes(marker)) finish();
      } else if (frame.type === "workspace_terminal.error") {
        clearInterval(timeout);
        rejectPromise(new Error(`${frame.code}: ${frame.message}`));
      }
    });
    socket.once("error", (error) => {
      clearInterval(timeout);
      rejectPromise(error);
    });
    socket.once("close", () => {
      if (!closing || finished) return;
      finished = true;
      clearInterval(timeout);
      resolvePromise(output);
    });
  });
}

async function sshCommand(ticket, command, marker) {
  const client = new ssh2.Client();
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      client.destroy();
      rejectPromise(new Error(`SSH did not produce ${marker}`));
    }, 60_000);
    client.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    client.once("ready", () => {
      client.shell({ rows: 24, cols: 100 }, (error, channel) => {
        if (error) {
          clearTimeout(timeout);
          rejectPromise(error);
          return;
        }
        let output = "";
        channel.on("data", (chunk) => {
          output += chunk.toString("utf8");
        });
        channel.stderr.on("data", (chunk) => {
          output += chunk.toString("utf8");
        });
        channel.once("close", () => {
          clearTimeout(timeout);
          client.end();
          if (output.includes(marker)) resolvePromise(output);
          else rejectPromise(new Error(`SSH output omitted ${marker}: ${output.slice(-2_000)}`));
        });
        channel.end(`${shellEnvelope(command)}\nexit\n`);
      });
    });
    client.connect({
      host: ticket.host,
      port: ticket.port,
      username: ticket.username,
      password: ticket.password,
      hostVerifier: () => true,
      readyTimeout: 10_000,
    });
  });
}

const cluster = JSON.parse(
  await readPrivate(
    resolve(runtimeDirectory, "cubesandbox/cluster.json"),
    64 * 1_024,
    "Cube cluster evidence",
  ),
);
const cubeApiKey = (
  await readPrivate(resolve(runtimeDirectory, "secrets/cubesandbox-api-key"), 4_096, "Cube API key")
).trim();
const cube = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${String(cluster.api.port)}`,
  apiKey: cubeApiKey,
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: environment.PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
  requestTimeoutMs: 60_000,
});

const suffix = Date.now().toString(36);
const previewPort = 5_173;
const development = await api.createDevelopmentEnvironment(
  `Recovery machine ${suffix}`,
  "standard",
  newIdempotencyKey("environment"),
);
await waitForEnvironment(development.environmentId, "running");
const runtimeName = await psql(
  `select runtime_name from development_environments where id = ${sqlLiteral(development.environmentId)}`,
);
assert(runtimeName, "Development environment did not persist its Cube identity");
await terminalCommand(
  `/v1/development-environments/${development.environmentId}/terminal`,
  `test "$(id -u)" = 0; test ! -e /workspace; printf 'EXCLUSIVE_ROOTFS_OK\\n' > /etc/pi-cloud-exclusive-marker; mkdir -p /home/user/empty-project/src; printf 'public final class Calculator { public static int add(int left, int right) { return left - right; } }\\n' > /home/user/empty-project/src/Calculator.java; printf '#!/usr/bin/env bash\\nset -eu\\ngrep -F "return left + right;" src/Calculator.java\\n' > /home/user/empty-project/test.sh; chmod 0755 /home/user/empty-project/test.sh; chown -R 1000:1000 /home/user; printf 'EXCLUSIVE_FILE_OK\\n' > /home/user/exclusive.txt; printf '<!doctype html><html><head><title>PiCloud Preview</title></head><body>PI_CLOUD_PREVIEW_OK</body></html>\\n' > /home/user/index.html; setsid sh -c 'while true; do date +%s > /var/tmp/pi-cloud-exclusive-heartbeat; sleep 1; done' </dev/null >/tmp/exclusive-loop.log 2>&1 & echo $! > /var/tmp/pi-cloud-exclusive.pid; setsid python3 -m http.server ${String(previewPort)} --bind 0.0.0.0 --directory /home/user </dev/null >/tmp/preview.log 2>&1 & echo EXCLUSIVE_FIRST_OK`,
  "EXCLUSIVE_FIRST_OK",
);
const rootDirectory = await api.listDevelopmentEnvironmentDirectory(development.environmentId, "/");
assert(rootDirectory.entries.some((entry) => entry.name === "etc" && entry.kind === "directory"));
const homeDirectory = await api.listDevelopmentEnvironmentDirectory(
  development.environmentId,
  "/home/user",
);
assert(
  homeDirectory.entries.some(
    (entry) => entry.name === "empty-project" && entry.kind === "directory",
  ),
);
await wait(2_000);
const preview = await fetchFromProduction(
  `/v1/development-environments/${development.environmentId}/preview/${String(previewPort)}/`,
  { headers: { authorization: `Bearer ${token}`, accept: "text/html" } },
);
assert.equal(preview.status, 200);
assert.match(await preview.text(), /PI_CLOUD_PREVIEW_OK/);
await terminalCommand(
  `/v1/development-environments/${development.environmentId}/terminal`,
  'test "$(cat /etc/pi-cloud-exclusive-marker)" = EXCLUSIVE_ROOTFS_OK && test "$(cat /home/user/exclusive.txt)" = EXCLUSIVE_FILE_OK && test ! -e /workspace && kill -0 "$(cat /var/tmp/pi-cloud-exclusive.pid)" && echo EXCLUSIVE_RECONNECT_OK',
  "EXCLUSIVE_RECONNECT_OK",
);

const session = await api.createSession(
  development.projectId,
  development.workspaceId,
  `Agent binding to exclusive environment ${suffix}`,
  "development_environment",
  "standard",
  "/home/user/empty-project",
);
const agentRun = await api.acceptTurn(
  session.sessionId,
  "Fix the pre-seeded Calculator implementation and run its test script.",
  newIdempotencyKey("turn"),
  "off",
);
await waitForRun(agentRun.runId);
const continuityRun = await api.acceptTurn(
  session.sessionId,
  "Verify the repaired Calculator again without changing it.",
  newIdempotencyKey("turn"),
  "off",
);
await waitForRun(continuityRun.runId);
const discoveredPreviewResponse = await fetchFromProduction(
  `/v1/conversations/${session.sessionId}/preview/${String(previewPort)}/`,
  { headers: { authorization: `Bearer ${token}`, accept: "text/html" } },
);
assert.equal(discoveredPreviewResponse.status, 200);
assert.match(await discoveredPreviewResponse.text(), /PI_CLOUD_PREVIEW_OK/);
assert.equal(
  await psql(
    `select count(*)
       from pi_session_entries
      where tenant_id = ${sqlLiteral(bootstrapTenantId)}
        and session_id = ${sqlLiteral(session.sessionId)}
        and custom_type = 'pi-cloud.sandbox_reset'`,
  ),
  "0",
  "A renewed Agent Tool lease incorrectly reported a physical Sandbox reset",
);
assert.equal(
  await psql(
    `select runtime_name from development_environments where id = ${sqlLiteral(development.environmentId)}`,
  ),
  runtimeName,
);
assert.equal(
  await psql(
    `select state || ':' || coalesce(agent_activation_id::text, 'idle') from development_environments where id = ${sqlLiteral(development.environmentId)}`,
  ),
  "running:idle",
);
await terminalCommand(
  `/v1/conversations/${session.sessionId}/terminal`,
  'grep -F "return left + right;" /home/user/empty-project/src/Calculator.java >/dev/null && (cd /home/user/empty-project && bash ./test.sh) && kill -0 "$(cat /var/tmp/pi-cloud-exclusive.pid)" && echo EXCLUSIVE_AGENT_RETURN_OK',
  "EXCLUSIVE_AGENT_RETURN_OK",
);
const sshTicket = await api.issueSshAccessTicket(session.sessionId);
await sshCommand(
  sshTicket,
  'test "$(id -u)" = 0 && grep -F "return left + right;" /home/user/empty-project/src/Calculator.java >/dev/null && echo EXCLUSIVE_SSH_OK',
  "EXCLUSIVE_SSH_OK",
);

await capture(
  process.execPath,
  ["scripts/production-compose.mjs", "restart", "tool-broker"],
  5 * 60_000,
);
await waitForToolBrokerReady();
const recoveredAfterBrokerRestart = await waitForEnvironment(development.environmentId, "running");
assert.equal(
  await psql(
    `select runtime_name from development_environments where id = ${sqlLiteral(development.environmentId)}`,
  ),
  runtimeName,
);
assert.equal((await cube.read(runtimeName))?.state, "running");
await terminalCommand(
  `/v1/development-environments/${development.environmentId}/terminal`,
  'test "$(cat /etc/pi-cloud-exclusive-marker)" = EXCLUSIVE_ROOTFS_OK && kill -0 "$(cat /var/tmp/pi-cloud-exclusive.pid)" && echo EXCLUSIVE_BROKER_RECOVERY_OK',
  "EXCLUSIVE_BROKER_RECOVERY_OK",
);
const previewAfterBrokerRestart = await fetchFromProduction(
  `/v1/development-environments/${development.environmentId}/preview/${String(previewPort)}/`,
  { headers: { authorization: `Bearer ${token}`, accept: "text/html" } },
);
assert.equal(previewAfterBrokerRestart.status, 200);
assert.match(await previewAfterBrokerRestart.text(), /PI_CLOUD_PREVIEW_OK/);
const sshAfterBrokerRestart = await api.issueSshAccessTicket(session.sessionId);
await sshCommand(
  sshAfterBrokerRestart,
  'kill -0 "$(cat /var/tmp/pi-cloud-exclusive.pid)" && echo EXCLUSIVE_BROKER_SSH_OK',
  "EXCLUSIVE_BROKER_SSH_OK",
);

const paused = await api.developmentEnvironmentAction(
  development.environmentId,
  "pause",
  newIdempotencyKey("environment"),
);
assert.equal(paused.state, "paused");
assert.equal((await cube.read(runtimeName))?.state, "paused");
const resumed = await api.developmentEnvironmentAction(
  development.environmentId,
  "resume",
  newIdempotencyKey("environment"),
);
assert.equal(resumed.state, "running");
assert.equal(
  await psql(
    `select runtime_name from development_environments where id = ${sqlLiteral(development.environmentId)}`,
  ),
  runtimeName,
);
await terminalCommand(
  `/v1/development-environments/${development.environmentId}/terminal`,
  'kill -0 "$(cat /var/tmp/pi-cloud-exclusive.pid)" && test "$(cat /etc/pi-cloud-exclusive-marker)" = EXCLUSIVE_ROOTFS_OK && echo EXCLUSIVE_RESUME_OK',
  "EXCLUSIVE_RESUME_OK",
);

await api.deleteConversation(session.sessionId, newIdempotencyKey("delete-conversation"));
const replacementSession = await api.createSession(
  development.projectId,
  development.workspaceId,
  `Replacement conversation ${suffix}`,
  "development_environment",
  "standard",
  "/home/user/empty-project",
);
assert.equal(
  (await api.getConversation(replacementSession.sessionId)).session.sessionId,
  replacementSession.sessionId,
);

const released = await api.developmentEnvironmentAction(
  development.environmentId,
  "release",
  newIdempotencyKey("environment"),
);
assert.equal(released.state, "released");
assert.equal(await cube.read(runtimeName), undefined);
assert(
  !(await api.listWorkspaces()).workspaces.some(
    (workspace) => workspace.workspaceId === development.workspaceId,
  ),
  "Released machine Volume leaked into the elastic Workspace inventory",
);
assert.equal(
  (await api.getConversation(replacementSession.sessionId)).session.workspaceState,
  "missing",
);
await waitForWorkspacePurge(development.workspaceId);
const deletedVolume = await fetch(
  `http://${cluster.api.host}:${String(cluster.api.port)}/volumes/${workspaceVolumeId({ tenantId: bootstrapTenantId, workspaceId: development.workspaceId })}`,
  { headers: { authorization: `Bearer ${cubeApiKey}` }, signal: AbortSignal.timeout(30_000) },
);
await deletedVolume.body?.cancel();
await api.deleteConversation(
  replacementSession.sessionId,
  newIdempotencyKey("delete-replacement-conversation"),
);
assert.equal(deletedVolume.status, 404, "Released machine retained Cube Volume metadata");

const report = {
  accepted: true,
  piCloudRevision: await capture("git", ["rev-parse", "HEAD"]),
  checkedAt: new Date().toISOString(),
  developmentEnvironmentId: development.environmentId,
  workspaceId: development.workspaceId,
  ipAddress: (await api.listDevelopmentEnvironments()).environments.find(
    (environment) => environment.environmentId === development.environmentId,
  )?.ipAddress,
  cubeIdentityStableAcrossPause: true,
  processSurvivedTerminalReconnect: true,
  processSurvivedPauseResume: true,
  agentRunBorrowedAndReturnedSameCube: true,
  consecutiveAgentRunsPreservedPhysicalContinuity: true,
  machineVolumeDeletedOnRelease: true,
  cubeVolumeMetadataDeleted: true,
  conversationSurvivedRelease: true,
  releasedWorkspaceRequiresRebind: true,
  authenticatedHttpPreviewPassed: true,
  structuredServiceDiscoveryPassed: true,
  previewPort,
  rootFilesystemPreserved: true,
  elasticWorkspaceRootAbsent: true,
  brokerRestartKeptMachineRunning: recoveredAfterBrokerRestart.state === "running",
  emptyDirectoryBrowsePassed: true,
  archivedSessionDidNotReleaseMachine: true,
  oneTimeSshGatewayPassed: true,
  selectedProfile: development.profileKey,
};
await cube.close();
await mkdir(resolve(repositoryRoot, "docs/reports"), { recursive: true });
await writeFile(
  resolve(repositoryRoot, "docs/reports/development-environment-acceptance-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(report)}\n`);
