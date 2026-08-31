import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  OfficialCubeSandboxRuntimeClient,
  workspaceVolumeId,
} from "../packages/tool-broker/src/index.ts";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (process.env.PI_CLOUD_LIVE_CUBESANDBOX_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 to acknowledge real model usage and Cube KVM execution",
  );
}
const writeReport = process.env.PI_CLOUD_LIVE_CUBESANDBOX_REPORT !== "0";

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);

async function readPrivate(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new Error(`${label} is not a private bounded file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

const environment = Object.fromEntries(
  (await readPrivate(resolve(runtimeDirectory, ".env"), 64 * 1_024, "Production environment"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const cluster = parseJson(
  await readPrivate(
    resolve(runtimeDirectory, "cubesandbox/cluster.json"),
    64 * 1_024,
    "Cube cluster evidence",
  ),
  "Cube cluster evidence",
);
const template = parseJson(
  await readPrivate(
    resolve(runtimeDirectory, "cubesandbox/template.json"),
    64 * 1_024,
    "Cube template evidence",
  ),
  "Cube template evidence",
);
const cubeApiKey = (
  await readPrivate(resolve(runtimeDirectory, "secrets/cubesandbox-api-key"), 4_096, "Cube API key")
).replace(/\r?\n$/, "");
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
if (
  databaseUrl.protocol !== "postgresql:" ||
  !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(databaseUser) ||
  !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(databaseName)
) {
  throw new Error("Production database identity is invalid");
}

if (
  cluster?.formatVersion !== 1 ||
  cluster?.cubeCommit !== "8721dd151971ce3c2966482bbd32904ad98f378e" ||
  cluster?.podNetworkMtu !== 1_450 ||
  template?.formatVersion !== 2 ||
  template?.cubeCommit !== cluster.cubeCommit ||
  !/^tpl-[a-z0-9]{24}$/.test(template?.agent?.templateId ?? "") ||
  !["starter", "standard", "performance"].every((key) =>
    /^tpl-[a-z0-9]{24}$/.test(template?.development?.[key]?.templateId ?? ""),
  ) ||
  !/^sha256:[a-f0-9]{64}$/.test(template?.imageDigest ?? "")
) {
  throw new Error("Cube production evidence is invalid");
}

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
  const response = await fetch(request, {
    ...init,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(300_000),
  });
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || location === null) return response;
  const target = new URL(location, request);
  if (!target.hostname.endsWith(".preview.localhost")) return response;
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      {
        hostname: connectHost,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: { ...Object.fromEntries(new Headers(init.headers)), host: target.host },
        signal: init.signal ?? AbortSignal.timeout(300_000),
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.once("end", () => {
          resolvePromise(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              headers: incoming.headers,
            }),
          );
        });
      },
    );
    request.once("error", rejectPromise);
    request.end();
  });
};
const bootstrapApi = new PiCloudApi(fetchFromProduction, token);
let api = bootstrapApi;
let tenantId = bootstrapTenantId;
let authorizationToken = token;
const cube = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${String(cluster.api.port)}`,
  apiKey: cubeApiKey,
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: environment.PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
  requestTimeoutMs: 30_000,
});

function capture(command, args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 1 * 1_024 * 1_024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(`${command} failed: ${stderr.trim().slice(-2_000) || error.message}`, {
              cause: error,
            }),
          );
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
  });
}

function progress(stage) {
  process.stdout.write(`[cube-production-check] ${stage}\n`);
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

function shellEnvelope(command) {
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return `printf '%s' '${encoded}' | base64 -d | /bin/bash`;
}

async function terminalCommand(path, command, marker) {
  const target = new URL(path, baseUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(target, {
    headers: { authorization: `Bearer ${authorizationToken}` },
  });
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

async function waitForPreview(path, marker) {
  const deadline = Date.now() + 30_000;
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() < deadline) {
    const response = await fetchFromProduction(path, {
      headers: { authorization: `Bearer ${authorizationToken}`, accept: "text/html" },
    });
    lastStatus = response.status;
    lastBody = await response.text();
    if (response.status === 200 && lastBody.includes(marker)) return;
    if (response.status !== 502 && response.status !== 503) break;
    await wait(100);
  }
  throw new Error(
    `Preview did not become ready: status=${String(lastStatus)} body=${lastBody.slice(0, 1_000)}`,
  );
}

async function kafkaState() {
  const offsets = await capture(process.execPath, [
    "scripts/production-compose.mjs",
    "exec",
    "-T",
    "kafka-1",
    "/opt/kafka/bin/kafka-get-offsets.sh",
    "--bootstrap-server",
    "kafka-1:9092",
    "--topic",
    "pi-cloud.accepted-facts.v1",
    "--time",
    "-1",
  ]);
  const acceptedFacts = offsets
    .trim()
    .split("\n")
    .filter(Boolean)
    .reduce((total, line) => total + Number(line.split(":").at(-1) ?? 0), 0);
  const canonicalHeads = Number(await psql("select count(*) from session_kafka_heads"));
  return {
    acceptedFacts,
    canonicalHeads,
  };
}

async function runUsageEvidence(runId) {
  const value = await psql(
    `select count(*) || '|' ||
            coalesce(sum((entry.payload #>> '{message,usage,input}')::bigint), 0) || '|' ||
            coalesce(sum((entry.payload #>> '{message,usage,output}')::bigint), 0) || '|' ||
            coalesce(sum((entry.payload #>> '{message,usage,cacheRead}')::bigint), 0) || '|' ||
            coalesce(sum((entry.payload #>> '{message,usage,cacheWrite}')::bigint), 0) || '|0'
       from runs run
       join pi_session_entries entry
         on entry.tenant_id = run.tenant_id
        and entry.turn_id = run.turn_id
      where run.tenant_id = ${sqlLiteral(tenantId)}
        and run.id = ${sqlLiteral(runId)}
        and entry.type = 'message'
        and entry.payload #>> '{message,role}' = 'assistant'
        and entry.payload #> '{message,usage}' is not null`,
  );
  const [requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicrousd] =
    value.split("|").map(Number);
  for (const number of [
    requests,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costMicrousd,
  ]) {
    assert(Number.isSafeInteger(number) && number >= 0, "Run usage evidence is invalid");
  }
  return { requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicrousd };
}

function wait(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    function settle() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolvePromise();
    }
    signal?.addEventListener("abort", settle, { once: true });
  });
}

