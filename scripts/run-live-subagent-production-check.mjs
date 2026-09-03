import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import {
  OfficialCubeSandboxRuntimeClient,
  workspaceVolumeId,
} from "../packages/tool-broker/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.PI_CLOUD_LIVE_SUBAGENT_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_SUBAGENT_CHECK=1 to acknowledge real model and Cube Subagent usage",
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
const databaseUrl = new URL(
  (
    await readPrivate(
      resolve(runtimeDirectory, "secrets/database-url"),
      4_096,
      "Production database URL",
    )
  ).trim(),
);
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
const databaseUser = decodeURIComponent(databaseUrl.username);
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const token = (
  await readPrivate(resolve(runtimeDirectory, "secrets/api-token"), 4_096, "Production API token")
).trim();
const fetchFromProduction = (input, init) => fetch(new URL(String(input), baseUrl), init);
const bootstrapApi = new PiCloudApi(fetchFromProduction, token);
let api = bootstrapApi;
let authorizationToken = token;

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

async function retireHistoricalAcceptanceCubes() {
  const rows = await psql(`
    select id::text from sessions where title like 'Subagent production acceptance %'
    union
    select execution.child_session_id::text
    from subagent_executions as execution
    join sessions as root on root.id = execution.root_session_id
    where root.title like 'Subagent production acceptance %'
  `);
  const acceptanceSessions = new Set(rows ? rows.split(/\r?\n/) : []);
  if (acceptanceSessions.size === 0) return;
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
  try {
    for (const sandbox of await cube.list()) {
      if (acceptanceSessions.has(sandbox.metadata["picloud.session_id"] ?? "")) {
        await cube.destroy(sandbox.sandboxId);
      }
    }
  } finally {
    await cube.close();
  }
}

function wait(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

async function waitForRun(runId) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(`Run ${runId} ended as ${run.state}: ${JSON.stringify(run.failure)}`);
    }
    await wait(100);
  }
  throw new Error(`Run ${runId} did not settle`);
}

async function runTurn(sessionId, prompt) {
  const accepted = await api.acceptTurn(
    sessionId,
    prompt,
    newIdempotencyKey("subagent-live"),
    "off",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  const text = [];
  let terminal;
  const observeEvent = (event) => {
    if (event.turnId !== accepted.turnId) return;
    if (event.type === "assistant.text.delta") text.push(event.payload.text);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)) {
      terminal = event;
      controller.abort();
    }
  };
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
      onEvent: observeEvent,
    });
    assert.equal(terminal?.type, "turn.completed", JSON.stringify(terminal?.payload));
    await waitForRun(accepted.runId);
    return { accepted, text: text.join("") };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function executionEvidence(parentRunId) {
  const value = await psql(`
    select json_build_object(
      'executionId', execution.id,
      'workspaceMode', execution.workspace_mode,
      'state', execution.state,
      'childSessionId', execution.child_session_id,
      'childRunId', execution.child_run_id,
      'parentWorkspaceId', parent_run.workspace_id,
      'childWorkspaceId', child_run.workspace_id,
      'childRunState', child_run.state,
      'parentWorker', parent_attempt.claim_owner_id,
      'childWorker', child_attempt.claim_owner_id,
      'sameWorker', parent_attempt.claim_owner_id = child_attempt.claim_owner_id,
      'piSessionId', child.pi_session_id,
      'piSessionLane', child.pi_session_lane,
      'contextBaseEntryId', execution.pi_context_base_entry_id,
      'childPhysicalSessionExists', exists (
        select 1
        from pi_sessions physical
        where physical.tenant_id = execution.tenant_id
          and physical.id = execution.child_session_id::text
      ),
      'laneExists', exists (
        select 1
        from pi_session_lanes lane
        where lane.tenant_id = execution.tenant_id
          and lane.session_id = child.pi_session_id
          and lane.lane = child.pi_session_lane
      ),
      'inheritedReferenceCount', (
        select count(*)
        from pi_session_entry_refs ref
        where ref.tenant_id = execution.tenant_id
          and ref.session_id = execution.child_session_id::text
      ),
      'childOwnedEntryCount', (
        select count(*)
        from pi_session_entries entry
        where entry.tenant_id = execution.tenant_id
          and entry.session_id = child.pi_session_id
          and entry.turn_id in (
            select turn.id
            from turns turn
            where turn.tenant_id = execution.tenant_id
              and turn.session_id = execution.child_session_id
          )
      ),
      'workspaceKind', child_workspace.workspace_kind,
      'workspaceDeleted', child_workspace.deleted_at is not null
    )::text
    from subagent_executions as execution
    join runs as parent_run on parent_run.id = execution.parent_run_id
    join run_attempts as parent_attempt on parent_attempt.id = parent_run.current_attempt_id
    join runs as child_run on child_run.id = execution.child_run_id
    join sessions as child on child.id = execution.child_session_id
    join run_attempts as child_attempt on child_attempt.id = child_run.current_attempt_id
    join workspaces as child_workspace on child_workspace.id = child_run.workspace_id
    where execution.parent_run_id = ${sqlLiteral(parentRunId)}
    order by execution.created_at desc
    limit 1
  `);
  assert(value, `Parent Run ${parentRunId} produced no durable Subagent execution`);
  return JSON.parse(value);
}

