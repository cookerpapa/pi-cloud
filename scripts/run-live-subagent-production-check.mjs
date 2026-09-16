import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readPrivateRuntimeFile as readPrivate } from "./lib/runtime-file-policy.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { workspaceVolumeId } from "../packages/tool-broker/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { snapshotTurn } from "./lib/session-snapshot.mjs";
import {
  isDurableAgentActivity,
  localWorkerProcesses,
  readWorkerModelTimings,
  runStageTiming,
} from "./lib/live-run-timing.mjs";

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
const measurements = [];

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
  const startedAt = performance.now();
  const submittedWallAt = Date.now();
  const sequence = measurements.length + 1;
  let firstVisibleMs = null,
    firstTextMs = null;
  process.stdout.write(`subagent_live_turn_started ${sequence}\n`);
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("subagent-live"));
  const controller = new AbortController();
  const admissionMs = performance.now() - startedAt;
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  const text = [];
  let terminal;
  let firstAssistantTextEmittedAtMs, firstAssistantTextReceivedAtMs;
  const observeEvent = (event) => {
    if (event.turnId !== accepted.turnId) return;
    if (isDurableAgentActivity(event) && firstVisibleMs === null)
      firstVisibleMs = performance.now() - startedAt;
    if (event.type === "assistant.text.delta" && firstTextMs === null) {
      firstTextMs = performance.now() - startedAt;
      firstAssistantTextEmittedAtMs = Date.parse(event.occurredAt);
      firstAssistantTextReceivedAtMs = Date.now();
    }
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
        const restored = snapshotTurn(snapshot, accepted.turnId);
        if (restored?.text && firstTextMs === null) {
          firstTextMs = performance.now() - startedAt;
          firstVisibleMs ??= firstTextMs;
        }
        text.splice(0, text.length, ...(restored?.text ? [restored.text] : []));
        if (restored?.terminal) {
          terminal = restored.terminal;
          controller.abort();
        }
      },
      onEvent: observeEvent,
    });
    assert.equal(terminal?.type, "turn.completed", JSON.stringify(terminal?.payload));
    await waitForRun(accepted.runId);
    const timing = {
      sequence,
      submittedWallAt,
      admissionMs,
      firstVisibleMs,
      firstTextMs,
      settledMs: performance.now() - startedAt,
    };
    const transport = await readWorkerModelTimings([accepted.runId], submittedWallAt);
    timing.stages = runStageTiming(
      {
        submittedWallAt,
        firstAssistantTextMs: firstTextMs ?? undefined,
        firstAssistantTextEmittedAtMs,
        firstAssistantTextReceivedAtMs,
      },
      transport,
    );
    measurements.push(timing);
    process.stdout.write(`subagent_live_turn_finished ${JSON.stringify(timing)}\n`);
    return { accepted, text: text.join("") };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function executionEvidence(parentRunId, executionId) {
  const value = await psql(`
    select json_build_object(
      'executionId', execution.id,
      'sandboxMode', execution.sandbox_mode,
      'state', execution.state,
      'childSessionId', execution.child_session_id,
      'childRunId', execution.child_run_id,
      'parentWorkspaceId', parent_run.workspace_id,
      'childWorkspaceId', child_run.workspace_id,
      'computeSessionId', child_run.compute_session_id,
      'cwd', child_run.working_directory,
      'parentRuntimeId', (select runtime_id from tool_broker_workspace_runtimes where tenant_id=execution.tenant_id and workspace_id=parent_run.workspace_id and compute_session_id is not distinct from parent_run.compute_session_id order by created_at desc limit 1),
      'childRuntimeId', (select runtime_id from tool_broker_workspace_runtimes where tenant_id=execution.tenant_id and workspace_id=child_run.workspace_id and compute_session_id is not distinct from child_run.compute_session_id order by created_at desc limit 1),
      'childRunState', child_run.state,
      'parentWorker', parent_attempt.claim_owner_id,
      'childWorker', child_attempt.claim_owner_id,
      'sameWorker', parent_attempt.claim_owner_id = child_attempt.claim_owner_id,
      'sameOwnerLease', parent_attempt.lease_id = child_attempt.lease_id
        and parent_attempt.fencing_token = child_attempt.fencing_token,
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
      ${executionId === undefined ? "" : `and execution.id = ${sqlLiteral(executionId)}`}
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
      'rootWorker', root_attempt.claim_owner_id,
      'computeSessionId', child_run.compute_session_id,
      'cwd', child_run.working_directory,
      'runtimeId', (select runtime_id from tool_broker_workspace_runtimes where tenant_id=execution.tenant_id and workspace_id=child_run.workspace_id and compute_session_id is not distinct from child_run.compute_session_id order by created_at desc limit 1),
      'childWorker', child_attempt.claim_owner_id,
      'sameWorker', root_attempt.claim_owner_id = child_attempt.claim_owner_id,
      'sameOwnerLease', root_attempt.lease_id = child_attempt.lease_id
        and root_attempt.fencing_token = child_attempt.fencing_token,
      'piSessionId', child.pi_session_id,
      'piSessionLane', child.pi_session_lane,
      'contextBaseEntryId', execution.pi_context_base_entry_id
    ) order by execution.depth, execution.created_at), '[]'::json)::text
    from subagent_executions as execution
    join runs as root_run on root_run.id = execution.root_run_id
    join run_attempts as root_attempt on root_attempt.id = root_run.current_attempt_id
    join runs as child_run on child_run.id = execution.child_run_id
    join run_attempts as child_attempt on child_attempt.id = child_run.current_attempt_id
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
      'parentWorker', parent_attempt.claim_owner_id,
      'childWorker', child_attempt.claim_owner_id,
      'sameWorker', parent_attempt.claim_owner_id = child_attempt.claim_owner_id,
      'piSessionId', child.pi_session_id,
      'sameOwnerLease', parent_attempt.lease_id = child_attempt.lease_id
        and parent_attempt.fencing_token = child_attempt.fencing_token,
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
    join runs parent_run on parent_run.id = execution.parent_run_id
    join run_attempts parent_attempt on parent_attempt.id = parent_run.current_attempt_id
    join runs child_run on child_run.id = execution.child_run_id
    join run_attempts child_attempt on child_attempt.id = child_run.current_attempt_id
    join sessions child on child.id = execution.child_session_id
    where execution.parent_run_id = ${sqlLiteral(parentRunId)}
  `);
  return JSON.parse(value);
}

