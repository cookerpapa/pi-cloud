import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as callback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";

if (process.env.PI_CLOUD_LIVE_DIRECT_STEER_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_DIRECT_STEER_CHECK=1 for Luna/Cube and owned Worker-loss acceptance",
  );
const exec = promisify(callback),
  runtime = "deploy/production/runtime";
const env = await readFile(`${runtime}/.env`, "utf8");
const base = `http://127.0.0.1:${env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1]}`;
const pg = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pg.hostname = JSON.parse(
  execFileSync("docker", ["inspect", "pi-cloud-production-postgres-1"], { encoding: "utf8" }),
)[0].NetworkSettings.Networks["pi-cloud-production_database"].IPAddress;
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
const report = {
  checkedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  model: "gpt-6-luna",
  accepted: false,
  cases: [],
};
let tenant, api, project, stoppedWorker, failure;
const sessions = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
async function until(check, label, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`${label} timed out`);
}
async function finished(id) {
  return until(async () => {
    const r = await api.getRun(id);
    return terminal(r.state) && r;
  }, "Run closure");
}
async function consumption(receipt) {
  const { rows } = await sql`select count(*)::int n from pi_session_log e
    join sessions s on s.pi_session_id=e.session_id and s.tenant_id=e.tenant_id
    where s.id=${receipt.sessionId}::uuid and e.tenant_id=${tenant.tenantId}::uuid
      and e.kind='entry' and e.turn_id=${receipt.targetTurnId}::uuid
      and e.id=${`pc-agent-input-${receipt.controlRequestId}`}`.execute(db);
  return rows[0].n;
}
async function noForeignExecution() {
  const { rows } = await sql`select id from runs
    where state in ('queued','running','cancel_requested')
      and (${tenant?.tenantId ?? null}::uuid is null or tenant_id<>${tenant?.tenantId ?? null}::uuid)`.execute(
    db,
  );
  assert.equal(rows.length, 0, "Refuse process fault during unrelated execution");
}
try {
  await noForeignExecution();
  tenant = await createPrivateTenant(db, {
    slug: `direct-steer-${Date.now().toString(36)}`,
    ownerDisplayName: "Direct Steer acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  report.tenantId = tenant.tenantId;
  api = new PiCloudApi((url, init = {}) =>
    fetch(new URL(String(url), base), {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${tenant.credential.token}`,
      },
    }),
  );
  project = await api.createProject("Direct Steer acceptance", { kind: "empty" });
  report.workspaceId = project.workspaceId;
  for (const kind of ["consumed", "worker-loss", "cancelled"]) {
    const session = await api.createSession(
      project.projectId,
      project.workspaceId,
      `Direct Steer ${kind}`,
      "elastic",
      "starter",
      "/workspace",
      { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
    );
    sessions.push(session);
    const witness = `steer-${kind}.txt`,
      marker = `STEER_${kind.replaceAll("-", "_").toUpperCase()}_OK`;
    const accepted = await api.acceptTurn(
      session.sessionId,
      `Use bash exactly once with command: printf 'once\\n' >> /workspace/${witness}; sleep ${kind === "consumed" ? 30 : 90}. Set timeout to 120 seconds. Do not repeat this command. After it finishes, say ORIGINAL_COMPLETED unless I send a new instruction.`,
      newIdempotencyKey("turn"),
      "low",
    );
    await until(async () => {
      try {
        return (
          Buffer.from(
            (await api.readWorkspaceFile(session.sessionId, witness)).bytes,
          ).toString() === "once\n"
        );
      } catch {
        return false;
      }
    }, "Actual Tool execution witness");
    const text = `Do not repeat the previous bash command. Use read to inspect /workspace/${witness}, then respond with exactly ${marker}.`;
    const key = newIdempotencyKey("steer");
    const receipt = await api.steerTurn(session.sessionId, accepted.turnId, text, key);
    assert.equal(receipt.state, "accepted");
    await until(async () => {
      const c = await db
        .selectFrom("turn_control_requests")
        .select("state")
        .where("id", "=", receipt.controlRequestId)
        .executeTakeFirstOrThrow();
      return c.state === "acknowledged";
    }, "Worker acknowledged input");
    assert.equal(await consumption(receipt), 0, "Fault window must precede native consumption");
    assert(
      (await api.getInputQueue(session.sessionId)).items.some(
        (i) => i.turnId === receipt.sourceTurnId && i.status === "steering",
      ),
    );
    const repeated = await api.steerTurn(session.sessionId, accepted.turnId, text, key);
    assert.equal(repeated.sourceRunId, receipt.sourceRunId);
    assert.equal(repeated.replayed, true);
    if (kind === "worker-loss") {
      await noForeignExecution();
      const active = await api.getRun(accepted.runId);
      const worker = await db
        .selectFrom("sandboxes")
        .select("supervisor_id")
        .where("id", "=", active.workerId)
        .executeTakeFirstOrThrow();
      const prefix = env.match(/^PI_CLOUD_SUPERVISOR_ID_PREFIX=(.*)$/m)?.[1] ?? "pi-cloud-worker-";
      assert([`${prefix}1`, `${prefix}2`].includes(worker.supervisor_id));
      stoppedWorker =
        worker.supervisor_id === `${prefix}1` ? "supervisor-host" : "supervisor-host-1";
      await exec(process.execPath, [
        "scripts/production-compose.mjs",
        "stop",
        "--timeout",
        "0",
        stoppedWorker,
      ]);
      await exec(process.execPath, ["scripts/production-compose.mjs", "start", stoppedWorker]);
      stoppedWorker = undefined;
    } else if (kind === "cancelled") {
      await api.cancelTurn(session.sessionId, accepted.turnId, newIdempotencyKey("cancel"));
    }
    const target = await finished(accepted.runId);
    assert.equal(
      target.state,
      kind === "consumed" ? "completed" : kind === "cancelled" ? "cancelled" : "failed",
    );
    // Pi can consume queued input while unwinding an aborted Tool. A canonical
    // user Entry wins even if cancellation prevents its next model request.
    const consumedCount = await consumption(receipt);
    assert([0, 1].includes(consumedCount));
    if (kind !== "cancelled") assert.equal(consumedCount, kind === "consumed" ? 1 : 0);
    const consumed = consumedCount === 1;
    const source = await finished(receipt.sourceRunId);
    assert.equal(
      source.state,
      consumed ? "cancelled" : "completed",
      JSON.stringify(source.failure),
    );
    const expectedControl = consumed ? "completed" : "failed";
    await until(
      async () =>
        (
          await db
            .selectFrom("turn_control_requests")
            .select("state")
            .where("id", "=", receipt.controlRequestId)
            .executeTakeFirstOrThrow()
        ).state === expectedControl,
      "Consumption disposition",
    );
    assert.equal(await consumption(receipt), consumedCount);
    const conversation = await api.getConversation(session.sessionId);
    const answered = conversation.turns.find(
      (t) => t.runId === (consumed ? target.runId : source.runId),
    );
    const answeredBeforeStop = kind !== "cancelled" || !consumed;
    if (answeredBeforeStop)
      assert(
        answered.transcript.items
          .filter((i) => i.kind === "text")
          .map((i) => i.text)
          .join("")
          .includes(marker),
        "Recovered instruction was not answered",
      );
    assert.equal(
      Buffer.from((await api.readWorkspaceFile(session.sessionId, witness)).bytes).toString(),
      "once\n",
      "Interrupted shell command was replayed",
    );
    const afterClosure = await api.steerTurn(session.sessionId, accepted.turnId, text, key);
    assert.equal(afterClosure.sourceRunId, receipt.sourceRunId);
    assert.equal(afterClosure.replayed, true);
    const sourceRow = await db
      .selectFrom("runs")
      .select(["started_at", "lease_id"])
      .where("id", "=", receipt.sourceRunId)
      .executeTakeFirstOrThrow();
    if (consumed) {
      assert.equal(sourceRow.started_at, null);
      assert.equal(sourceRow.lease_id, null);
    }
    report.cases.push({
      kind,
      sessionId: session.sessionId,
      controlRequestId: receipt.controlRequestId,
      targetRunId: target.runId,
      targetState: target.state,
      sourceRunId: source.runId,
      sourceState: source.state,
      acknowledgedBeforeFault: true,
      consumptionCount: consumedCount,
      instructionRetained: true,
      instructionAnswered: answeredBeforeStop,
      noToolReplay: true,
      replayAfterClosure: true,
    });
  }
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  async function cleanup(work) {
    try {
      await work();
    } catch (error) {
      errors.push(error);
    }
  }
  if (stoppedWorker)
    await cleanup(() =>
      exec(process.execPath, ["scripts/production-compose.mjs", "start", stoppedWorker]),
    );
  for (const session of sessions)
    await cleanup(async () => {
      const queue = await api.getInputQueue(session.sessionId);
      if (queue.activeTurnId) {
        await api.cancelTurn(session.sessionId, queue.activeTurnId, newIdempotencyKey("cancel"));
        await until(
          async () => !(await api.getInputQueue(session.sessionId)).activeTurnId,
          "Cleanup active input",
        );
      }
      await api.deleteConversation(session.sessionId, newIdempotencyKey("cleanup"));
    });
  if (project)
    await cleanup(() => api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup")));
  if (tenant)
    await cleanup(() =>
      db
        .updateTable("tenant_api_credentials")
        .set({ revoked_at: new Date() })
        .where("credential_id", "=", tenant.credential.credentialId)
        .execute(),
    );
  report.cleanupRequested = errors.length === 0;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-direct-steer-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "Direct Steer acceptance failed",
    );
}
console.log(JSON.stringify(report));