async function recursiveTreeEvidence(rootRunId) {
  const value = await psql(`
    select coalesce(json_agg(json_build_object(
      'executionId', execution.id,
      'parentExecutionId', execution.parent_execution_id,
      'rootSessionId', execution.root_session_id,
      'rootRunId', execution.root_run_id,
      'depth', execution.depth,
      'state', execution.state,
      'childSessionId', execution.child_session_id,
      'childRunId', execution.child_run_id,
      'childRunState', child_run.state,
      'piSessionId', child.pi_session_id,
      'piSessionLane', child.pi_session_lane,
      'contextBaseEntryId', execution.pi_context_base_entry_id
    ) order by execution.depth, execution.created_at), '[]'::json)::text
    from subagent_executions as execution
    join runs as child_run on child_run.id = execution.child_run_id
    join sessions as child on child.id = execution.child_session_id
    where execution.root_run_id = ${sqlLiteral(rootRunId)}
  `);
  return JSON.parse(value);
}

async function parallelExecutionEvidence(parentRunId) {
  const value = await psql(`
    select coalesce(json_agg(json_build_object(
      'executionId', execution.id,
      'childSessionId', execution.child_session_id,
      'childRunId', execution.child_run_id,
      'childRunState', child_run.state,
      'piSessionId', child.pi_session_id,
      'piSessionLane', child.pi_session_lane,
      'contextBaseEntryId', execution.pi_context_base_entry_id,
      'childPhysicalSessionExists', exists (
        select 1 from pi_sessions physical
        where physical.tenant_id = execution.tenant_id
          and physical.id = execution.child_session_id::text
      ),
      'laneExists', exists (
        select 1 from pi_session_lanes lane
        where lane.tenant_id = execution.tenant_id
          and lane.session_id = child.pi_session_id
          and lane.lane = child.pi_session_lane
      ),
      'inheritedReferenceCount', (
        select count(*) from pi_session_entry_refs ref
        where ref.tenant_id = execution.tenant_id
          and ref.session_id = execution.child_session_id::text
      ),
      'childOwnedEntryCount', (
        select count(*) from pi_session_entries entry
        where entry.tenant_id = execution.tenant_id
          and entry.session_id = child.pi_session_id
          and entry.turn_id in (
            select turn.id from turns turn
            where turn.tenant_id = execution.tenant_id
              and turn.session_id = execution.child_session_id
          )
      )
    ) order by execution.created_at), '[]'::json)::text
    from subagent_executions execution
    join runs child_run on child_run.id = execution.child_run_id
    join sessions child on child.id = execution.child_session_id
    where execution.parent_run_id = ${sqlLiteral(parentRunId)}
  `);
  return JSON.parse(value);
}

async function childCreatedToolRuntime(childRunId) {
  const value = await psql(`
    select exists (
      select 1
      from tool_broker_workspace_runtimes
      where run_id = ${sqlLiteral(childRunId)}
    )::text
  `);
  return value === "t";
}

function assertLaneBacked(evidence, rootPiSessionId) {
  assert.equal(evidence.piSessionId, rootPiSessionId);
  assert.match(evidence.piSessionLane, /^subagent-[0-9a-f-]{36}$/u);
  assert.equal(evidence.childPhysicalSessionExists, false);
  assert.equal(evidence.laneExists, true);
  assert.equal(evidence.inheritedReferenceCount, 0);
  assert(evidence.childOwnedEntryCount > 0);
}

await retireHistoricalAcceptanceCubes();
const suffix = `${Date.now().toString(36)}`;
const registration = await new PiCloudApi(fetchFromProduction).registerTenant(
  `subagent-${suffix}`.slice(0, 63),
  "Subagent production acceptance",
);
api = new PiCloudApi(fetchFromProduction, registration.apiToken);
authorizationToken = registration.apiToken;
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must use a real model");
const acceptanceModel = {
  provider: "openai-codex",
  modelId: "gpt-5.6-luna",
  thinkingLevel: "low",
  fastMode: false,
};
const project = await api.createProject(`Subagent production acceptance ${suffix}`);
const session = await api.createSession(
  project.projectId,
  project.workspaceId,
  `Subagent production acceptance ${suffix}`,
  "elastic",
);
await api.updateSessionModel(session.sessionId, acceptanceModel);

