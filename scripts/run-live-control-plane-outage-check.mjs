import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
import { armControlPlaneRestore } from "./lib/owned-control-plane-outage.mjs";
import {
  execIn,
  kubectl,
  kubectlAsync,
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_CONTROL_PLANE_OUTAGE_CHECK,
  "1",
  "Enable the owned Control Plane outage explicitly",
);
const output = resolve(process.argv[2] ?? "/tmp/pi-cloud-control-plane-outage.json");
const unavailableMs = Number(process.env.PI_CLOUD_CONTROL_PLANE_OUTAGE_MS ?? 60000);
assert(Number.isSafeInteger(unavailableMs) && unavailableMs >= 45000 && unavailableMs <= 90000);
const pg = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
pg.hostname = serviceAddress("postgres");
const db = createDatabase({
  connectionString: pg.toString(),
  maxConnections: 3,
  readTimeoutMs: 5000,
});
const baseUrl = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
const controlUrl = "http://" + serviceAddress("control-plane") + ":3000/health/ready";
const deployment = JSON.parse(kubectl(["get", "deployment/pi-cloud-control-plane", "-o", "json"]));
const partitionCount = Number(
  deployment.spec.template.spec.containers[0].env.find(
    (entry) => entry.name === "PI_CLOUD_KAFKA_PARTITIONS",
  ).value,
);
assert(Number.isSafeInteger(partitionCount) && partitionCount > 0);
const exec = promisify(execFile);
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  unavailableMs,
  accepted: false,
  samples: [],
};
let tenant, api, project, root, newRun, fault, failure, retrying, retryFailure;
const sessions = [],
  retryAbort = new AbortController();
