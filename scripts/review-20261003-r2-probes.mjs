// Review characterizations, not acceptance tests for the desired fixes.
// Creates and drops a fresh database on an explicitly supplied loopback test PG.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { sql, PostgresQueryCompiler } from "kysely";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { PostgresImageAttachmentStore } from "../packages/session-attachments/src/store.ts";
import { WorkspaceVolumeDeletionReaper } from "../packages/sandbox-control/src/workspace-volume-deletion-reaper.ts";
import { workspaceVolumeId } from "../packages/sandbox-control/src/workspace-volume-gateway-contract.ts";
import { PostgresSubagentJobProvider } from "../packages/subagent-control/src/postgres-subagent-job-provider.ts";
import { PostgresSubagentSupervisorChannel } from "../packages/subagent-control/src/postgres-subagent-supervisor-channel.ts";
import { SubagentController } from "../packages/control-plane/src/subagent-controller.ts";
import {
  PiSettlementGateController,
  settlementGatePolicyFromCommand,
} from "../packages/sandbox-supervisor/src/pi-settlement-gate.ts";
import { InMemorySessionStorage } from "@earendil-works/pi-agent-core";
import { NativeSessionWriter } from "../packages/pi-session-postgres/src/native-session-writer.ts";
import { CloudAgentRuntime } from "../packages/sandbox-supervisor/src/cloud-agent-runtime.ts";
import { SessionPublicationIngress } from "../packages/runtime-core/src/session-publication-ingress.ts";
import {
  MAX_EXECUTION_FACT_BYTES,
  parseAcceptTurnRequest,
  parseDevelopmentEnvironmentTerminalOpenRequest,
} from "../packages/protocol/src/index.ts";
import ssh2 from "ssh2";
import { createSshGateway } from "../packages/ssh-gateway/src/server.ts";