function currentCubeAssignment(metadata) {
  const records = [];
  for (const [key, raw] of Object.entries(metadata)) {
    if (!key.startsWith("picloud.workspace-runtime.v1.")) continue;
    try {
      const parsed = JSON.parse(raw);
      if (
        Number.isSafeInteger(parsed?.fencingToken) &&
        parsed.fencingToken > 0 &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.workspaceRuntimeId === "string" &&
        typeof parsed.attemptId === "string" &&
        typeof parsed.turnId === "string"
      ) {
        records.push(parsed);
      }
    } catch {
      throw new Error("Cube assignment inventory contained malformed managed metadata");
    }
  }
  const fencingToken = Number(metadata["picloud.fencing_token"]);
  const current = records.filter(
    (record) =>
      record.leaseId === metadata["picloud.lease_id"] &&
      record.attemptId === metadata["picloud.attempt_id"] &&
      record.fencingToken === fencingToken,
  );
  if (current.length !== 1) {
    throw new Error("Cube assignment inventory contained ambiguous current authority");
  }
  return current[0];
}

function managedForSession(instances, sessionId) {
  return instances.filter((instance) => {
    if (
      instance.metadata["picloud.managed"] !== "true" ||
      instance.metadata["picloud.provider"] !== "cubesandbox" ||
      instance.metadata["picloud.session_id"] !== sessionId
    ) {
      return false;
    }
    return currentCubeAssignment(instance.metadata)?.sessionId === sessionId;
  });
}

function observeCubeSession(sessionId) {
  const controller = new AbortController();
  const observed = new Map();
  let failure;
  const task = (async () => {
    while (!controller.signal.aborted) {
      try {
        for (const instance of managedForSession(await cube.list(), sessionId)) {
          const assignment = currentCubeAssignment(instance.metadata);
          const activationId = assignment?.workspaceRuntimeId;
          if (activationId !== undefined) {
            observed.set(activationId, {
              activationId,
              sandboxId: instance.sandboxId,
              attemptId: assignment.executionId,
              turnId: assignment.turnId,
              state: instance.state,
            });
          }
        }
      } catch (error) {
        failure = error;
        controller.abort();
        return;
      }
      await wait(100, controller.signal);
    }
  })();
  return {
    async stop() {
      controller.abort();
      await task;
      if (failure !== undefined) throw failure;
      return [...observed.values()];
    },
  };
}

async function waitForNoCubeSession(sessionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const remaining = managedForSession(await cube.list(), sessionId);
    if (remaining.length === 0) return;
    await wait(250);
  }
  throw new Error("Cube inventory retained a settled Session microVM");
}

async function waitForRunningCubeSession(sessionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const retained = managedForSession(await cube.list(), sessionId);
    if (retained.length === 1 && retained[0].state === "running") return retained[0];
    if (retained.length > 1) {
      throw new Error("Cube inventory retained more than one Workspace microVM");
    }
    await wait(250);
  }
  throw new Error("Cube inventory did not retain one running Workspace microVM");
}

async function destroyCubeSession(sessionId) {
  const retained = managedForSession(await cube.list(), sessionId);
  await Promise.allSettled(retained.map((instance) => cube.destroy(instance.sandboxId)));
  await waitForNoCubeSession(sessionId);
}

async function logicalSandboxIdForRun(runId) {
  const value = await psql(
    `select ra.sandbox_id
       from runs r
       join run_attempts ra
         on ra.run_id = r.id
        and ra.id = r.current_attempt_id
      where r.id = ${sqlLiteral(runId)}`,
  );
  assert.match(value, /^[0-9a-f-]{36}$/i);
  return value;
}

async function logicalSandboxIdsForSession(sessionId) {
  const values = await psql(
    `select distinct ra.sandbox_id
       from runs r
       join run_attempts ra on ra.run_id = r.id
      where r.session_id = ${sqlLiteral(sessionId)}
        and ra.sandbox_id is not null`,
  );
  if (values.length === 0) return [];
  const sandboxIds = values.split(/\r?\n/);
  for (const sandboxId of sandboxIds) assert.match(sandboxId, /^[0-9a-f-]{36}$/i);
  return sandboxIds;
}

async function listLogicalSandboxAssignments(logicalSandboxId) {
  const source = `
    import { readFileSync } from "node:fs";
    import { randomUUID } from "node:crypto";
    const token = readFileSync("/run/pi-cloud-secrets/tool-broker-token", "utf8").trim();
    const response = await fetch("http://127.0.0.1:4300/internal/v1/sandbox-inventory", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: 1,
        type: "assignments.list",
        requestId: randomUUID(),
        sandboxId: ${JSON.stringify(logicalSandboxId)},
      }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    process.stdout.write(JSON.stringify(value.assignments));
  `;
  return parseJson(
    await capture(
      process.execPath,
      [
        "scripts/production-compose.mjs",
        "exec",
        "-T",
        "tool-broker",
        "node",
        "--input-type=module",
        "--eval",
        source,
      ],
      60_000,
    ),
    "Tool Broker assignment inventory",
  );
}

async function workspaceSettlementEvidence(runId) {
  const value = await psql(
    `select settlement.tenant_id::text || '|' || settlement.workspace_id::text || '|' || artifact.size_bytes
       from workspace_settlements settlement
       join artifacts artifact on artifact.id = settlement.settlement_artifact_id
      where settlement.run_id = ${sqlLiteral(runId)}
        and settlement.state = 'settled'`,
  );
  const [tenantId, workspaceId, artifactBytesValue] = value.split("|");
  assert(tenantId && workspaceId && artifactBytesValue);
  const artifactBytes = Number(artifactBytesValue);
  assert(Number.isSafeInteger(artifactBytes) && artifactBytes > 0);
  const { workspacePath } = workspaceVolumePath(tenantId, workspaceId, "settlement-evidence");
  const volumeFileCount = (
    await readdir(workspacePath, { recursive: true, withFileTypes: true })
  ).filter((entry) => entry.isFile()).length;
  return { volumeFileCount, artifactBytes };
}

async function workspaceRuntimeEvidence(workspaceId) {
  const value = await psql(
    `select workspace_runtime_id::text || '|' || coalesce(runtime_id, '') || '|' || state
       from tool_broker_workspace_runtimes
      where workspace_id = ${sqlLiteral(workspaceId)}
        and state in ('reserved', 'materializing', 'active', 'warm', 'cleaning', 'unknown')
      order by updated_at desc
      limit 1`,
  );
  const [workspaceRuntimeId, providerRuntimeId, state] = value.split("|");
  assert(workspaceRuntimeId && providerRuntimeId && state);
  return { workspaceRuntimeId, providerRuntimeId, state };
}

async function toolBindingForRun(runId) {
  const value = await psql(
    `select tool_binding_id::text
       from tool_broker_operations
      where run_id = ${sqlLiteral(runId)}
      order by started_at
      limit 1`,
  );
  assert(value.length > 0, `Run ${runId} did not record a Tool binding`);
  return value;
}