async function childUsedLocalTools(childRunId) {
  const value = await psql(`
    select exists (
      select 1
      from pi_session_entries pe join runs r on r.turn_id=pe.turn_id
      where r.id = ${sqlLiteral(childRunId)} and pe.type='message'
        and pe.payload->'message'->>'role'='toolResult'
        and pe.payload->'message'->>'toolName' in ('read','write','edit','bash')
        and pe.payload->'message'->>'isError'='false'
    )::text
  `);
  return value === "true";
}

function assertLaneBacked(evidence, rootPiSessionId) {
  assert.equal(evidence.piSessionId, rootPiSessionId);
  assert.match(evidence.piSessionLane, /^subagent-[0-9a-f-]{36}$/u);
  assert.equal(evidence.childPhysicalSessionExists, false);
  assert.equal(evidence.laneExists, true);
  assert.equal(evidence.inheritedReferenceCount, 0);
  assert(evidence.childOwnedEntryCount > 0);
  assert.equal(evidence.sameWorker, true);
  assert.equal(evidence.sameOwnerLease, true);
}

const suffix = `${Date.now().toString(36)}`;
const testRevision = await capture("git", ["rev-parse", "HEAD"]);
const workerImages = (await localWorkerProcesses()).map(({ name, image }) => ({ name, image }));
assert(workerImages.length > 0, "No live Worker for Subagent acceptance");
const registration = await new PiCloudApi(fetchFromProduction).registerTenant(
  `subagent-${suffix}`.slice(0, 63),
  "Subagent production acceptance",
);
api = new PiCloudApi(fetchFromProduction, registration.apiToken);
authorizationToken = registration.apiToken;
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Production tenant must use a real model");
const testProvider = process.env.PI_CLOUD_LIVE_SUBAGENT_PROVIDER ?? "deepseek";
assert(["deepseek", "openai-codex"].includes(testProvider), "Unsupported Subagent test Provider");
const acceptanceModel = {
  provider: testProvider,
  modelId: testProvider === "deepseek" ? "deepseek-v4-pro" : "gpt-5.6-luna",
  thinkingLevel: "low",
  fastMode: false,
};
let project, session, primaryFailure;
let cleanupAttempted = false;
async function cleanup() {
  cleanupAttempted = true;
  if (process.env.PI_CLOUD_LIVE_KEEP_FIXTURES === "1") return;
  const errors = [];
  if (session) {
    try {
      const active = (turn) => ["queued", "running", "cancelling"].includes(turn.state);
      for (const turn of (await api.getConversation(session.sessionId)).turns.filter(active))
        if (turn.state !== "cancelling")
          await api.cancelTurn(session.sessionId, turn.turnId, newIdempotencyKey("cancel"));
      const deadline = performance.now() + 120000;
      while ((await api.getConversation(session.sessionId)).turns.some(active)) {
        if (performance.now() > deadline) throw new Error("Subagent fixture did not retire");
        await wait(200);
      }
      await api.deleteConversation(session.sessionId, newIdempotencyKey("delete"));
    } catch (error) {
      errors.push(error);
    }
  }
  if (project) {
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete"));
    } catch (error) {
      errors.push(error);
    }
  }
  const credentialId = registration.apiToken.slice(4, registration.apiToken.indexOf("."));
  try {
    await psql(`update tenant_api_credentials set revoked_at=clock_timestamp()
      where tenant_id=${sqlLiteral(registration.tenantId)} and credential_id=${sqlLiteral(credentialId)}`);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, "Subagent acceptance cleanup failed", { cause: errors[0] });
}