const phase = (name) =>
  console.log(JSON.stringify({ phase: (report.phase = name), at: new Date().toISOString() }));
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
async function until(read, label, budget = 180000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(300);
  }
  throw new Error(label + " timed out");
}
async function ready() {
  try {
    return (await fetch(controlUrl, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
function workerPods() {
  return JSON.parse(kubectl(["get", "pods", "-o", "json"]))
    .items.filter((p) => p.metadata.name.startsWith("pi-cloud-pi-worker-primary-v1-"))
    .map((p) => ({
      name: p.metadata.name,
      uid: p.metadata.uid,
      containers: p.status.containerStatuses.map((c) => ({
        id: c.containerID,
        restarts: c.restartCount,
        ready: c.ready,
        image: c.image,
      })),
    }));
}
async function workerConnections() {
  return db
    .selectFrom("workers as w")
    .innerJoin("supervisor_connections as c", "c.worker_id", "w.id")
    .select([
      "w.id as workerId",
      "w.supervisor_id as pod",
      "w.boot_id as bootId",
      "c.connection_id as connectionId",
      "c.registered_at as registeredAt",
    ])
    .select(
      sql`(select count(*)::int from session_leases l where l.worker_id=w.id and l.released_at is null)`.as(
        "sessions",
      ),
    )
    .where("w.state", "=", "ready")
    .where("c.state", "=", "active")
    .where("c.expires_at", ">", sql`clock_timestamp()`)
    .where(
      "w.supervisor_id",
      "in",
      report.beforePods.map((p) => p.name),
    )
    .orderBy("w.supervisor_id")
    .execute();
}
async function inventory(runtimeId) {
  const cluster = JSON.parse(
    await readFile(resolve(runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
  );
  const { stdout } = await exec(
    resolve(runtimeDirectory, "cubesandbox/cubemastercli"),
    [
      "--address",
      cluster.master.host,
      "--port",
      String(cluster.master.port),
      "list",
      "--all",
      "--wide",
    ],
    {
      timeout: 30000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^(all|https?|no)_proxy$/i.test(k)),
      ),
    },
  );
  const nodes = /NODES_SCANNED\s+(\d+)\/(\d+)/.exec(stdout),
    count = /SANDBOX_COUNT\s+(\d+)/.exec(stdout);
  assert(
    nodes && count && Number(nodes[1]) > 0 && nodes[1] === nodes[2],
    "Incomplete Cube inventory",
  );
  return {
    nodes: Number(nodes[1]),
    count: Number(count[1]),
    ...(runtimeId ? { targetPresent: stdout.includes(runtimeId) } : {}),
  };
}
async function ownedOnly() {
  const { rows } = await sql`select
    (select count(*) from runs where tenant_id<>${tenant.tenantId}::uuid and state not in ('completed','failed','cancelled','timed_out'))::int as runs,
    (select count(*) from workspace_runtimes where tenant_id<>${tenant.tenantId}::uuid and state<>'released')::int as vms,
    (select count(*) from development_environments where state<>'released')::int as machines,
    (select count(*) from workspace_terminal_sessions where state<>'released')::int as terminals`.execute(
    db,
  );
  assert(
    Object.values(rows[0]).every((n) => n === 0),
    "Unrelated active work; refusing Control Plane outage",
  );
}
async function leaseSample() {
  const {
    rows: [row],
  } =
    await sql`select r.state,r.worker_id,l.lease_id,l.fencing_token::text,l.renewed_at,l.valid_until,
    l.valid_until>clock_timestamp() as valid,l.released_at,l.writer_failed_at,l.writer_sealed_at,
    w.supervisor_id as pod,w.boot_id,
    (select max(c.seq)::text from pi_durable_commits c where c.tenant_id=r.tenant_id and c.session_id=l.pi_session_id) as projected_seq,
    l.pi_session_id,p.session_hash % ${partitionCount} as partition
    from runs r join session_leases l on l.lease_id=r.lease_id join workers w on w.id=r.worker_id
    join pi_sessions p on p.tenant_id=r.tenant_id and p.id=l.pi_session_id where r.id=${root.runId}::uuid`.execute(
      db,
    );
  assert(row, "Owned Run lost its lease record");
  return row;
}
async function vmSample() {
  return db
    .selectFrom("workspace_runtimes")
    .select([
      "workspace_runtime_id",
      "runtime_id",
      "runtime_name",
      "state",
      "failure_code",
      "owner_instance_id",
    ])
    .where("workspace_id", "=", project.workspaceId)
    .where("state", "!=", "released")
    .executeTakeFirstOrThrow();
}
async function kafkaSample(owner) {
  // Manual assignment, no subscription or offset commit: this cannot take a Projector partition.
  // Execute the bounded read in the Worker Pod so advertised broker DNS resolves.
  const input = { partition: Number(owner.partition), runId: root.runId };
  const source = `import native from '@confluentinc/kafka-javascript';
const input=${JSON.stringify(input)},topic='pi-cloud.execution-log.v16';
const reader=new native.KafkaConsumer({'metadata.broker.list':process.env.PI_CLOUD_KAFKA_BROKERS,'group.id':'outage-readonly-'+Date.now(),'enable.auto.commit':false,'enable.auto.offset.store':false,'isolation.level':'read_committed','log_level':0},{});
await new Promise((resolve,reject)=>reader.connect({},e=>e?reject(e):resolve()));
try {
const bounds=await new Promise((resolve,reject)=>reader.queryWatermarkOffsets(topic,input.partition,5000,(e,v)=>e?reject(e):resolve(v)));
reader.assign([{topic,partition:input.partition,offset:bounds.lowOffset}]);
const summary={high:bounds.highOffset,records:0,maxSeq:0,toolResults:0,toolIntents:[],probes:0};let empty=0;const end=Date.now()+10000;
while(empty<2&&Date.now()<end){const messages=await new Promise((resolve,reject)=>reader.consume(100,(e,v)=>e?reject(e):resolve(v)));if(!messages.length)empty++;for(const m of messages){if(m.offset>=bounds.highOffset)continue;const f=JSON.parse(m.value.toString());if(f.scope?.runId!==input.runId)continue;summary.records++;if(f.kind==='path_probe')summary.probes++;if(f.kind!=='durable_commit')continue;summary.maxSeq=Math.max(summary.maxSeq,f.commit.seq);for(const t of f.tools)summary.toolIntents.push({operationId:t.request?.operationId??t.operationId,toolName:t.request?.toolName??t.toolName});for(const w of f.commit.writes)if(w.type==='entry')summary.toolResults+=(w.value.model??[]).filter(m=>m.role==='toolResult').length;}}
console.log(JSON.stringify(summary));
} finally {await new Promise((resolve,reject)=>reader.disconnect(e=>e?reject(e):resolve()));}`;
  return JSON.parse(
    execIn(owner.pod, ["node", "--input-type=module", "-"], {
      input: source,
      stdio: "pipe",
      timeout: 30000,
    }),
  );
}
async function finished(runId) {
  const result = await until(
    async () => {
      const r = await api.getRun(runId);
      return terminal(r) && r;
    },
    "Run completion",
    240000,
  );
  await until(async () => {
    const r = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    return !r.output_seal_id || r.output_sealed_at;
  }, "ordered writer closure");
  return result;
}

try {
  assert(await ready(), "Control Plane is not initially ready");
  const schema = await db
    .selectFrom("kysely_migration")
    .select("name")
    .orderBy("name", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
  assert.equal(schema.name, "189_idle_worker_reconnect");
  report.controlPlaneImage = deployment.spec.template.spec.containers[0].image;
  report.beforePods = workerPods();
  report.initialInventory = await inventory();
  assert.equal(report.initialInventory.count, 0, "Refuse outage with pre-existing VMs");
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-outage-" + randomUUID(),
    ownerDisplayName: "Control Plane outage acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  report.tenantId = tenant.tenantId;
  api = new PiCloudApi(
    (path, init = {}) =>
      fetch(new URL(String(path), baseUrl), {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(10000),
      }),
    tenant.credential.token,
  );
  await ownedOnly();
  project = await api.createProject("Control Plane blackout acceptance", { kind: "empty" });
  report.workspaceId = project.workspaceId;
  for (const title of ["Existing Run", "Retry after outage"])
    sessions.push(
      await api.createSession(
        project.projectId,
        project.workspaceId,
        title,
        "elastic",
        "starter",
        "/workspace",
        { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
      ),
    );
  phase("start two-step owned Bash fixture");
  root = await api.acceptTurn(
    sessions[0].sessionId,
    "Use bash exactly twice, sequentially. First command: printf 'FIRST_STARTED\\n' >> outage-once.txt; sleep 30; printf 'FIRST_DONE\\n' >> outage-once.txt; printf FIRST_DONE. Set timeout to 120 seconds and wait for the result. Only after that result, call bash with: printf 'SECOND_DONE\\n' >> outage-once.txt; printf OUTAGE_SURVIVED. Do not combine the two calls, delegate, search, or use other tools. Finally reply OUTAGE_SURVIVED.",
    newIdempotencyKey("outage-root"),
    "low",
  );
  report.runId = root.runId;
  await save();
  await until(async () => {
    const r = await api.getRun(root.runId);
    assert(!terminal(r), "Run finished before the outage fixture");
    try {
      return (
        Buffer.from(
          (await api.readWorkspaceFile(sessions[0].sessionId, "outage-once.txt")).bytes,
        ).toString() === "FIRST_STARTED\n"
      );
    } catch {
      return false;
    }
  }, "first Bash started");
  report.before = await leaseSample();
  report.vmBefore = await vmSample();
  assert(report.vmBefore.runtime_id && report.before.valid);
  report.connectionsBefore = await workerConnections();
  assert.equal(report.connectionsBefore.length, report.beforePods.length);
  assert(
    report.connectionsBefore.some(
      (c) => c.workerId !== report.before.worker_id && c.sessions === 0,
    ),
    "Acceptance needs an idle Worker as well as the busy Worker",
  );
  await ownedOnly();
  fault = await armControlPlaneRestore(output + ".restore.json", Date.now() + 240000);
  const stopAt = Date.now();
  phase("stop every Control Plane replica");
  try {
    await kubectlAsync([
      "scale",
      "deployment/pi-cloud-control-plane",
      `--current-replicas=${fault.receipt.replicas}`,
      "--replicas=0",
    ]);
    await until(
      () =>
        JSON.parse(kubectl(["get", "pods", "-l", fault.selector, "-o", "json"])).items.length === 0,
      "Control Plane Pods absent",
      90000,
    );
    assert.equal(await ready(), false);
    report.stoppedAfterMs = Date.now() - stopAt;
    report.unavailableAt = new Date().toISOString();
    const absentAt = Date.now();
    phase("Control Plane absent; observe PG leases and retain one retry identity");
    report.atAbsence = await leaseSample();
    const retryKey = newIdempotencyKey("outage-new-root");
    report.newRequest = { attempts: 0, failedAttempts: 0, sameIdempotencyKey: true };
    const retryApi = new PiCloudApi(
      (path, init) =>
        fetch(new URL(String(path), baseUrl), {
          ...init,
          signal: AbortSignal.any([retryAbort.signal, AbortSignal.timeout(2000)]),
        }),
      tenant.credential.token,
    );
    retrying = (async () => {
      const end = Date.now() + 240000;
      while (!retryAbort.signal.aborted && Date.now() < end) {
        report.newRequest.attempts++;
        try {
          newRun = await retryApi.acceptTurn(
            sessions[1].sessionId,
            "Do not use tools. Reply NEW_RUN_AFTER_CP_OUTAGE.",
            retryKey,
            "low",
          );
          report.newRequest.acceptedAt = new Date().toISOString();
          report.newRequest.runId = newRun.runId;
          report.newRequest.key = retryKey;
          return;
        } catch (error) {
          if (retryAbort.signal.aborted) return;
          if (
            typeof error.status === "number" &&
            error.status > 0 &&
            error.status < 500 &&
            error.status !== 408 &&
            error.status !== 429
          )
            throw error;
          report.newRequest.failedAttempts++;
        }
        await delay(500);
      }
      throw Error("New request did not recover after the outage");
    })().catch((error) => {
      retryFailure = error;
      report.newRequest.failure = { name: error.name, code: error.code, status: error.status };
    });
    while (Date.now() - absentAt < unavailableMs) {
      const sample = await leaseSample();
      assert.equal(sample.lease_id, report.before.lease_id);
      assert.equal(sample.fencing_token, report.before.fencing_token);
      assert.equal(sample.worker_id, report.before.worker_id);
      assert(
        sample.valid && !sample.released_at && !sample.writer_failed_at && !sample.writer_sealed_at,
        "Active Worker lost its PG lease during control outage",
      );
      assert.equal(
        sample.projected_seq,
        report.atAbsence.projected_seq,
        "Projection advanced without a Control Plane",
      );
      assert.equal(await ready(), false, "Control Plane unexpectedly returned during the blackout");
      report.samples.push({
        at: new Date().toISOString(),
        renewedAt: sample.renewed_at,
        validUntil: sample.valid_until,
        projectedSeq: sample.projected_seq,
      });
      await delay(Math.min(10000, Math.max(1, unavailableMs - (Date.now() - absentAt))));
    }
    assert(
      new Date(report.samples.at(-1).renewedAt) > new Date(report.before.renewed_at),
      "Worker did not renew while Control Plane was absent",
    );
    report.kafkaWhileAbsent = await kafkaSample(report.before);
    assert(
      report.kafkaWhileAbsent.maxSeq > Number(report.atAbsence.projected_seq),
      "Worker did not commit native progress during outage",
    );
    assert(
      report.kafkaWhileAbsent.toolResults >= 1,
      "Cube result did not reach the original Worker during outage",
    );
    assert.equal(
      report.kafkaWhileAbsent.toolIntents.length,
      2,
      "Next Tool intent was not buffered in Kafka",
    );
    report.inventoryWhileAbsent = await inventory(report.vmBefore.runtime_name);
    assert(
      report.inventoryWhileAbsent.targetPresent && report.inventoryWhileAbsent.count === 1,
      "Original native Cube sandbox is not present during outage",
    );
    assert.equal(newRun, undefined, "New request was accepted with no Control Plane");
    report.actualUnavailableMs = Date.now() - absentAt;
  } finally {
    report.restoreRequestedAt = new Date().toISOString();
    phase("restore original Control Plane replica count");
    await fault.restore();
  }
  await until(ready, "Control Plane ready after replacement", 180000);
  report.readyAt = new Date().toISOString();
  report.restoreToReadyMs = Date.parse(report.readyAt) - Date.parse(report.restoreRequestedAt);
  await retrying;
  if (retryFailure) throw retryFailure;
  assert(newRun && newRun.kind === "run" && report.newRequest.failedAttempts > 0);
  const repeated = await api.acceptTurn(
    sessions[1].sessionId,
    "Do not use tools. Reply NEW_RUN_AFTER_CP_OUTAGE.",
    report.newRequest.key,
    "low",
  );
  assert.equal(repeated.runId, newRun.runId);
  assert(repeated.replayed);
  report.newRequest.replayConfirmed = true;
  phase("verify old Run completion, new Run admission, and unchanged VM");
  const [oldOutcome, newOutcome] = await Promise.all([
    finished(root.runId),
    finished(newRun.runId),
  ]);
  assert.equal(oldOutcome.state, "completed", oldOutcome.failure?.code);
  assert.equal(newOutcome.state, "completed", newOutcome.failure?.code);
  assert.equal(oldOutcome.workerId, report.before.worker_id);
  const currentLease = await leaseSample();
  assert.equal(currentLease.lease_id, report.before.lease_id);
  const turns = (await api.getConversation(sessions[0].sessionId)).turns;
  const tools = turns.flatMap((t) => t.transcript.items).filter((item) => item.kind === "tool");
  assert.equal(tools.length, 2);
  assert(tools.every((t) => t.toolName === "bash" && t.status === "completed"));
  assert.equal(
    Buffer.from(
      (await api.readWorkspaceFile(sessions[0].sessionId, "outage-once.txt")).bytes,
    ).toString(),
    "FIRST_STARTED\nFIRST_DONE\nSECOND_DONE\n",
  );
  report.vmAfter = await vmSample();
  assert.equal(report.vmAfter.workspace_runtime_id, report.vmBefore.workspace_runtime_id);
  assert.equal(report.vmAfter.runtime_id, report.vmBefore.runtime_id);
  assert.equal(report.vmAfter.runtime_name, report.vmBefore.runtime_name);
  report.inventoryAfter = await inventory(report.vmBefore.runtime_name);
  assert(
    report.inventoryAfter.targetPresent && report.inventoryAfter.count === 1,
    "Original native Cube sandbox is not present after recovery",
  );
  report.afterPods = workerPods();
  assert.equal(report.afterPods.length, report.beforePods.length);
  for (const oldPod of report.beforePods) {
    const newPod = report.afterPods.find((p) => p.name === oldPod.name);
    assert.equal(newPod?.uid, oldPod.uid);
    assert.deepEqual(
      newPod.containers.map((c) => ({ id: c.id, restarts: c.restarts })),
      oldPod.containers.map((c) => ({ id: c.id, restarts: c.restarts })),
      `Worker ${oldPod.name} restarted during Control Plane outage`,
    );
  }
  report.connectionsAfter = await until(async () => {
    const connections = await workerConnections();
    return (
      connections.length === report.connectionsBefore.length &&
      connections.every((c) => {
        const old = report.connectionsBefore.find((b) => b.workerId === c.workerId);
        return (
          old &&
          c.bootId === old.bootId &&
          c.connectionId !== old.connectionId &&
          new Date(c.registeredAt).valueOf() >= Date.parse(report.restoreRequestedAt)
        );
      }) &&
      connections
    );
  }, "all original Worker Boots re-registered");
  const retired = await db
    .selectFrom("worker_retirements")
    .select("worker_id")
    .where(
      "worker_id",
      "in",
      report.connectionsBefore.map((c) => c.workerId),
    )
    .execute();
  assert.deepEqual(retired, [], "A healthy Worker was retired by management expiry");
  report.idleAndBusyWorkersPreserved = true;
  const runRows = await db
    .selectFrom("runs")
    .select(["id", "state", "created_at", "started_at", "settled_at"])
    .where("tenant_id", "=", tenant.tenantId)
    .execute();
  assert.equal(runRows.length, 2);
  report.runs = runRows;
  const connection = await db
    .selectFrom("supervisor_connections")
    .select(["registered_at", "last_heartbeat_at", "state", "boot_id"])
    .where("worker_id", "=", report.before.worker_id)
    .where("boot_id", "=", report.before.boot_id)
    .where("registered_at", ">=", new Date(report.restoreRequestedAt))
    .orderBy("registered_at", "desc")
    .executeTakeFirstOrThrow();
  assert.equal(
    connection.state,
    "active",
    "Original Worker did not reconnect its management channel",
  );
  report.managementReconnect = connection;
  report.accepted = true;
  report.sameWorkerAndLease = true;
  report.samePhysicalVm = true;
  report.eachBashExecutedOnce = true;
} catch (error) {
  failure = error;
  report.failure = { name: error.name, message: error.message.slice(0, 600) };
  report.failure.location = error.stack
    ?.split("\n")
    .filter((line) => line.includes("run-live-control-plane-outage-check.mjs"))
    .slice(0, 2);
} finally {
  const errors = [];
  const clean = async (work) => {
    try {
      await work();
    } catch (error) {
      errors.push({ name: error.name, message: error.message.slice(0, 400) });
    }
  };
  if (fault) await clean(() => fault.restore());
  retryAbort.abort();
  await retrying;
  await clean(() => until(ready, "Control Plane available for cleanup"));
  if (tenant && api)
    for (const session of sessions)
      await clean(async () => {
        const runs = await db
          .selectFrom("runs")
          .select(["id", "turn_id"])
          .where("session_id", "=", session.sessionId)
          .execute();
        for (const run of runs) {
          if (!terminal(await api.getRun(run.id)))
            await api.cancelTurn(
              session.sessionId,
              run.turn_id,
              newIdempotencyKey("outage-cleanup"),
            );
          await finished(run.id);
        }
        await api.deleteConversation(session.sessionId);
      });
  if (project)
    await clean(async () => {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("outage-workspace"));
      await until(async () => {
        const w = await db
          .selectFrom("workspaces")
          .select(["deleted_at", "storage_purged_at"])
          .where("id", "=", project.workspaceId)
          .executeTakeFirst();
        return !w || (w.deleted_at && w.storage_purged_at);
      }, "physical Workspace cleanup");
    });
  if (tenant && !errors.length)
    await clean(async () => {
      await until(async () => {
        const row = await db
          .selectFrom("outbox")
          .select("id")
          .where("tenant_id", "=", tenant.tenantId)
          .where("published_at", "is", null)
          .limit(1)
          .executeTakeFirst();
        return !row;
      }, "owned control messages settled");
      const blobs = new S3ImageBlobStore({
        endpoint: "http://" + serviceAddress("session-images") + ":8333",
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(
            resolve(runtimeDirectory, "secrets/session-image-s3-credentials.json"),
            "utf8",
          ),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } finally {
        await blobs.close();
      }
    });
  report.cleanupConfirmed = !errors.length;
  if (errors.length) report.cleanupErrors = errors;
  await save();
  await db.destroy();
  console.log(
    JSON.stringify({
      report: output,
      accepted: report.accepted,
      cleanupConfirmed: report.cleanupConfirmed,
      failure: report.failure,
    }),
  );
  if (failure || errors.length) process.exitCode = 1;
}