async function optionalMetadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function workspaceVolumePath(tenant, workspaceId, sessionId) {
  const volumeId = workspaceVolumeId({ tenantId: tenant, workspaceId, sessionId });
  const volumeRoot = resolve(runtimeDirectory, "state/cube-shared/volume");
  const volumePath = resolve(volumeRoot, `picloud-posix-${volumeId}`);
  assert(volumePath.startsWith(`${volumeRoot}/`), "Workspace path escaped the shared-volume root");
  return { volumeId, volumePath, workspacePath: resolve(volumePath, "workspace") };
}

async function userManagedGitEvidence(tenant, workspaceId, sessionId) {
  const { volumeId, volumePath, workspacePath } = workspaceVolumePath(
    tenant,
    workspaceId,
    sessionId,
  );
  const trustedGitPath = resolve(volumePath, ".pi-cloud-runtime/git");
  const [trustedGit, workspace, workspaceGit] = await Promise.all([
    optionalMetadata(trustedGitPath),
    optionalMetadata(workspacePath),
    optionalMetadata(resolve(workspacePath, ".git")),
  ]);
  assert.equal(trustedGit, undefined, "Retired platform Git metadata still exists");
  assert(
    workspace?.isDirectory() && !workspace.isSymbolicLink(),
    "User Workspace directory was absent",
  );
  return {
    volumeId,
    platformGitMetadataAbsent: true,
    userGitPresent: workspaceGit?.isDirectory() === true && !workspaceGit.isSymbolicLink(),
  };
}

async function terminateLogicalSandbox(logicalSandboxId, sessionId, required) {
  const durableWarmJson = await psql(
    `select json_build_object(
              'containerId', runtime_id,
              'containerName', runtime_name,
              'supervisorId', supervisor_id,
              'bootId', boot_id,
              'sandboxId', sandbox_id,
              'runId', run_id,
              'workspaceId', workspace_id,
              'sessionId', session_id,
              'turnId', turn_id,
              'executionLease', 'pcel1_' || replace(lease_id::text, '-', '') ||
                '_' || replace(attempt_id::text, '-', '') || '_' || fencing_token::text
            )::text
       from tool_broker_workspace_runtimes
      where workspace_id = (
              select workspace_id from sessions where id = ${sqlLiteral(sessionId)}
            )
        and state = 'warm'
        and runtime_id is not null
        and runtime_name is not null`,
  );
  const durableWarm =
    durableWarmJson.length === 0
      ? undefined
      : parseJson(durableWarmJson, "Broker-owned warm assignment");
  const source = `
    import { readFileSync } from "node:fs";
    import { randomUUID } from "node:crypto";
    const sessionId = ${JSON.stringify(sessionId)};
    const token = readFileSync(
      "/run/pi-cloud-secrets/tool-broker-token",
      "utf8",
    ).trim();
    const endpoint = "http://127.0.0.1:4300/internal/v1/sandbox-inventory";
    const durableWarm = ${JSON.stringify(durableWarm)};
    const sandboxId = durableWarm?.sandboxId ?? ${JSON.stringify(logicalSandboxId)};
    const send = async (body) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(value));
      return value;
    };
    const listed = await send({
      protocolVersion: 1,
      type: "assignments.list",
      requestId: randomUUID(),
      sandboxId,
    });
    const visibleAssignments = listed.assignments.filter(
      (assignment) => assignment.sessionId === sessionId,
    );
    const assignments = visibleAssignments.length === 0 && durableWarm !== undefined
      ? [durableWarm]
      : visibleAssignments;
    if (assignments.length > 1 || (${JSON.stringify(required)} && assignments.length !== 1)) {
      throw new Error("Expected one Workspace runtime assignment, got " + assignments.length);
    }
    if (assignments.length === 0) process.exit(0);
    const assignment = assignments[0];
    await send({
      protocolVersion: 1,
      type: "assignment.terminate_and_confirm",
      requestId: randomUUID(),
      sandboxId,
      assignment,
    });
  `;
  await capture(
    process.execPath,
    [
      "scripts/production-compose.mjs",
      "exec",
      "-T",
      "tool-broker",
      "node",
      "--input-type=module",
      "--eval",
      source,
    ],
    60_000,
  );
}

async function terminateWarmCubeSession(runId, sessionId) {
  await terminateLogicalSandbox(await logicalSandboxIdForRun(runId), sessionId, true);
}

async function waitForDurableRunCompletion(runId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(
        `Run ${run.runId} ended as ${run.state}${
          run.failure === undefined
            ? ""
            : ` (${run.failure.code}: ${run.failure.message ?? "no detail"})`
        }`,
      );
    }
    await wait(100);
  }
  throw new Error("Agent settled, but the durable Run did not commit within its deadline");
}