try {
  project = await api.createProject(`Subagent production acceptance ${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Subagent production acceptance ${suffix}`,
    "elastic",
    "starter",
  );
  await api.updateSessionModel(session.sessionId, acceptanceModel);
  process.stdout.write(
    `${JSON.stringify({ event: "subagent_acceptance_fixture", sessionId: session.sessionId, workspaceId: project.workspaceId })}\n`,
  );

  const none = await runTurn(
    session.sessionId,
    [
      "Call the subagent Tool exactly once and do not call any file or bash Tool.",
      'Use subagent with action:"run", context:"fresh", tools:[], task:"Reply exactly SUBAGENT-NONE-OK". Do not use workflow.',
      "After it finishes, reply with SUBAGENT-NONE-OK.",
    ].join(" "),
  );
  const noneEvidence = await executionEvidence(none.accepted.runId);
  assert.equal(noneEvidence.sandboxMode, "none");
  assert.equal(noneEvidence.childRunState, "completed");
  assert.equal(noneEvidence.contextBaseEntryId, null);
  assertLaneBacked(noneEvidence, session.sessionId);

  const lazy = await runTurn(
    session.sessionId,
    [
      "Call the subagent Tool exactly once and do not call any file or bash Tool yourself.",
      'Use subagent with action:"run", context:"fresh", sandbox:"ephemeral", tools:["bash"], task:"Do not call any local Tool. Reply exactly SUBAGENT-LAZY-OK". Keep the bash capability enabled but unused; do not pass tools:[].',
      "After it finishes, reply with SUBAGENT-LAZY-OK.",
    ].join(" "),
  );
  const lazyEvidence = await executionEvidence(lazy.accepted.runId);
  assert.equal(lazyEvidence.sandboxMode, "ephemeral");
  assert.equal(lazyEvidence.childRunState, "completed");
  assert.equal(lazyEvidence.contextBaseEntryId, null);
  assertLaneBacked(lazyEvidence, session.sessionId);
  assert.equal(
    await childUsedLocalTools(lazyEvidence.childRunId),
    false,
    "A pure research Child unexpectedly used local Tools",
  );
  assert.equal(
    await psql(
      `select count(*) from tool_broker_workspace_runtimes where workspace_id=${sqlLiteral(project.workspaceId)}`,
    ),
    "0",
    "The first two research-only Turns eagerly activated Cube",
  );

  const parallel = await runTurn(
    session.sessionId,
    [
      "Call the subagent Tool exactly once and run exactly two independent children in parallel.",
      'Use subagent action:"workflow" with script: return runs.all([{key:"left", context:"fresh", tools:[], task:"Reply exactly SUBAGENT-PARALLEL-LEFT"}, {key:"right", context:"fresh", tools:[], task:"Reply exactly SUBAGENT-PARALLEL-RIGHT"}]);',
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
      "Then call the subagent Tool exactly once with action:run and sandbox:shared.",
      'Use subagent with action:"run", context:"fresh", sandbox:"shared", task:"Use bash to read /workspace/shared-parent-marker.txt and reply exactly SHARED-CHILD-OK if it contains SHARED-PARENT-OK".',
      "After it finishes, reply with SHARED-CHILD-OK.",
    ].join(" "),
  );
  const sharedEvidence = await executionEvidence(shared.accepted.runId);
  assert.equal(sharedEvidence.sandboxMode, "shared");
  assert.equal(sharedEvidence.childWorkspaceId, sharedEvidence.parentWorkspaceId);
  assert.equal(sharedEvidence.childRunState, "completed");
  assert.equal(sharedEvidence.contextBaseEntryId, null);
  assert(sharedEvidence.parentRuntimeId);
  assert.equal(sharedEvidence.childRuntimeId, sharedEvidence.parentRuntimeId);
  assertLaneBacked(sharedEvidence, session.sessionId);

  const ephemeral = await runTurn(
    session.sessionId,
    [
      "Use bash to create /workspace/project, git init -b main there, configure repository-local user.name Audit and user.email audit@example.invalid, create README.md, git add and commit the baseline.",
      "Use git -C /workspace/project worktree add -b feature-a /workspace/worktrees/feature-a. Do not copy files or clone another repository.",
      'Then call subagent action:"workflow" exactly once with script: return runs.run("feature-a", {context:"branch", sandbox:"ephemeral", cwd:"/workspace/worktrees/feature-a", task:"Use bash to verify pwd is /workspace/worktrees/feature-a. Create feature.py implementing add(a,b), with executable assertions for zero, negative and positive integers. Run python3 feature.py. Write feature-marker.txt containing WORKTREE-CHILD-OK. git add feature.py feature-marker.txt and git commit locally. Reply WORKTREE-CHILD-OK. Do not create more subagents."});',
      "After the child finishes, YOU must git -C /workspace/project merge --ff-only feature-a, run python3 /workspace/project/feature.py and read /workspace/project/feature-marker.txt. Do not create or edit the child files yourself. Only after the tests pass, reply WORKTREE-MERGED-OK.",
    ].join(" "),
  );
  const ephemeralEvidence = await executionEvidence(ephemeral.accepted.runId);
  assert.equal(ephemeralEvidence.sandboxMode, "ephemeral");
  assert.equal(ephemeralEvidence.childWorkspaceId, ephemeralEvidence.parentWorkspaceId);
  assert.equal(ephemeralEvidence.computeSessionId, ephemeralEvidence.childSessionId);
  assert.equal(ephemeralEvidence.cwd, "/workspace/worktrees/feature-a");
  assert.equal(ephemeralEvidence.workspaceKind, "user");
  assert.equal(ephemeralEvidence.workspaceDeleted, false);
  assert(ephemeralEvidence.parentRuntimeId && ephemeralEvidence.childRuntimeId);
  assert.notEqual(ephemeralEvidence.childRuntimeId, ephemeralEvidence.parentRuntimeId);
  assert(ephemeralEvidence.contextBaseEntryId);
  assert.match(ephemeral.text, /WORKTREE-MERGED-OK/u);
  assertLaneBacked(ephemeralEvidence, session.sessionId);

  const parallelCompute = await runTurn(
    session.sessionId,
    [
      "In /workspace/project use git worktree add to create branches parallel-left and parallel-right at /workspace/worktrees/left and /workspace/worktrees/right from current main.",
      'Call subagent action:"workflow" exactly once with script: return runs.all([ {key:"left",context:"fresh",sandbox:"ephemeral",cwd:"/workspace/worktrees/left",task:"Use bash to check pwd. Write left.py defining double(x)=x*2 with executable assertions; run python3 left.py, then git add left.py and git commit. Do not create subagents. Reply LEFT-OK."}, {key:"right",context:"branch",sandbox:"ephemeral",cwd:"/workspace/worktrees/right",task:"Use bash to check pwd. Write right.py defining square(x)=x*x with executable assertions; run python3 right.py, then git add right.py and git commit. Do not create subagents. Reply RIGHT-OK."} ]);',
      "Wait for BOTH children. Then merge both branches locally into /workspace/project (use --no-edit), run python3 left.py and python3 right.py there. Do not create the files yourself. Reply PARALLEL-WORKTREES-MERGED only after both tests pass.",
    ].join(" "),
  );
  const parallelComputeChildren = await parallelExecutionEvidence(parallelCompute.accepted.runId);
  assert.equal(parallelComputeChildren.length, 2);
  const parallelComputeEvidence = [];
  for (const child of parallelComputeChildren) {
    const evidence = await executionEvidence(parallelCompute.accepted.runId, child.executionId);
    assert.equal(evidence.childRunState, "completed");
    assert.equal(evidence.sandboxMode, "ephemeral");
    assert.equal(evidence.childWorkspaceId, project.workspaceId);
    assert.equal(evidence.computeSessionId, evidence.childSessionId);
    assert(evidence.childRuntimeId && evidence.parentRuntimeId);
    assert.notEqual(evidence.childRuntimeId, evidence.parentRuntimeId);
    assertLaneBacked(evidence, session.sessionId);
    parallelComputeEvidence.push(evidence);
  }
  assert.equal(new Set(parallelComputeEvidence.map((child) => child.childRuntimeId)).size, 2);
  assert.deepEqual(parallelComputeEvidence.map((child) => child.cwd).sort(), [
    "/workspace/worktrees/left",
    "/workspace/worktrees/right",
  ]);
  assert.match(parallelCompute.text, /PARALLEL-WORKTREES-MERGED/u);

  const nestedComputeTask = [
    "Use bash to verify pwd is /workspace/worktrees/feature-a.",
    'Call subagent action:"run" once with context:"fresh", sandbox:"shared", task:"Use bash to verify pwd is /workspace/worktrees/feature-a. Write nested-shared.txt containing NESTED-COMPUTE-OK and read it back. Do not create subagents. Reply NESTED-COMPUTE-OK.".',
    "Wait for the actual result, then read nested-shared.txt yourself and reply NESTED-COMPUTE-OK.",
  ].join(" ");
  const nestedCompute = await runTurn(
    session.sessionId,
    [
      `Call subagent action:"run" exactly once with context:"fresh", sandbox:"ephemeral", cwd:"/workspace/worktrees/feature-a", task:${JSON.stringify(nestedComputeTask)}.`,
      "After it returns, read /workspace/worktrees/feature-a/nested-shared.txt using bash and reply NESTED-COMPUTE-OK.",
    ].join(" "),
  );
  const nestedComputeEvidence = await recursiveTreeEvidence(nestedCompute.accepted.runId);
  assert.equal(nestedComputeEvidence.length, 2);
  const nestedRoot = nestedComputeEvidence.find((e) => e.depth === 1);
  const nestedLeaf = nestedComputeEvidence.find((e) => e.depth === 2);
  assert(nestedRoot && nestedLeaf && nestedRoot.runtimeId);
  for (const child of nestedComputeEvidence) {
    assert.equal(child.childRunState, "completed");
    assert.equal(child.computeSessionId, nestedRoot.childSessionId);
    assert.equal(child.runtimeId, nestedRoot.runtimeId);
    assert.equal(child.cwd, "/workspace/worktrees/feature-a");
    assert.equal(child.sameWorker, true);
    assert.equal(child.sameOwnerLease, true);
  }
  assert.match(nestedCompute.text, /NESTED-COMPUTE-OK/u);

  const nestedTask = [
    "Call the subagent Tool exactly once and do not call file or bash Tools.",
    'Use subagent with action:"run", context:"fresh", tools:[], task:"Reply exactly SUBAGENT-NESTED-LEAF-OK".',
    "After it finishes, reply exactly SUBAGENT-NESTED-PARENT-OK.",
  ].join(" ");
  const recursive = await runTurn(
    session.sessionId,
    [
      "Create a two-level recursive Agent tree.",
      `Call the subagent Tool exactly once with action:"run", context:"fresh", tools:[], task:${JSON.stringify(nestedTask)}.`,
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
  assert(recursiveEvidence.every((execution) => execution.sameWorker === true));
  assert(recursiveEvidence.every((execution) => execution.sameOwnerLease === true));
  assert(
    recursiveEvidence.every((execution) =>
      /^subagent-[0-9a-f-]{36}$/u.test(execution.piSessionLane),
    ),
  );
  assert.equal(recursiveEvidence[0].parentExecutionId, null);
  assert.equal(recursiveEvidence[1].parentExecutionId, recursiveEvidence[0].executionId);

  const coding = await runTurn(
    session.sessionId,
    [
      'Use subagent action:"workflow" and runs.all to delegate two parallel fresh/shared coding tasks.',
      "One child must create insertion_sort.py with an insertion_sort function and executable unittest cases for empty, sorted, reversed, negative and duplicate inputs.",
      "The other must create binary_search.py with binary_search returning an index or -1, with executable unittest cases for hits, misses, empty and duplicate inputs.",
      "Each child must write its own file and run python3 on that file. The workflow must return both child results.",
      "Then YOU must use bash to run python3 insertion_sort.py && python3 binary_search.py in the current workspace.",
      "Only after observing both pass, answer SUBAGENT-CODING-OK. Do not recreate the files yourself.",
    ].join(" "),
  );
  const codingEvidence = await parallelExecutionEvidence(coding.accepted.runId);
  assert.equal(codingEvidence.length, 2);
  assert(codingEvidence.every((child) => child.childRunState === "completed"));
  assert.match(coding.text, /SUBAGENT-CODING-OK/u);
  for (const child of codingEvidence) {
    assertLaneBacked(child, session.sessionId);
    assert.equal(await childUsedLocalTools(child.childRunId), true);
  }

  const messageMarker = `MAILBOX-${suffix}`;
  const messageScript = `const child = runs.run("receiver", {context:"fresh",sandbox:"shared",task:"First use bash to sleep 3 seconds. Then reply with the secret code received in an Agent message. The code is not in this initial task. Do not read files to look for the code. If no message arrives, say MISSING and finish."}); const receipt = await runs.send("receiver", ${JSON.stringify(messageMarker)}, "steer"); return {receipt, child:await child};`;
  const messaging = await runTurn(
    session.sessionId,
    `Call subagent action:workflow exactly once with this script: ${messageScript} Then briefly report the child result.`,
  );
  const messagingEvidence = await executionEvidence(messaging.accepted.runId);
  assert.equal(messagingEvidence.childRunState, "completed");
  const mailboxEvidence = JSON.parse(
    await psql(`select json_build_object(
    'commands', count(*), 'consumed', count(input_consumed_at),
    'nativeEntries', (select count(*) from pi_session_entries where session_id=${sqlLiteral(session.sessionId)}
      and id like 'pc-agent-input-%')) from subagent_control_commands
    where run_id=${sqlLiteral(messaging.accepted.runId)} and command->'request'->>'action'='send'`),
  );
  assert.equal(mailboxEvidence.commands, 1);
  assert.equal(mailboxEvidence.consumed, 1);
  assert.equal(mailboxEvidence.nativeEntries, 1);
  assert.match(messaging.text, new RegExp(messageMarker));

  const supervisor = await runTurn(
    session.sessionId,
    [
      "Delegate one fresh child with tools:[] using action:run.",
      "Its task is: Call contact_supervisor with reason need_decision and ask for the approved colour; wait for the reply and answer with that colour.",
      'When the child returns blocked, use subagent_supervisor action:reply with its replyTo request ID and message "APPROVED-TEAL".',
      "Do not launch another child. Wait for the actual child response, then answer SUPERVISOR-TEAL-OK.",
    ].join(" "),
  );
  const supervisorEvidence = await executionEvidence(supervisor.accepted.runId);
  assert.equal(supervisorEvidence.childRunState, "completed");
  assert.match(supervisor.text, /SUPERVISOR-TEAL-OK/u);
  const supervisorReplied = await psql(
    `select count(*) from subagent_supervisor_requests where execution_id=${sqlLiteral(supervisorEvidence.executionId)} and reply_message='APPROVED-TEAL'`,
  );
  assert.equal(supervisorReplied, "1");

  const cancelled = await runTurn(
    session.sessionId,
    [
      "Call subagent action:workflow exactly once with this script:",
      'const child=runs.run("cancel-me", {context:"fresh",tools:[],task:"Write a detailed 6000-word comparison of sorting algorithms. Do not use tools."}).catch(error => error.result || {state:"failed",error:error.message}); await new Promise(resolve=>setTimeout(resolve,2000)); const cancellation=await runs.cancel("cancel-me"); return {cancellation,child:await child};',
      "After cancellation is confirmed, reply SUBAGENT-CANCEL-OK. Do not start replacement work.",
    ].join(" "),
  );
  const cancellationEvidence = await executionEvidence(cancelled.accepted.runId);
  assert.equal(cancellationEvidence.childRunState, "cancelled");
  assert.match(cancelled.text, /SUBAGENT-CANCEL-OK/u);

  const boundary = await runTurn(
    session.sessionId,
    [
      "Call subagent action:workflow with exactly this script and report the returned object:",
      "return {cwd:process.cwd(), hostname:process.env.HOSTNAME||null, uid:process.getuid(), leakedKeys:Object.keys(process.env).filter(k=>/^(DATABASE_URL|KAFKA_BROKERS|OPENAI_API_KEY|DEEPSEEK_API_KEY|PI_CLOUD_TOOL_BROKER_TOKEN)$/.test(k))};",
    ].join(" "),
  );
  const boundaryEntries = JSON.parse(
    await psql(`select coalesce(json_agg(payload->'message'),'[]') from pi_session_entries
    where turn_id=${sqlLiteral(boundary.accepted.turnId)} and type='message'
      and payload->'message'->>'role'='toolResult' and payload->'message'->>'toolName'='subagent'`),
  );
  assert.equal(boundaryEntries.length, 1);
  const boundaryResult = JSON.parse(
    boundaryEntries[0].content.find((part) => part.type === "text").text,
  );
  assert.equal(boundaryResult.cwd, "/workspace");
  assert.deepEqual(boundaryResult.leakedKeys, []);
  assert(!String(boundaryResult.hostname).includes("pi-cloud-worker"));
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

  const detailEvidence = [];
  for (const child of [
    noneEvidence,
    lazyEvidence,
    ...parallelEvidence,
    sharedEvidence,
    ephemeralEvidence,
    ...parallelComputeEvidence,
    ...recursiveEvidence,
  ]) {
    const detail = await api.getConversation(child.childSessionId);
    assert.equal(detail.session.sessionId, child.childSessionId);
    assert(
      detail.turns.some((turn) => turn.state === "completed"),
      "Child detail did not contain its completed Run",
    );
    assert.equal(
      detail.inheritedMessages.length > 0,
      child.contextBaseEntryId != null,
      "Child inherited history did not match its lane anchor",
    );
    detailEvidence.push({
      sessionId: child.childSessionId,
      inheritedMessages: detail.inheritedMessages.length,
    });
  }

  const tenantId = await psql(
    `select tenant_id::text from sessions where id = ${sqlLiteral(session.sessionId)}`,
  );
  const volumeId = workspaceVolumeId({ tenantId, workspaceId: session.workspaceId });
  const mergedParentFile = resolve(
    runtimeDirectory,
    "state/cube-shared/volume",
    `picloud-posix-${volumeId}`,
    "workspace/project/feature-marker.txt",
  );
  assert.equal((await readFile(mergedParentFile, "utf8")).trim(), "WORKTREE-CHILD-OK");

  const report = {
    architecture: "shared-volume-subagent-compute",
    workerImages,
    testRevision,
    timings: measurements,
    usage: JSON.parse(
      await psql(`select json_build_object(
      'input',coalesce(sum((payload->'message'->'usage'->>'input')::bigint),0),
      'output',coalesce(sum((payload->'message'->'usage'->>'output')::bigint),0),
      'cacheRead',coalesce(sum((payload->'message'->'usage'->>'cacheRead')::bigint),0),
      'cacheWrite',coalesce(sum((payload->'message'->'usage'->>'cacheWrite')::bigint),0))
      from pi_session_entries where session_id=${sqlLiteral(session.sessionId)} and type='message' and payload->'message'->>'role'='assistant'`),
    ),
    accepted: true,
    checkedAt: new Date().toISOString(),
    model: acceptanceModel,
    parentSessionId: session.sessionId,
    modes: {
      none: noneEvidence,
      lazyToolCapable: lazyEvidence,
      parallel: parallelEvidence,
      shared: sharedEvidence,
      ephemeral: ephemeralEvidence,
      parallelCompute: parallelComputeEvidence,
    },
    recursiveTree: recursiveEvidence,
    nestedCompute: nestedComputeEvidence,
    coding: codingEvidence,
    messaging: { child: messagingEvidence, ...mailboxEvidence },
    supervisor: supervisorEvidence,
    cancellation: cancellationEvidence,
    guestBoundary: boundaryResult,
    productProjection: {
      detailEvidence,
      listContainsEveryRecursiveSession: true,
      fullTreePreservesNestedParent: true,
      nestedFocusRoot: focusedTree.rootSessionId,
    },
  };
  await cleanup();
  report.cleanupCompleted = process.env.PI_CLOUD_LIVE_KEEP_FIXTURES !== "1";
  await mkdir(resolve(repositoryRoot, "docs/reports"), { recursive: true });
  await writeFile(
    resolve(repositoryRoot, "docs/reports/subagent-production-acceptance-latest.json"),
    await format(JSON.stringify(report), {
      ...(await resolveConfig(
        resolve(repositoryRoot, "docs/reports/subagent-production-acceptance-latest.json"),
      )),
      parser: "json",
    }),
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  if (!cleanupAttempted) {
    try {
      await cleanup();
    } catch (error) {
      throw new AggregateError(
        [primaryFailure, error].filter(Boolean),
        "Subagent acceptance or cleanup failed",
        { cause: primaryFailure ?? error },
      );
    }
  }
}