const endpoint = process.env.PI_CLOUD_REVIEW_DATABASE_URL;
if (!endpoint || !["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname))
  throw new Error("Supply an isolated loopback test PG via PI_CLOUD_REVIEW_DATABASE_URL");
const name = "review_r2_" + randomUUID().replaceAll("-", "");
const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
await sql`create database ${sql.id(name)}`.execute(admin);
const url = new URL(endpoint);
url.pathname = "/" + name;
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope:
    "Isolated PostgreSQL; production methods, synthetic metadata and fake external deletion ports. No production data, VM, S3 or model calls.",
  probes: {},
};
const RealDate = Date;
async function skewed(milliseconds, action) {
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + milliseconds]));
    }
    static now() {
      return RealDate.now() + milliseconds;
    }
  };
  try {
    return await action();
  } finally {
    globalThis.Date = RealDate;
  }
}
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: name.replaceAll("_", "-"),
    ownerDisplayName: "Review fixture",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });

  // The public character bound admits this valid PG text, but its JSON escapes
  // are repeated in Pi's atomic operation_started + user Entry checkpoint.
  const text = "fixture:" + "\u0001".repeat(99992);
  const acceptedRequest = parseAcceptTurnRequest({ prompt: text });
  const project = await store.createProject({ name: "Input budget", source: { kind: "empty" } });
  const conversation = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Input budget",
    "elastic",
  );
  const accepted = await store.acceptTurn(conversation.sessionId, randomUUID(), acceptedRequest);
  const metadata = { id: randomUUID(), createdAt: RealDate.now() };
  const writerId = randomUUID();
  const scope = {
    tenantId: tenant.tenantId,
    sessionId: conversation.sessionId,
    piSessionId: metadata.id,
    turnId: accepted.turnId,
    runId: accepted.runId,
    writerId,
    fencingToken: 1,
  };
  const ingress = new SessionPublicationIngress();
  const ownership = ingress.installPartition(0, {
    async append(r) {
      return { factId: r.factId, durable: true };
    },
    async close() {},
  });
  ingress.installRun(ownership, { scope: { ...scope, leaseId: writerId, piSessionLane: "main" } });
  const sizes = [];
  const writer = new NativeSessionWriter({
    id: writerId,
    metadata,
    nextSequence: 1,
    lanes: [{ lane: "main", leafId: null }],
    async hasId() {
      return false;
    },
    async waitProjected() {},
    async fail() {},
  });
  const native = await writer.open(
    { lane: "main", turnId: accepted.turnId, runId: accepted.runId },
    { branch: [], openOperations: [], reader: new InMemorySessionStorage(metadata) },
    {
      async publish(items) {
        const fact = {
          kind: "pi_session_append",
          factId: randomUUID(),
          scope,
          piSession: { id: metadata.id, lane: "main", writerId },
          items,
          events: [],
          occurredAt: new RealDate().toISOString(),
        };
        sizes.push(Buffer.byteLength(JSON.stringify(fact)));
        await ingress.append(ownership, fact);
      },
    },
  );
  let requests = 0;
  const runtime = new CloudAgentRuntime({
    session: native.asSession(),
    lane: "main",
    authority: { signal: new AbortController().signal, async assertCurrent() {} },
    idGenerator: writer.idGenerator,
    systemPrompt: "Fixture",
    model: {
      id: "gpt-6-luna",
      provider: "openai",
      api: "openai-responses",
      name: "Fixture",
      baseUrl: "http://unused.invalid",
      reasoning: false,
      input: ["text"],
      contextWindow: 1000000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    commitCheckpoint: (operation) => native.mutationPort().mutate(operation),
    streamFn() {
      requests++;
      throw new Error("No model request expected");
    },
  });
  try {
    await assert.rejects(runtime.run(text), (error) => error.reason === "size");
    assert.equal(requests, 0);
    assert(sizes[0] > MAX_EXECUTION_FACT_BYTES);
    report.probes.acceptedInputWireBudget = {
      characters: text.length,
      requestJsonBytes: Buffer.byteLength(JSON.stringify(acceptedRequest)),
      acceptedRun: true,
      initialNativeFactBytes: sizes[0],
      maximumFactBytes: MAX_EXECUTION_FACT_BYTES,
      modelRequests: requests,
      rejection: "size",
    };
  } finally {
    native.close();
    await ingress.close();
  }

  const compiler = new PostgresQueryCompiler(),
    sealQueries = [];
  const measured = db.withPlugin({
    transformQuery({ node, queryId }) {
      sealQueries.push(compiler.compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const subagents = new SubagentController({
    database: measured,
    managementToken: "isolated-review-no-network",
    allowInsecureHttp: true,
    ownsPartition: () => true,
  });
  await subagents.consume({
    topic: "fixture",
    partition: 0,
    offset: 0n,
    fact: {
      kind: "execution_seal",
      scope: {
        tenantId: tenant.tenantId,
        piSessionId: randomUUID(),
        sessionId: randomUUID(),
        runId: randomUUID(),
        writerId: randomUUID(),
      },
    },
  });
  await subagents.close();
  assert.equal(sealQueries.length, 4);
  assert(sealQueries.every((query) => query.includes("subagent_executions")));
  report.probes.unrelatedSealSubagentReads = {
    globalQueries: sealQueries.length,
    existingSubagents: 0,
    queryTemplates: sealQueries,
  };

  const workingDirectory = "/home/user/project";
  const gate = new PiSettlementGateController(
    settlementGatePolicyFromCommand({
      payload: {
        workingDirectory,
        environment: {
          recipe: {
            verificationCommands: [
              { id: "settlement-gate", command: "npm test", cwd: "frontend", timeoutMs: 10000 },
            ],
          },
        },
      },
    }),
  );
  gate.observe({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: {} });
  gate.observe({
    type: "tool_execution_end",
    toolCallId: "edit",
    toolName: "edit",
    isError: false,
  });
  gate.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  const reminder = gate.prepareFollowUp();
  assert(reminder.content[0].text.includes("/workspace/frontend"));
  report.probes.verificationDirectory = {
    workingDirectory,
    relativeVerificationDirectory: "frontend",
    instructedDirectory: "/workspace/frontend",
  };

  const terminalRequest = {
    developmentEnvironmentProtocolVersion: 1,
    type: "development_environment_terminal.open",
    requestId: randomUUID(),
    environmentId: randomUUID(),
    tenantId: tenant.tenantId,
    userId: randomUUID(),
    rows: 24,
    cols: 512,
  };
  parseDevelopmentEnvironmentTerminalOpenRequest(terminalRequest);
  const sshColumns = [],
    sshClient = new ssh2.Client();
  const sshServer = createSshGateway({
    config: {
      hostKey: Buffer.from(ssh2.utils.generateKeyPairSync("ed25519").private),
      terminalToken: "fixture",
      allowInsecureInternalHttp: true,
    },
    authority: {
      async consume() {
        return { ...terminalRequest, sandboxControlBaseUrl: "http://unused.invalid" };
      },
    },
    async openTerminal(options) {
      sshColumns.push(options.cols);
      parseDevelopmentEnvironmentTerminalOpenRequest({
        ...terminalRequest,
        rows: options.rows,
        cols: options.cols,
      });
      throw new Error("Expected the current downstream schema to reject the wide terminal");
    },
  });
  try {
    await new Promise((resolve, reject) => {
      sshServer.once("error", reject);
      sshServer.listen(0, "127.0.0.1", resolve);
    });
    const message = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SSH fixture timed out")), 5000);
      sshClient.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      sshClient.once("ready", () =>
        sshClient.shell({ rows: 24, cols: 600 }, (error, channel) => {
          if (error) {
            clearTimeout(timeout);
            reject(error);
            return;
          }
          let text = "";
          channel.on("data", () => {});
          channel.stderr.on("data", (bytes) => {
            text += bytes;
          });
          channel.on("close", () => {
            clearTimeout(timeout);
            sshClient.end();
            resolve(text);
          });
        }),
      );
      sshClient.connect({
        host: "127.0.0.1",
        port: sshServer.address().port,
        username: "picloud",
        password: "synthetic",
        hostVerifier: () => true,
      });
    });
    assert.deepEqual(sshColumns, [600]);
    assert.match(message, /terminal is unavailable/);
    report.probes.sshTerminalColumns = {
      requested: 600,
      forwarded: sshColumns[0],
      downstreamMaximum: 512,
      result: message.trim(),
    };
  } finally {
    sshClient.destroy();
    await new Promise((resolve) => sshServer.close(resolve));
  }

  const workspaces = [];
  for (let i = 0; i < 17; i++) {
    const p = await store.createProject({ name: `Review ${i}`, source: { kind: "empty" } });
    workspaces.push(p.workspaceId);
    await db
      .updateTable("workspaces")
      .set({ deleted_at: new RealDate(1000 + i) })
      .where("id", "=", p.workspaceId)
      .execute();
  }
  const last = workspaces.at(-1);
  const { sandbox_domain_id: domain } = await db
    .selectFrom("workspaces")
    .select("sandbox_domain_id")
    .where("id", "=", last)
    .executeTakeFirstOrThrow();
  const healthy = workspaceVolumeId({ tenantId: tenant.tenantId, workspaceId: last });
  const calls = [];
  let blocked = true;
  const reaper = new WorkspaceVolumeDeletionReaper({
    database: db,
    sandboxDomainId: domain,
    gateway: { async prepareDelete() {}, async finalizeDelete() {} },
    deleteVolumeMetadata: async (id) => {
      calls.push(id);
      if (blocked && id !== healthy) throw new Error("synthetic stale refcount");
    },
    onError() {},
  });
  try {
    const rounds = [];
    for (let i = 0; i < 3; i++) rounds.push(await reaper.runOnce());
    assert.equal(calls.filter((id) => id === healthy).length, 0);
    assert.deepEqual(rounds, [0, 0, 0]);
    report.probes.workspaceDeletion = {
      blockedOldest: 16,
      healthyBehind: 1,
      rounds,
      externalDeleteAttempts: calls.length,
      healthyAttempts: 0,
    };
    blocked = false;
    assert.equal(await reaper.runOnce(), 16);
    assert.equal(await reaper.runOnce(), 1);
    report.probes.workspaceDeletion.afterUnblocking = "all 17 purged over two batches";
  } finally {
    await reaper.close();
  }

  const blobs = new Map(),
    deleted = [];
  let failingKey;
  const images = new PostgresImageAttachmentStore(db, {
    async put(key, bytes) {
      blobs.set(key, bytes);
    },
    async *readStream(key) {
      yield blobs.get(key);
    },
    async delete(key) {
      deleted.push(key);
      if (key === failingKey) throw new Error("synthetic one-object deletion failure");
      blobs.delete(key);
    },
  });
  for (let i = 0; i < 3; i++) {
    const image = await images.put(
      { tenantId: tenant.tenantId },
      Buffer.from(`synthetic image ${i}`),
      "image/png",
    );
    if (!i) failingKey = `session-images/${tenant.tenantId}/${image.id}`;
    await db
      .updateTable("session_image_objects")
      .set({ created_at: new RealDate(1000 + i) })
      .where("id", "=", image.id)
      .execute();
  }
  for (let i = 0; i < 3; i++) await assert.rejects(images.reap(0), /one-object/);
  assert.equal(new Set(deleted).size, 1);
  assert.equal(blobs.size, 3);
  report.probes.imageDeletion = {
    objects: 3,
    rounds: 3,
    deleteAttempts: deleted.length,
    distinctAttemptedObjects: new Set(deleted).size,
    remaining: blobs.size,
  };
  failingKey = undefined;
  assert.equal(await images.reap(0), 3);
  assert.equal(blobs.size, 0);

  // Reduced relational fixtures isolate clock decisions. They deliberately do
  // not claim to validate admission, FK triggers, or complete Subagent execution.
  await sql`create schema clock_probe`.execute(db);
  await sql
    .raw(
      `
    create table clock_probe.runs(id uuid primary key,tenant_id uuid,state text,turn_id uuid,lease_id uuid,output_sealed_at timestamptz,failure_code text,failure_message text);
    create table clock_probe.subagent_executions(id uuid primary key,tenant_id uuid,parent_execution_id uuid,parent_session_id uuid,child_session_id uuid,child_run_id uuid,state text,sandbox_mode text,created_at timestamptz default clock_timestamp(),settled_at timestamptz,updated_at timestamptz,failure_code text,failure_message text);
    create table clock_probe.turn_control_requests(id uuid primary key,tenant_id uuid,session_id uuid,turn_id uuid,target_run_id uuid,idempotency_key text,kind text,state text,request_sha256 text,payload jsonb,attempts int,available_at timestamptz,dispatched_at timestamptz,acknowledged_at timestamptz,completed_at timestamptz,failure_code text);
    create table clock_probe.subagent_supervisor_requests(id uuid primary key,tenant_id uuid,execution_id uuid,reason text,message text,expects_reply bool,interview jsonb,reply_message text,created_at timestamptz default clock_timestamp(),expires_at timestamptz,replied_at timestamptz);
  `,
    )
    .execute(db);
  const clockUrl = new URL(url);
  clockUrl.searchParams.set("options", "-c search_path=clock_probe,public");
  const clockDb = createDatabase({ connectionString: clockUrl.toString(), maxConnections: 1 });
  try {
    const child = randomUUID(),
      run = randomUUID(),
      session = randomUUID(),
      parent = randomUUID();
    await sql`insert into runs(id,tenant_id,state,turn_id,lease_id) values(${run}::uuid,${tenant.tenantId}::uuid,'running',${randomUUID()}::uuid,${randomUUID()}::uuid)`.execute(
      clockDb,
    );
    await sql`insert into subagent_executions(id,tenant_id,parent_session_id,child_session_id,child_run_id,state,sandbox_mode) values(${child}::uuid,${tenant.tenantId}::uuid,${parent}::uuid,${session}::uuid,${run}::uuid,'running','shared')`.execute(
      clockDb,
    );
    const jobs = new PostgresSubagentJobProvider({
      database: clockDb,
      nativeLanes: {
        childAnchor() {
          return null;
        },
        async createChildLane() {},
      },
    });
    await skewed(60_000, () => jobs.cancel(tenant.tenantId, child));
    const {
      rows: [cancel],
    } =
      await sql`select available_at<=clock_timestamp() as due,extract(epoch from available_at-clock_timestamp()) as seconds_until_due from turn_control_requests`.execute(
        clockDb,
      );
    assert.equal(cancel.due, false);
    assert.ok(Number(cancel.seconds_until_due) > 55);
    report.probes.subagentCancellationClock = {
      appSkewMs: 60000,
      immediatelyDueInPG: cancel.due,
      secondsUntilDue: Number(cancel.seconds_until_due),
    };

    const channel = new PostgresSubagentSupervisorChannel(clockDb);
    const request = await channel.contact({
      tenantId: tenant.tenantId,
      childSessionId: session,
      childRunId: run,
      reason: "need_decision",
      message: "synthetic decision",
    });
    await sql`update subagent_supervisor_requests set expires_at=clock_timestamp()+interval '30 seconds' where id=${request.requestId}::uuid`.execute(
      clockDb,
    );
    await skewed(60_000, () =>
      assert.rejects(
        channel.reply({
          tenantId: tenant.tenantId,
          parentSessionId: parent,
          requestId: request.requestId,
          message: "fixture reply",
        }),
        /expired/,
      ),
    );
    await sql`update subagent_supervisor_requests set expires_at=clock_timestamp()-interval '30 seconds' where id=${request.requestId}::uuid`.execute(
      clockDb,
    );
    await skewed(-60_000, () =>
      channel.reply({
        tenantId: tenant.tenantId,
        parentSessionId: parent,
        requestId: request.requestId,
        message: "fixture reply",
      }),
    );
    report.probes.supervisorReplyClock = {
      positiveSkewMs: 60000,
      validRequestRejected: true,
      negativeSkewMs: -60000,
      expiredRequestAccepted: true,
    };
  } finally {
    await clockDb.destroy();
  }

  await writeFile(
    process.env.PI_CLOUD_REVIEW_OUTPUT ?? "/tmp/pi-cloud-review-r2-probes.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.Date = RealDate;
  await db.destroy();
  try {
    await sql`drop database ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
}