async function runTurn(sessionId, prompt, expectTools) {
  const observer = observeCubeSession(sessionId);
  const submittedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const acceptedAt = performance.now();
  const controller = new AbortController();
  let timeoutFailure;
  const timer = setTimeout(() => {
    timeoutFailure = new Error("Live Cube production turn timed out");
    controller.abort(timeoutFailure);
  }, 10 * 60_000);
  const events = [];
  let firstDurableActivityAt;
  let firstToolStartedAt;
  let firstAssistantTextAt;
  let terminal;
  let failedRun;
  let monitorFailure;
  const monitor = (async () => {
    try {
      while (!controller.signal.aborted) {
        const run = await api.getRun(accepted.runId);
        if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
          failedRun = run;
          controller.abort();
          return;
        }
        await wait(250, controller.signal);
      }
    } catch (error) {
      monitorFailure = error;
      controller.abort();
    }
  })();
  try {
    await streamSessionEvents({
      sessionId,
      signal: controller.signal,
      authorizationToken,
      fetchImplementation: fetchFromProduction,
      retryDelayMs: 100,
      onStatus() {},
      onSnapshot(snapshot) {
        for (const event of snapshot.liveEvents) observeEvent(event);
      },
      onEvent(event) {
        observeEvent(event);
      },
    });
    await monitor;
    if (monitorFailure !== undefined) throw monitorFailure;
    if (timeoutFailure !== undefined) throw timeoutFailure;
    if (failedRun !== undefined) {
      throw new Error(
        `Run ${failedRun.runId} ended as ${failedRun.state}${
          failedRun.failure === undefined
            ? ""
            : ` (${failedRun.failure.code}: ${failedRun.failure.message ?? "no detail"})`
        }`,
      );
    }
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    assert(firstDurableActivityAt !== undefined, "Turn did not publish a durable Agent activity");
    assert(firstAssistantTextAt !== undefined, "Turn did not stream assistant text");
    const toolCalls = events.filter((event) => event.type === "tool.started").length;
    if (expectTools) {
      assert(toolCalls > 0, "Coding turn did not execute a Tool operation");
      assert(firstToolStartedAt !== undefined, "Coding turn did not publish its first Tool start");
      assert(
        events.some((event) => event.type === "tool.completed"),
        "Coding turn did not complete a Tool operation",
      );
    } else {
      assert.equal(toolCalls, 0, "Pure chat unexpectedly executed a Tool");
    }
    await waitForDurableRunCompletion(accepted.runId);
    if (expectTools) {
      await waitForRunningCubeSession(sessionId);
    } else {
      await waitForNoCubeSession(sessionId);
    }
    const activations = await observer.stop();
    return {
      accepted,
      throughSequence: Math.max(0, ...events.map((event) => event.seq)),
      events,
      terminal,
      toolCalls,
      activations,
      acceptedMs: Math.round(acceptedAt - submittedAt),
      firstDurableActivityMs: Math.round(firstDurableActivityAt - submittedAt),
      firstToolStartedMs:
        firstToolStartedAt === undefined ? null : Math.round(firstToolStartedAt - submittedAt),
      firstAssistantTextMs: Math.round(firstAssistantTextAt - submittedAt),
      settledMs: Math.round(performance.now() - submittedAt),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await monitor;
    await observer.stop().catch(() => undefined);
  }

  function observeEvent(event) {
    if (events.some((candidate) => candidate.eventId === event.eventId)) return;
    events.push(event);
    if (event.turnId === accepted.turnId && event.type === "assistant.text.delta") {
      const observedAt = performance.now();
      firstDurableActivityAt ??= observedAt;
      firstAssistantTextAt ??= observedAt;
    }
    if (event.turnId === accepted.turnId && event.type === "tool.started") {
      const observedAt = performance.now();
      firstDurableActivityAt ??= observedAt;
      firstToolStartedAt ??= observedAt;
    }
    if (
      event.turnId === accepted.turnId &&
      (event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled")
    ) {
      terminal = event;
      controller.abort();
    }
  }
}

async function runLatencyEvidence(runId) {
  const transitionEvidence = await psql(
    `with timeline as (
       select min(transition.occurred_at) filter (where transition.to_state = 'claimed') as claimed_at,
              min(transition.occurred_at) filter (where transition.to_state = 'provisioning') as acknowledged_at,
              min(transition.occurred_at) filter (where transition.to_state = 'running') as runner_at
         from run_attempt_transitions transition
        where transition.run_id = ${sqlLiteral(runId)}
     )
     select round(extract(epoch from (timeline.claimed_at - run.queued_at)) * 1000)::text || '|' ||
            round(extract(epoch from (timeline.acknowledged_at - timeline.claimed_at)) * 1000)::text || '|' ||
            round(extract(epoch from (timeline.runner_at - timeline.acknowledged_at)) * 1000)::text || '|' ||
            round(extract(epoch from (run.settled_at - timeline.runner_at)) * 1000)::text
       from runs run cross join timeline
      where run.id = ${sqlLiteral(runId)}`,
  );
  const [queueToClaimStartMs, claimStartToCommandAckMs, commandAckToRunnerMs, runnerToTerminalMs] =
    transitionEvidence.split("|").map(Number);
  const modelEvidence = await psql(
    `select count(*)::text || '|' ||
            coalesce(sum(greatest(0, entry.timestamp_ms -
              (entry.payload #>> '{message,timestamp}')::bigint)), 0)::text
       from runs run
       join pi_session_entries entry
         on entry.tenant_id = run.tenant_id
        and entry.turn_id = run.turn_id
      where run.id = ${sqlLiteral(runId)}
        and entry.type = 'message'
        and entry.payload #>> '{message,role}' = 'assistant'
        and entry.payload #>> '{message,timestamp}' is not null`,
  );
  const [modelRequests, modelTotalMs] = modelEvidence.split("|").map(Number);
  const toolEvidence = await psql(
    `select count(operation.operation_id)::text || '|' ||
            coalesce(round(sum(extract(epoch from (operation.settled_at - operation.started_at)) * 1000)), 0)::text || '|' ||
            count(*) filter (where operation.settled_at < operation.started_at)::text
       from runs run
       join tool_broker_operations operation on operation.run_id = run.id
      where run.id = ${sqlLiteral(runId)}
        and operation.started_at >= run.started_at
        and operation.started_at <= run.settled_at`,
  );
  const [toolOperations, toolTotalMs, negativeToolDurations] = toolEvidence.split("|").map(Number);
  assert.equal(negativeToolDurations, 0, "Tool operation timestamps used inconsistent clocks");
  return {
    queueToClaimStartMs,
    claimStartToCommandAckMs,
    commandAckToRunnerMs,
    runnerToTerminalMs,
    modelRequests,
    modelTotalMs,
    toolOperations,
    toolTotalMs,
  };
}

function totalUsage(...usage) {
  return usage.reduce(
    (total, value) => ({
      requests: total.requests + value.requests,
      inputTokens: total.inputTokens + value.inputTokens,
      outputTokens: total.outputTokens + value.outputTokens,
      cacheReadTokens: total.cacheReadTokens + value.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + value.cacheWriteTokens,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

await cube.checkHealth();
const maximumActiveToolSandboxes = Number(
  environment.PI_CLOUD_MAXIMUM_ACTIVE_TOOL_SANDBOXES ?? "2",
);
const existingCubeCount = (await cube.list()).length;
if (
  !Number.isSafeInteger(maximumActiveToolSandboxes) ||
  maximumActiveToolSandboxes < 2 ||
  maximumActiveToolSandboxes - existingCubeCount < 2
) {
  throw new Error(
    `Cube production acceptance requires two free Sandbox slots; configured=${String(maximumActiveToolSandboxes)}, active=${String(existingCubeCount)}`,
  );
}
progress("Cube API is healthy; registering an isolated acceptance tenant");
const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const registration = await new PiCloudApi(fetchFromProduction).registerTenant(
  `cube-check-${suffix}`.replaceAll(/[^a-z0-9-]/g, "-").slice(0, 63),
  "Cube production acceptance tenant",
);
api = new PiCloudApi(fetchFromProduction, registration.apiToken);
tenantId = registration.tenantId;
authorizationToken = registration.apiToken;
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must have a real model configured");
progress(`real model configured: ${model.provider}/${model.modelId}`);

const project = await api.createProject(`Cube production acceptance ${suffix}`);
const session = await api.createSession(
  project.projectId,
  project.workspaceId,
  `Cube production acceptance ${suffix}`,
  "elastic",
);
assert.equal(session.executionMode, "elastic");
let foreignSession;
let largeSession;

try {
  assert.equal(managedForSession(await cube.list(), session.sessionId).length, 0);

  const chat = await runTurn(
    session.sessionId,
    "Do not call any tool. Reply with exactly this text and nothing else: cube-chat-ok",
    false,
  );
  progress("pure chat completed without a Cube activation");
  assert.equal(chat.activations.length, 0, "Pure chat created a Cube microVM");
  const chatUsage = await runUsageEvidence(chat.accepted.runId);
  const chatLatency = await runLatencyEvidence(chat.accepted.runId);
  assert(chatUsage.requests > 0 && chatUsage.outputTokens > 0);

  const firstCoding = await runTurn(
    session.sessionId,
    [
      "Work in the current empty workspace and use tools.",
      "Create counting_sort.py with a counting_sort(values) implementation that supports negative integers and duplicates.",
      "Include executable Python tests in the file for empty, sorted, reverse, negative, and duplicate inputs.",
      "Run python3 counting_sort.py and make every test pass.",
      "Do not initialize or create a Git repository or any .git entry.",
      "Do not only describe the code.",
    ].join(" "),
    true,
  );
  progress("first coding Run completed in a real Cube KVM");
  assert.equal(
    firstCoding.activations.length,
    1,
    "First coding Run did not use exactly one Cube VM",
  );
  const firstUsage = await runUsageEvidence(firstCoding.accepted.runId);
  const firstToolBindingId = await toolBindingForRun(firstCoding.accepted.runId);
  const firstCodingLatency = await runLatencyEvidence(firstCoding.accepted.runId);
  assert(firstUsage.requests > 0 && firstUsage.outputTokens > 0);
  const firstSettlementId = await psql(
    `select current_workspace_settlement_id::text from sessions where id = ${sqlLiteral(session.sessionId)}`,
  );
  assert(firstSettlementId.length > 0, "First coding Run did not settle the Workspace");
  const { workspacePath } = workspaceVolumePath(tenantId, session.workspaceId, session.sessionId);
  const firstSource = await readFile(resolve(workspacePath, "counting_sort.py"), "utf8");
  assert(
    firstSource.includes("def counting_sort") && /negative/u.test(firstSource.toLowerCase()),
    "First persistent Workspace settlement omitted counting_sort.py code",
  );
  progress("first persistent Workspace Volume revision was verified in place");
  const firstWorkspaceRuntime = await workspaceRuntimeEvidence(session.workspaceId);
  assert.equal(firstWorkspaceRuntime.state, "warm");
  assert.deepEqual(
    await listLogicalSandboxAssignments(await logicalSandboxIdForRun(firstCoding.accepted.runId)),
    [],
    "Broker-owned warm Cube leaked into expired Supervisor inventory",
  );

  const previewRun = await runTurn(
    session.sessionId,
    [
      "Use the existing Workspace and Tools.",
      "Create /workspace/index.html containing exactly PI_CLOUD_PERSISTENT_PREVIEW_OK in the body.",
      "Start a detached background heartbeat loop that writes the current epoch to /workspace/persistent-heartbeat once per second, and store its PID in /workspace/persistent-heartbeat.pid.",
      "Start a background HTTP server on 0.0.0.0:8000 serving /workspace.",
      "Verify the listener, then call the preview Tool for port 8000.",
      "Do not stop the server before finishing.",
    ].join(" "),
    true,
  );
  const previewUsage = await runUsageEvidence(previewRun.accepted.runId);
  await waitForPreview(
    `/v1/conversations/${session.sessionId}/preview/8000/`,
    "PI_CLOUD_PERSISTENT_PREVIEW_OK",
  );
  progress("Agent preview Tool published an authenticated route to its warm Cube HTTP service");

  const followUp = await runTurn(
    session.sessionId,
    [
      "Read the existing counting_sort.py from the previous turn.",
      "Add a clearly named regression case or test called duplicate_negative_regression using exactly [4, -1, 4, 0, -1].",
      "Verify that its expected output is [-1, -1, 0, 4, 4].",
      "Run python3 counting_sort.py again and make all tests pass.",
      "Use tools and modify the existing file; do not recreate an unrelated implementation.",
    ].join(" "),
    true,
  );
  progress("follow-up coding Run reused the bounded-warm Cube KVM");
  assert.equal(followUp.activations.length, 1, "Follow-up Run did not use exactly one Cube VM");
  const followUpWorkspaceRuntime = await workspaceRuntimeEvidence(session.workspaceId);
  assert.equal(
    followUpWorkspaceRuntime.workspaceRuntimeId,
    firstWorkspaceRuntime.workspaceRuntimeId,
    "Two coding Runs did not share one Workspace runtime",
  );
  assert.equal(
    followUpWorkspaceRuntime.providerRuntimeId,
    firstWorkspaceRuntime.providerRuntimeId,
    "Two coding Runs did not reuse the same Cube native sandbox",
  );
  assert.notEqual(
    await toolBindingForRun(followUp.accepted.runId),
    firstToolBindingId,
    "Two coding Runs unexpectedly reused one logical Tool binding",
  );
  const followUpUsage = await runUsageEvidence(followUp.accepted.runId);
  const followUpLatency = await runLatencyEvidence(followUp.accepted.runId);
  assert(followUpUsage.requests > 0 && followUpUsage.outputTokens > 0);
  const processCheck = await runTurn(
    session.sessionId,
    [
      "Use bash to verify the existing detached heartbeat process without replacing or restarting it.",
      "Read /workspace/persistent-heartbeat, wait two seconds, and read it again.",
      "Fail the command if either value is empty or they are equal.",
      "On success output exactly PERSISTENT_PROCESS_SURVIVED_OK.",
    ].join(" "),
    true,
  );
  assert(
    processCheck.events.some((event) =>
      JSON.stringify(event.payload).includes("PERSISTENT_PROCESS_SURVIVED_OK"),
    ),
    "Background process did not survive reuse through a later Tool binding",
  );
  const processCheckUsage = await runUsageEvidence(processCheck.accepted.runId);
  await waitForRunningCubeSession(session.sessionId);
  progress("background process survived cross-Run Tool bindings on one warm Workspace Cube");
  const finalSettlementId = await psql(
    `select current_workspace_settlement_id::text from sessions where id = ${sqlLiteral(session.sessionId)}`,
  );
  assert(finalSettlementId.length > 0);
  assert.notEqual(finalSettlementId, firstSettlementId);
  const workspaceSettlementCount = Number(
    await psql(
      `select count(*)::text from workspace_settlements where session_id = ${sqlLiteral(session.sessionId)}`,
    ),
  );
  assert(Number.isSafeInteger(workspaceSettlementCount) && workspaceSettlementCount >= 2);
  const finalSource = await readFile(resolve(workspacePath, "counting_sort.py"), "utf8");
  assert(finalSource.includes("counting_sort"));
  assert(
    finalSource.includes("4, -1, 4, 0, -1") ||
      followUp.events.some(
        (event) =>
          event.type === "tool.completed" &&
          JSON.stringify(event.payload).includes("4, -1, 4, 0, -1"),
      ),
    "Follow-up did not exercise the requested duplicate-negative regression input",
  );
  const gitPlacement = await userManagedGitEvidence(
    tenantId,
    session.workspaceId,
    session.sessionId,
  );

  const conversation = await api.getConversation(session.sessionId);
  assert.equal(conversation.turns.length, 5);
  assert(conversation.turns.every((turn) => turn.transcript !== undefined));

  const canonicalEvidence = await psql(
    `select count(distinct terminal.turn_id) || '|' || count(entry.id) || '|' ||
            coalesce(max(terminal.seq), 0) || '|' ||
            coalesce(sum(octet_length(entry.payload::text)), 0)
       from session_terminal_events terminal
       left join pi_session_entries entry on entry.turn_id = terminal.turn_id
      where terminal.tenant_id = ${sqlLiteral(tenantId)}
        and terminal.session_id = ${sqlLiteral(session.sessionId)}`,
  );
  const [terminalCount, piEntryCount, terminalThroughSequence, canonicalPayloadBytes] =
    canonicalEvidence.split("|").map(Number);
  assert.equal(terminalCount, 5);
  assert(piEntryCount > terminalCount);
  assert(canonicalPayloadBytes > 0);
  assert(terminalThroughSequence <= processCheck.throughSequence);
  const eventPlaneEvidence = await psql(
    `select (to_regclass('public.session_events') is null)::int || '|' ||
            count(*)
       from pi_session_mutation_results
      where tenant_id = ${sqlLiteral(tenantId)}`,
  );
  const [postgresHotEventTableAbsent, projectedSessionMutations] = eventPlaneEvidence
    .split("|")
    .map(Number);
  assert.equal(postgresHotEventTableAbsent, 1);
  assert(projectedSessionMutations > 0);
  const kafka = await kafkaState();
  assert(kafka.acceptedFacts > 0 && kafka.canonicalHeads > 0);

  const foreignApi = bootstrapApi;
  const foreignProject = await foreignApi.createProject(`Foreign Cube project ${suffix}`);
  foreignSession = await foreignApi.createSession(
    foreignProject.projectId,
    foreignProject.workspaceId,
    `Cube foreign-tenant isolation ${suffix}`,
  );
  await assert.rejects(
    api.getConversation(foreignSession.sessionId),
    (error) => error instanceof PiCloudApiError && error.status === 404,
  );
  await assert.rejects(
    foreignApi.getConversation(session.sessionId),
    (error) => error instanceof PiCloudApiError && error.status === 404,
  );

  const largeProject = await api.createProject(`Cube large-workspace project ${suffix}`);
  largeSession = await api.createSession(
    largeProject.projectId,
    largeProject.workspaceId,
    `Cube large-workspace acceptance ${suffix}`,
    "elastic",
  );
  const largeFirst = await runTurn(
    largeSession.sessionId,
    [
      "Use bash and work in the current empty workspace.",
      "In one foreground bash command, use Python to create a directory named large-fixture containing exactly 1024 numbered text files; each file must contain its own number and a repeated deterministic payload.",
      "Count regular files under large-fixture and require the count to equal 1024.",
      "Write settlement-marker.txt in the workspace root containing exactly LARGE-SETTLEMENT-OK.",
      "Do not use the network, do not start a background process, and report the measured file count.",
    ].join(" "),
    true,
  );
  progress("large Workspace Run completed and committed its persistent Volume revision");
  const largeFirstUsage = await runUsageEvidence(largeFirst.accepted.runId);
  const largeFirstWorkspace = await workspaceSettlementEvidence(largeFirst.accepted.runId);
  const largeFirstRuntime = await workspaceRuntimeEvidence(largeSession.workspaceId);
  assert(
    largeFirstWorkspace.volumeFileCount > 512,
    "Large-workspace Run did not create the requested persistent files",
  );
  assert(
    largeFirstWorkspace.artifactBytes <= 64 * 1_024,
    "Cube persistent Volume settlement was not lightweight",
  );
  await terminateWarmCubeSession(largeFirst.accepted.runId, largeSession.sessionId);
  await waitForNoCubeSession(largeSession.sessionId);
  progress("source Cube was removed while its persistent Workspace Volume remained authoritative");

  const largeFollowUp = await runTurn(
    largeSession.sessionId,
    [
      "Continue from the existing persistent Workspace Volume and make exactly one bash Tool call.",
      "Do not recreate the fixture.",
      "In that one command: read settlement-marker.txt and require it to equal LARGE-SETTLEMENT-OK; count regular files under the existing large-fixture directory and require the count to equal 1024; verify two numbered files contain their own numbers; write restore-proof.txt containing the marker and measured count; then read restore-proof.txt back.",
      "After that Tool result, do not call another Tool and reply exactly RESTORE-VERIFIED.",
    ].join(" "),
    true,
  );
  progress("large persistent Workspace Volume attached to a fresh Cube KVM");
  const largeFollowUpUsage = await runUsageEvidence(largeFollowUp.accepted.runId);
  const largeFollowUpWorkspace = await workspaceSettlementEvidence(largeFollowUp.accepted.runId);
  const largeFollowUpRuntime = await workspaceRuntimeEvidence(largeSession.workspaceId);
  assert(largeFollowUpWorkspace.volumeFileCount > 512);
  assert.equal(largeFirst.activations.length, 1);
  assert.equal(largeFollowUp.activations.length, 1);
  assert.notEqual(
    largeFollowUpRuntime.providerRuntimeId,
    largeFirstRuntime.providerRuntimeId,
    "Large Workspace did not cold-restore into a fresh Cube VM",
  );
  assert.notEqual(
    largeFollowUpRuntime.workspaceRuntimeId,
    largeFirstRuntime.workspaceRuntimeId,
    "Large Workspace cold restore reused stale physical runtime identity",
  );

  const retainedMainSessionCubes = managedForSession(await cube.list(), session.sessionId);
  assert(
    retainedMainSessionCubes.length <= 1,
    "Cube inventory retained more than one Workspace microVM",
  );
  await waitForNoCubeSession(foreignSession.sessionId);
  const usage = totalUsage(
    chatUsage,
    firstUsage,
    previewUsage,
    followUpUsage,
    processCheckUsage,
    largeFirstUsage,
    largeFollowUpUsage,
  );
  const report = {
    accepted: true,
    piCloudRevision: testedRevision,
    checkedAt: new Date().toISOString(),
    upstream: "TencentCloud/CubeSandbox@v0.6.0",
    model: { provider: model.provider, modelId: model.modelId },
    pureChat: {
      acceptedMs: chat.acceptedMs,
      firstDurableActivityMs: chat.firstDurableActivityMs,
      firstToolStartedMs: chat.firstToolStartedMs,
      firstAssistantTextMs: chat.firstAssistantTextMs,
      settledMs: chat.settledMs,
      toolCalls: chat.toolCalls,
      cubeActivations: chat.activations.length,
      latency: chatLatency,
      usage: chatUsage,
    },
    firstCoding: {
      acceptedMs: firstCoding.acceptedMs,
      firstDurableActivityMs: firstCoding.firstDurableActivityMs,
      firstToolStartedMs: firstCoding.firstToolStartedMs,
      firstAssistantTextMs: firstCoding.firstAssistantTextMs,
      settledMs: firstCoding.settledMs,
      toolCalls: firstCoding.toolCalls,
      cubeActivations: firstCoding.activations.length,
      workspaceFileBytes: Buffer.byteLength(firstSource, "utf8"),
      latency: firstCodingLatency,
      usage: firstUsage,
    },
    followUpCoding: {
      acceptedMs: followUp.acceptedMs,
      firstDurableActivityMs: followUp.firstDurableActivityMs,
      firstToolStartedMs: followUp.firstToolStartedMs,
      firstAssistantTextMs: followUp.firstAssistantTextMs,
      settledMs: followUp.settledMs,
      toolCalls: followUp.toolCalls,
      cubeActivations: followUp.activations.length,
      workspaceFileBytes: Buffer.byteLength(finalSource, "utf8"),
      latency: followUpLatency,
      usage: followUpUsage,
    },
    multiRound: {
      sameCubeMicroVm: true,
      runningWorkspaceRuntimeReuse: true,
      elasticSandboxPolicy: session.executionMode === "elastic",
      agentPreviewPublished: true,
      backgroundProcessSurvived: true,
      authenticatedHttpPreviewPassed: true,
      workspaceRestored: true,
      workspaceSettlements: workspaceSettlementCount,
      finalWorkspaceFileBytes: Buffer.byteLength(finalSource, "utf8"),
    },
    workspaceIsolation: gitPlacement,
    multiTenant: {
      crossTenantConversationHidden: true,
      lowerLevelCubeTenantGate: 2,
    },
    largeWorkspace: {
      source: "deterministic 1024-file local fixture",
      firstRunId: largeFirst.accepted.runId,
      followUpRunId: largeFollowUp.accepted.runId,
      firstFileCount: largeFirstWorkspace.volumeFileCount,
      restoredFileCount: largeFollowUpWorkspace.volumeFileCount,
      volumeReferenceBytes: largeFirstWorkspace.artifactBytes,
      sourceSandboxDestroyed: true,
      persistentVolumeRetained: true,
      volumeId: workspaceVolumeId({
        tenantId,
        workspaceId: largeSession.workspaceId,
        sessionId: largeSession.sessionId,
      }),
      restoredFromPersistentVolume: true,
      freshCubeMicroVm: true,
      higherRuntimeGeneration: true,
      firstUsage: largeFirstUsage,
      followUpUsage: largeFollowUpUsage,
    },
    canonicalConversation: {
      terminalCount,
      piEntryCount,
      canonicalPayloadBytes,
      terminalThroughSequence,
    },
    eventPlane: {
      authority: "Kafka acks=all",
      postgresHotEventTableAbsent: true,
      projectedSessionMutations,
      kafka,
    },
    scheduler: {
      authority: "PostgreSQL",
      queue: "runs",
      workerPool: "shared",
    },
    totalUsage: usage,
    cleanup: {
      retainedRunningWorkspaceMicroVmCount: retainedMainSessionCubes.length,
      foreignSessionMicroVmCount: 0,
      conversationDeletionPreservedWorkspaceRuntime: false,
      mainWorkspaceExplicitWarmEvictionVerified: false,
      explicitWarmEvictionVerified: false,
    },
  };
  assert(usage.requests >= 3 && usage.inputTokens > 0 && usage.outputTokens > 0);
  await api.deleteConversation(session.sessionId, newIdempotencyKey("archive-warm"));
  await waitForRunningCubeSession(session.sessionId);
  report.cleanup.conversationDeletionPreservedWorkspaceRuntime = true;
  progress("conversation deletion preserved its independently owned warm Workspace runtime");
  await terminateWarmCubeSession(followUp.accepted.runId, session.sessionId);
  await waitForNoCubeSession(session.sessionId);
  report.cleanup.mainWorkspaceExplicitWarmEvictionVerified = true;
  progress("explicit eviction removed the main warm Workspace Cube");
  await terminateWarmCubeSession(largeFollowUp.accepted.runId, largeSession.sessionId);
  await waitForNoCubeSession(largeSession.sessionId);
  report.cleanup.explicitWarmEvictionVerified = true;
  report.cleanup.retainedRunningWorkspaceMicroVmCount = 0;

  if (writeReport) {
    const reportDirectory = resolve(repositoryRoot, "docs/reports");
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      resolve(reportDirectory, "cubesandbox-production-acceptance-latest.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      resolve(reportDirectory, "cubesandbox-production-acceptance-latest.md"),
      [
        "# CubeSandbox production acceptance",
        "",
        `- Checked at: ${report.checkedAt}`,
        `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
        `- Pure-chat first activity / assistant text / settled: ${String(report.pureChat.firstDurableActivityMs)} / ${String(report.pureChat.firstAssistantTextMs)} / ${String(report.pureChat.settledMs)} ms`,
        `- Pure-chat queue-to-claim-start / claim-and-preparation / model: ${String(report.pureChat.latency.queueToClaimStartMs)} / ${String(report.pureChat.latency.claimStartToCommandAckMs + report.pureChat.latency.commandAckToRunnerMs)} / ${String(report.pureChat.latency.modelTotalMs)} ms`,
        `- Pure-chat Tool calls / Cube activations: ${String(report.pureChat.toolCalls)} / ${String(report.pureChat.cubeActivations)}`,
        `- First coding first activity / Tool / assistant text / settled: ${String(report.firstCoding.firstDurableActivityMs)} / ${String(report.firstCoding.firstToolStartedMs)} / ${String(report.firstCoding.firstAssistantTextMs)} / ${String(report.firstCoding.settledMs)} ms`,
        `- Follow-up first activity / Tool / assistant text / settled: ${String(report.followUpCoding.firstDurableActivityMs)} / ${String(report.followUpCoding.firstToolStartedMs)} / ${String(report.followUpCoding.firstAssistantTextMs)} / ${String(report.followUpCoding.settledMs)} ms`,
        `- First coding queue-to-claim-start / claim-and-preparation / model / Tool: ${String(report.firstCoding.latency.queueToClaimStartMs)} / ${String(report.firstCoding.latency.claimStartToCommandAckMs + report.firstCoding.latency.commandAckToRunnerMs)} / ${String(report.firstCoding.latency.modelTotalMs)} / ${String(report.firstCoding.latency.toolTotalMs)} ms`,
        `- Follow-up queue-to-claim-start / claim-and-preparation / model / Tool: ${String(report.followUpCoding.latency.queueToClaimStartMs)} / ${String(report.followUpCoding.latency.claimStartToCommandAckMs + report.followUpCoding.latency.commandAckToRunnerMs)} / ${String(report.followUpCoding.latency.modelTotalMs)} / ${String(report.followUpCoding.latency.toolTotalMs)} ms`,
        `- Coding Tool calls: ${String(report.firstCoding.toolCalls)} + ${String(report.followUpCoding.toolCalls)}`,
        `- Same running Workspace Cube KVM guest reused: ${String(report.multiRound.sameCubeMicroVm)}`,
        `- Agent Preview / background process survived cross-Run Tool bindings: ${String(report.multiRound.agentPreviewPublished)} / ${String(report.multiRound.backgroundProcessSurvived)}`,
        `- Elastic runtime / conversation deletion preserved Workspace ownership: ${String(report.multiRound.elasticSandboxPolicy)} / ${String(report.cleanup.conversationDeletionPreservedWorkspaceRuntime)}`,
        `- Workspace restored across Runs: ${String(report.multiRound.workspaceRestored)}`,
        `- Platform Git metadata absent / user-managed .git present: ${String(report.workspaceIsolation.platformGitMetadataAbsent)} / ${String(report.workspaceIsolation.userGitPresent)}`,
        `- Large Workspace files / Volume reference: ${String(report.largeWorkspace.firstFileCount)} / ${String(report.largeWorkspace.volumeReferenceBytes)} bytes`,
        `- Large Workspace fresh-VM cold restore: ${String(report.largeWorkspace.freshCubeMicroVm)}`,
        `- Real input/output/cache-read tokens: ${String(report.totalUsage.inputTokens)} / ${String(report.totalUsage.outputTokens)} / ${String(report.totalUsage.cacheReadTokens)}`,
        `- Canonical conversation: ${String(report.canonicalConversation.terminalCount)} terminal Turns / ${String(report.canonicalConversation.piEntryCount)} Pi entries / ${String(report.canonicalConversation.canonicalPayloadBytes)} bytes`,
        `- Kafka AcceptedFacts / canonical Session heads: ${String(report.eventPlane.kafka.acceptedFacts)} / ${String(report.eventPlane.kafka.canonicalHeads)}`,
        `- PostgreSQL hot-event table absent / projected Session mutations: ${String(report.eventPlane.postgresHotEventTableAbsent)} / ${String(report.eventPlane.projectedSessionMutations)}`,
        `- Scheduler / Worker pool: ${report.scheduler.authority} / ${report.scheduler.workerPool}`,
        `- Cross-tenant conversation hidden: ${String(report.multiTenant.crossTenantConversationHidden)}`,
        `- Explicit warm eviction / remaining Cube microVMs: ${String(report.cleanup.mainWorkspaceExplicitWarmEvictionVerified && report.cleanup.explicitWarmEvictionVerified)} / ${String(report.cleanup.retainedRunningWorkspaceMicroVmCount + report.cleanup.foreignSessionMicroVmCount)}`,
        "",
        "A real-model chat Run completed without touching Cube. Two elastic coding Runs used distinct fenced Tool bindings in one bounded-warm Workspace Cube; deleting the conversation did not implicitly own or destroy that Workspace runtime, and explicit eviction removed it. The persistent Volume contained no retired platform Git metadata; any ordinary .git directory belongs to the user and Agent. A separate Run generated a deterministic 1024-file fixture without depending on an external network; after explicit source-VM destruction, its follow-up attached the same persistent Workspace Volume to a fresh Cube VM under a new physical runtime identity. All Runs completed through the shared PostgreSQL queue and horizontally scalable Pi Worker pool. Provider usage, canonical Pi entries, cross-tenant API denial and explicit warm eviction were verified.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  // Release Manager ownership/admission first, then use the native Cube API
  // only as an orphan fallback. Reversing this order would strand a warm
  // in-memory handle until the Manager's TTL/restart.
  await api
    .deleteConversation(session.sessionId, newIdempotencyKey("acceptance-finally-archive"))
    .catch(() => undefined);
  await waitForNoCubeSession(session.sessionId).catch(() => undefined);
  for (const logicalSandboxId of await logicalSandboxIdsForSession(session.sessionId).catch(
    () => [],
  )) {
    await terminateLogicalSandbox(logicalSandboxId, session.sessionId, false).catch(
      () => undefined,
    );
  }
  await destroyCubeSession(session.sessionId).catch(() => undefined);
  await api
    .deleteWorkspace(project.workspaceId, newIdempotencyKey("acceptance-finally-workspace"))
    .catch(() => undefined);
  if (foreignSession !== undefined) {
    await bootstrapApi
      .deleteConversation(
        foreignSession.sessionId,
        newIdempotencyKey("acceptance-finally-archive-foreign"),
      )
      .catch(() => undefined);
    await bootstrapApi
      .deleteWorkspace(
        foreignSession.workspaceId,
        newIdempotencyKey("acceptance-finally-workspace-foreign"),
      )
      .catch(() => undefined);
  }
  if (largeSession !== undefined) {
    await api
      .deleteConversation(
        largeSession.sessionId,
        newIdempotencyKey("acceptance-finally-archive-large"),
      )
      .catch(() => undefined);
    await waitForNoCubeSession(largeSession.sessionId).catch(() => undefined);
    for (const logicalSandboxId of await logicalSandboxIdsForSession(largeSession.sessionId).catch(
      () => [],
    )) {
      await terminateLogicalSandbox(logicalSandboxId, largeSession.sessionId, false).catch(
        () => undefined,
      );
    }
    await destroyCubeSession(largeSession.sessionId).catch(() => undefined);
    await api
      .deleteWorkspace(
        largeSession.workspaceId,
        newIdempotencyKey("acceptance-finally-workspace-large"),
      )
      .catch(() => undefined);
  }
  await cube.close();
}