try {
  const none = await runTurn(
    session.sessionId,
    [
      "Call the subagent Tool exactly once and do not call any file or bash Tool.",
      'Use this exact workflowScript: return runs.run("none", {agent:"cloud-child", context:"fresh", tools:[], task:"Reply exactly SUBAGENT-NONE-OK"})',
      "After it finishes, reply with SUBAGENT-NONE-OK.",
    ].join(" "),
  );
  const noneEvidence = await executionEvidence(none.accepted.runId);
  assert.equal(noneEvidence.workspaceMode, "none");
  assert.equal(noneEvidence.childRunState, "completed");
  assert.equal(noneEvidence.contextBaseEntryId, null);
  assertLaneBacked(noneEvidence, session.sessionId);

  const lazy = await runTurn(
    session.sessionId,
    [
      "Call the subagent Tool exactly once and do not call any file or bash Tool yourself.",
      'Use this exact workflowScript: return runs.run("lazy", {agent:"cloud-child", context:"fresh", tools:["read","write","edit","bash"], task:"Do not call any local Tool. Reply exactly SUBAGENT-LAZY-OK"})',
      "After it finishes, reply with SUBAGENT-LAZY-OK.",
    ].join(" "),
  );
  const lazyEvidence = await executionEvidence(lazy.accepted.runId);
  assert.equal(lazyEvidence.workspaceMode, "shared");
  assert.equal(lazyEvidence.childRunState, "completed");
  assert.equal(lazyEvidence.contextBaseEntryId, null);
  assertLaneBacked(lazyEvidence, session.sessionId);
  assert.equal(
    await childCreatedToolRuntime(lazyEvidence.childRunId),
    false,
    "A Tool-capable Child that used no local Tool eagerly created Cube capacity",
  );

  const parallel = await runTurn(
    session.sessionId,
    [
      "Call the subagent Tool exactly once and run exactly two independent children in parallel.",
      'Use this exact workflowScript: return runs.all([{key:"left", agent:"cloud-child", context:"fresh", tools:[], task:"Reply exactly SUBAGENT-PARALLEL-LEFT"}, {key:"right", agent:"cloud-child", context:"fresh", tools:[], task:"Reply exactly SUBAGENT-PARALLEL-RIGHT"}])',
      "After both finish, reply exactly SUBAGENT-PARALLEL-OK.",
    ].join(" "),
  );
  const parallelEvidence = await parallelExecutionEvidence(parallel.accepted.runId);
  assert.equal(parallelEvidence.length, 2, JSON.stringify(parallelEvidence));
  for (const child of parallelEvidence) {
    assert.equal(child.childRunState, "completed");
    assert.equal(child.contextBaseEntryId, null);
    assertLaneBacked(child, session.sessionId);
  }
  assert.equal(new Set(parallelEvidence.map((child) => child.piSessionLane)).size, 2);

  const shared = await runTurn(
    session.sessionId,
    [
      "First use bash to write exactly SHARED-PARENT-OK into /workspace/shared-parent-marker.txt.",
      "Then call the subagent Tool exactly once with worktree:false.",
      'Use this exact workflowScript: return runs.run("shared", {agent:"cloud-child", context:"fresh", tools:["read","bash"], task:"Use bash to read /workspace/shared-parent-marker.txt and reply exactly SHARED-CHILD-OK if it contains SHARED-PARENT-OK"})',
      "After it finishes, reply with SHARED-CHILD-OK.",
    ].join(" "),
  );
  const sharedEvidence = await executionEvidence(shared.accepted.runId);
  assert.equal(sharedEvidence.workspaceMode, "shared");
  assert.equal(sharedEvidence.childWorkspaceId, sharedEvidence.parentWorkspaceId);
  assert.equal(sharedEvidence.childRunState, "completed");
  assert.equal(sharedEvidence.contextBaseEntryId, null);
  assertLaneBacked(sharedEvidence, session.sessionId);

  const isolated = await runTurn(
    session.sessionId,
    [
      "Call the subagent Tool exactly once with worktree:true.",
      'Use this exact workflowScript: return runs.run("isolated", {agent:"cloud-child", context:"branch", tools:["read","write","edit","bash"], worktree:true, task:"Use bash to create /workspace/isolated-child-only.txt containing ISOLATED-CHILD-OK, read it back, and reply exactly ISOLATED-CHILD-OK"})',
      "Do not create isolated-child-only.txt yourself. After the child finishes, reply with ISOLATED-CHILD-OK.",
    ].join(" "),
  );
  const isolatedEvidence = await executionEvidence(isolated.accepted.runId);
  assert.equal(isolatedEvidence.workspaceMode, "isolated");
  assert.notEqual(isolatedEvidence.childWorkspaceId, isolatedEvidence.parentWorkspaceId);
  assert.equal(isolatedEvidence.workspaceKind, "subagent_isolated");
  assert.equal(isolatedEvidence.workspaceDeleted, true);
  assert(isolatedEvidence.contextBaseEntryId);
  assertLaneBacked(isolatedEvidence, session.sessionId);

  const nestedTask = [
    "Call the subagent Tool exactly once and do not call file or bash Tools.",
    'Use this exact workflowScript: return runs.run("nested", {agent:"cloud-child", context:"fresh", tools:[], task:"Reply exactly SUBAGENT-NESTED-LEAF-OK"})',
    "After it finishes, reply exactly SUBAGENT-NESTED-PARENT-OK.",
  ].join(" ");
  const recursive = await runTurn(
    session.sessionId,
    [
      "Create a two-level recursive Agent tree.",
      `Call the subagent Tool exactly once with this exact workflowScript: return runs.run("recursive-parent", {agent:"cloud-child", context:"fresh", tools:[], task:${JSON.stringify(nestedTask)}})`,
      "After it finishes, reply exactly SUBAGENT-RECURSIVE-OK.",
    ].join(" "),
  );
  const recursiveEvidence = await recursiveTreeEvidence(recursive.accepted.runId);
  assert.equal(recursiveEvidence.length, 2, JSON.stringify(recursiveEvidence));
  assert.deepEqual(
    recursiveEvidence.map((execution) => execution.depth),
    [1, 2],
  );
  assert(recursiveEvidence.every((execution) => execution.rootRunId === recursive.accepted.runId));
  assert(recursiveEvidence.every((execution) => execution.childRunState === "completed"));
  assert(recursiveEvidence.every((execution) => execution.piSessionId === session.sessionId));
  assert(
    recursiveEvidence.every((execution) =>
      /^subagent-[0-9a-f-]{36}$/u.test(execution.piSessionLane),
    ),
  );
  assert.equal(recursiveEvidence[0].parentExecutionId, null);
  assert.equal(recursiveEvidence[1].parentExecutionId, recursiveEvidence[0].executionId);
  const conversationList = await api.listConversations();
  const projectedRecursiveSessions = new Set(
    conversationList.delegatedSessions
      .filter((delegated) => delegated.rootSessionId === session.sessionId)
      .map((delegated) => delegated.sessionId),
  );
  assert(projectedRecursiveSessions.has(recursiveEvidence[0].childSessionId));
  assert(projectedRecursiveSessions.has(recursiveEvidence[1].childSessionId));
  const fullTree = await api.getConversationTree(session.sessionId, "full");
  assert(
    fullTree.branches.some(
      (branch) =>
        branch.sessionId === recursiveEvidence[1].childSessionId &&
        branch.parentSessionId === recursiveEvidence[0].childSessionId,
    ),
    "Whole-tree projection did not preserve the recursive execution edge",
  );
  const focusedTree = await api.getConversationTree(recursiveEvidence[1].childSessionId, "focus");
  assert.equal(focusedTree.rootSessionId, recursiveEvidence[1].childSessionId);
  assert.equal(focusedTree.currentSessionId, recursiveEvidence[1].childSessionId);

  const tenantId = await psql(
    `select tenant_id::text from sessions where id = ${sqlLiteral(session.sessionId)}`,
  );
  const volumeId = workspaceVolumeId({ tenantId, workspaceId: session.workspaceId });
  const possibleParentFile = resolve(
    runtimeDirectory,
    "state/cube-shared/volume",
    `picloud-posix-${volumeId}`,
    "workspace/isolated-child-only.txt",
  );
  await assert.rejects(access(possibleParentFile), (error) => error?.code === "ENOENT");

  const report = {
    accepted: true,
    checkedAt: new Date().toISOString(),
    model: acceptanceModel,
    parentSessionId: session.sessionId,
    modes: {
      none: noneEvidence,
      lazyToolCapable: lazyEvidence,
      parallel: parallelEvidence,
      shared: sharedEvidence,
      isolated: isolatedEvidence,
    },
    recursiveTree: recursiveEvidence,
    productProjection: {
      listContainsEveryRecursiveSession: true,
      fullTreePreservesNestedParent: true,
      nestedFocusRoot: focusedTree.rootSessionId,
    },
  };
  await mkdir(resolve(repositoryRoot, "docs/reports"), { recursive: true });
  await writeFile(
    resolve(repositoryRoot, "docs/reports/subagent-production-acceptance-latest.json"),
    await format(JSON.stringify(report), { parser: "json" }),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await api
    .deleteConversation(session.sessionId, newIdempotencyKey("delete"))
    .catch(() => undefined);
  await api
    .deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"))
    .catch(() => undefined);
}
