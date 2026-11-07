// Owned, bounded live evidence for source compute/storage receipts and kernel
// Workspace quotas. No shared-service outage, price changes or user resources.
// Run after matched deployment:
// PI_CLOUD_LIVE_RESOURCE_ACCOUNTING_CHECK=1 node --import tsx scripts/run-live-resource-accounting-check.mjs /private/new-report.json
// Needs a working Luna route, starter template, independent metering/quota
// services and 2 GiB of backing-pool headroom. Work is bounded to 12 minutes,
// followed by a separate 5-minute cleanup budget. SIGKILL can still leave the
// owned identities in the private report for explicit API cleanup.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { uploadRelativePath } from "../packages/protocol/src/user-upload.ts";
import { parseResourceMeteringBatch } from "../packages/protocol/src/resource-metering.ts";
import { workspaceVolumeId } from "../packages/sandbox-control/src/workspace-volume-gateway-contract.ts";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import { assertLiveContract } from "./lib/live-contract.mjs";
import { nativeHistory, nativeMessages, runUsage } from "./lib/native-session-history.mjs";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_RESOURCE_ACCOUNTING_CHECK,
  "1",
  "Set PI_CLOUD_LIVE_RESOURCE_ACCOUNTING_CHECK=1 for two owned Luna Runs, a starter VM and at most 2 GiB of Workspace capacity",
);
const output = resolve(
  process.argv[2] ?? `${runtimeDirectory}/diagnostics/resource-accounting-${Date.now()}.json`,
);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const GiB = 1024 ** 3,
  MiB = 1024 ** 2;
const started = Date.now(),
  workDeadline = started + 12 * 60_000;
const abort = new AbortController();
const interrupted = () => abort.abort(new Error("Resource acceptance interrupted"));
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
const report = {
  startedAt: new Date(started).toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  maximumWorkspaceCapacityBytes: 2 * GiB,
  maximumSingleAllocationBytes: 1100 * MiB,
  pricesConfigured: false,
  paymentCollectionEnabled: false,
  receiverOutage: {
    exercised: false,
    scope:
      "Not exercised here; run the source/PG contracts and existing model-metering live driver separately. This driver checks real resource receipt replay.",
  },
  runs: [],
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const phase = async (value) => {
  report.phase = value;
  console.log(JSON.stringify({ phase: value, at: new Date().toISOString() }));
  await save();
};
let db, tenant, api, machine, blobs, quotaToken, meteringToken, failure, cleanupDeadline;
const secrets = [];
const sessions = [];
const safeFailure = (error) => ({
  name: error instanceof Error ? error.name : "UnknownError",
  ...(typeof error?.code === "string" ? { code: error.code.slice(0, 128) } : {}),
  ...(typeof error?.status === "number" ? { status: error.status } : {}),
  message: secrets
    .reduce(
      (message, secret) => (secret ? message.split(secret).join("[redacted]") : message),
      String(error?.message ?? "Unknown error"),
    )
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 700),
});
async function until(read, label, budget = 120_000) {
  const end = Math.min(Date.now() + budget, cleanupDeadline ?? workDeadline);
  while (Date.now() < end) {
    if (!cleanupDeadline) abort.signal.throwIfAborted();
    const value = await read();
    if (value) return value;
    await delay(1000);
  }
  throw new Error(`${label} timed out`);
}
async function boundedText(response, maximum = 1024 * 1024) {
  const reader = response.body?.getReader();
  assert(reader, "HTTP evidence has no body");
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      assert(length <= maximum, "HTTP evidence exceeded its byte bound");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function privateJson(base, token, path, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(35_000),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Private evidence endpoint ${path} failed (${response.status})`);
  }
  return JSON.parse(await boundedText(response, 64 * 1024));
}
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function settled(runId) {
  const run = await until(
    async () => {
      const current = await api.getRun(runId);
      return terminal(current) && current;
    },
    "Native Run settlement",
    360_000,
  );
  await until(async () => {
    const row = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    return !row.output_seal_id || row.output_sealed_at;
  }, "Ordered writer closure");
  return run;
}
async function finishedOnce(turn, expectedCommand) {
  const run = await settled(turn.runId);
  assert.equal(run.state, "completed", `Owned Run failed (${run.failure?.code ?? run.state})`);
  const conversation = await api.getConversation(run.sessionId);
  const visible = conversation.turns.find((value) => value.runId === run.runId);
  assert(visible, "Owned native Turn was not projected");
  const tools = visible.transcript.items.filter((item) => item.kind === "tool");
  assert.equal(
    tools.length,
    1,
    "Acceptance requires exactly one Bash per Run, without Tool retry/delegation",
  );
  assert.equal(tools[0].toolName, "bash");
  assert.equal(tools[0].status, "completed");
  assert.equal(
    tools[0].input.command,
    expectedCommand,
    "Model changed the bounded fixture command",
  );
  const history = await nativeHistory(db, { tenantId: tenant.tenantId, runId: run.runId });
  const results = nativeMessages(history).filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1, "Native history repeated the Tool");
  assert.equal(results[0].toolName, "bash");
  assert(!results[0].isError, "The native Bash returned an error");
  report.runs.push({
    runId: run.runId,
    sessionId: run.sessionId,
    state: run.state,
    commandSha256: createHash("sha256").update(expectedCommand).digest("hex"),
    usage: runUsage(history),
  });
}
async function machineState(state) {
  return until(
    async () => {
      const value = (await api.listDevelopmentEnvironments()).environments.find(
        (item) => item.environmentId === machine.environmentId,
      );
      if (value?.state === "failed")
        throw new Error(`Owned machine failed (${value.failureCode ?? "unknown"})`);
      return value?.state === state && value;
    },
    `Owned machine ${state}`,
    180_000,
  );
}
async function allocation() {
  return db
    .selectFrom("development_environments")
    .select(["allocation_id", "runtime_id", "runtime_name", "profile_key"])
    .where("tenant_id", "=", tenant.tenantId)
    .where("id", "=", machine.environmentId)
    .executeTakeFirstOrThrow();
}
async function readMarker(sessionId, relative, activeRunId) {
  return until(
    async () => {
      try {
        const file = await api.readWorkspaceFile(sessionId, relative);
        const bytes = Buffer.from(file.bytes);
        assert(bytes.byteLength <= 8192, "Fixture marker is oversized");
        return JSON.parse(bytes.toString());
      } catch (error) {
        if (![404, 409, 503].includes(error?.status)) throw error;
        const run = await api.getRun(activeRunId);
        if (terminal(run))
          throw new Error(
            `Native quota probe ended before ${relative} (${run.failure?.code ?? run.state})`,
          );
        return false;
      }
    },
    `Guest marker ${relative}`,
    180_000,
  );
}
async function receipts(to) {
  let query = db
    .selectFrom("resource_metering_events")
    .select(["id", "payload", "valuation", "payload_hash"])
    .where("tenant_id", "=", tenant.tenantId)
    .where("workspace_id", "=", machine.workspaceId)
    .where("from_at", ">=", new Date(started - 1000));
  if (to) query = query.where("from_at", "<", new Date(to));
  const rows = await query.orderBy("from_at").orderBy("id").limit(401).execute();
  assert(rows.length <= 400, "Owned receipt evidence exceeded its bounded window");
  for (let index = 0; index < rows.length; index += 128)
    parseResourceMeteringBatch({
      events: rows.slice(index, index + 128).map((row) => row.payload),
    });
  for (const row of rows) {
    assert.equal(row.id, row.payload.eventId);
    assert.equal(row.payload.resource.tenantId, tenant.tenantId);
    assert.equal(row.payload.resource.workspaceId, machine.workspaceId);
    if (row.payload.quality === "confirmed")
      assert.equal(
        row.payload.state,
        row.payload.resource.kind === "compute" ? "running" : "retained",
      );
    for (const segment of row.valuation)
      for (const kind of ["customer", "upstream_estimate"]) {
        assert.equal(
          segment[kind].state,
          row.payload.quality === "confirmed" ? "unpriced" : "unconfirmed",
        );
        assert.equal(
          segment[kind].amountPico,
          undefined,
          "Missing prices/uncertain intervals acquired a monetary amount",
        );
      }
  }
  return rows;
}
const positiveConfirmed = (row) =>
  row.payload.quality === "confirmed" && Date.parse(row.payload.to) > Date.parse(row.payload.from);
function resourceTotals(rows, resourceId) {
  const selected = rows.filter((row) => row.payload.resource.resourceId === resourceId);
  let confirmed = 0n,
    unconfirmed = 0n,
    capacityByteMs = 0n,
    cpuMilliMs = 0n,
    memoryByteMs = 0n;
  const intervals = [];
  for (const { payload: event } of selected) {
    const elapsed = BigInt(Date.parse(event.to) - Date.parse(event.from));
    if (event.quality === "unconfirmed") {
      unconfirmed += elapsed;
      continue;
    }
    confirmed += elapsed;
    if (elapsed > 0n) intervals.push([Date.parse(event.from), Date.parse(event.to)]);
    if (event.quantity.kind === "workspace")
      capacityByteMs += elapsed * BigInt(event.quantity.capacityBytes);
    else {
      cpuMilliMs += elapsed * BigInt(event.quantity.cpuMillis);
      memoryByteMs += elapsed * BigInt(event.quantity.memoryBytes);
    }
  }
  intervals.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < intervals.length; index++)
    assert(
      intervals[index][0] >= intervals[index - 1][1],
      "A shared physical resource has overlapping confirmed intervals",
    );
  return {
    confirmedMilliseconds: confirmed.toString(),
    unconfirmedMilliseconds: unconfirmed.toString(),
    capacityByteMilliseconds: capacityByteMs.toString(),
    cpuMilliMilliseconds: cpuMilliMs.toString(),
    memoryByteMilliseconds: memoryByteMs.toString(),
  };
}

try {
  const connection = (await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim();
  secrets.push(connection);
  const endpoint = new URL(connection);
  endpoint.hostname = serviceAddress("postgres");
  secrets.push(endpoint.toString(), decodeURIComponent(endpoint.password));
  db = createDatabase({
    connectionString: endpoint.toString(),
    maxConnections: 2,
    readTimeoutMs: 5000,
  });
  report.contract = await assertLiveContract(db, runtimeDirectory, {
    sessionRuntimeReplacement: 1,
  });
  quotaToken = (
    await readFile(`${runtimeDirectory}/secrets/workspace-volume-gateway-token`, "utf8")
  ).trim();
  meteringToken = (
    await readFile(`${runtimeDirectory}/secrets/metering-ingest-token`, "utf8")
  ).trim();
  secrets.push(quotaToken, meteringToken);
  const quotaUrl = `http://${serviceAddress("workspace-quota")}:4510`;
  const meteringUrl = `http://${serviceAddress("metering")}:3000`;
  const pool = await privateJson(quotaUrl, quotaToken, "/v1/pool");
  assert(
    pool.availableBytes >= 2 * GiB,
    "At least 2 GiB of backing-pool headroom is required to distinguish project quota from pool exhaustion",
  );
  report.pool = {
    id: pool.id,
    totalBytes: pool.totalBytes,
    availableBytesBefore: pool.availableBytes,
  };
  const health = await fetch(`${meteringUrl}/health/ready`, { signal: AbortSignal.timeout(5000) });
  assert(health.ok, "Independent resource receiver is not ready");
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-resource-${randomUUID()}`,
    ownerDisplayName: "Resource accounting acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  secrets.push(tenant.credential.token);
  report.tenantId = tenant.tenantId;
  await save();
  const origin = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
  api = new PiCloudApi(
    (path, init = {}) =>
      fetch(new URL(String(path), origin), {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(90_000),
      }),
    tenant.credential.token,
  );
  const rates = await fetch(`${origin}/v1/resource-billing/rates`, {
    headers: { authorization: `Bearer ${tenant.credential.token}` },
    signal: AbortSignal.timeout(5000),
  });
  assert(rates.ok);
  assert.deepEqual(
    JSON.parse(await boundedText(rates, 65536)),
    [],
    "The owned fixture must have no resource tariffs",
  );

  await phase("create one owned 1 GiB starter machine and two shared Sessions");
  machine = await api.createDevelopmentEnvironment(
    `Resource receipt ${randomUUID().slice(0, 8)}`,
    "starter",
    newIdempotencyKey("resource-machine"),
    1,
  );
  report.machine = {
    environmentId: machine.environmentId,
    projectId: machine.projectId,
    workspaceId: machine.workspaceId,
    profileKey: machine.profileKey,
    cpuCount: machine.cpuCount,
    memoryMiB: machine.memoryMiB,
  };
  await save();
  await machineState("running");
  const physical = await allocation();
  assert(physical.runtime_id && physical.runtime_name && physical.allocation_id);
  report.allocation = physical;
  for (const title of ["Quota boundary", "Shared allocation read"])
    sessions.push(
      await api.createSession(
        machine.projectId,
        machine.workspaceId,
        title,
        "development_environment",
        undefined,
        "/home/user",
        { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
      ),
    );
  report.sessionIds = sessions.map((session) => session.sessionId);
  const initialCapacity = await until(async () => {
    const value = await api.workspaceCapacity(machine.workspaceId);
    assert.equal(value.capacityBytes, GiB);
    return !value.pending && value;
  }, "Initial kernel capacity acknowledgement");
  const initialRows = await until(async () => {
    const rows = await receipts();
    return (
      rows.some(
        (row) =>
          positiveConfirmed(row) &&
          row.payload.resource.kind === "workspace" &&
          row.payload.quantity.capacityBytes === GiB,
      ) &&
      rows.some((row) => positiveConfirmed(row) && row.payload.resource.kind === "compute") &&
      rows
    );
  }, "Source compute and 1 GiB retention receipts");
  const firstCompute = initialRows.find(
    (row) => positiveConfirmed(row) && row.payload.resource.kind === "compute",
  );
  assert.equal(firstCompute.payload.resource.resourceId, physical.allocation_id);
  assert.deepEqual(
    firstCompute.payload.quantity,
    { kind: "compute", cpuMillis: machine.cpuCount * 1000, memoryBytes: machine.memoryMiB * MiB },
    "Idle source allocation differs from the accepted profile",
  );
  report.allocatedIdleCompute = {
    receiptId: firstCompute.id,
    from: firstCompute.payload.from,
    to: firstCompute.payload.to,
    quantity: firstCompute.payload.quantity,
    beforeAnyRun: true,
  };
  const firstStorage = initialRows.find(
    (row) => positiveConfirmed(row) && row.payload.resource.kind === "workspace",
  );
  const volumeId = workspaceVolumeId({
    tenantId: tenant.tenantId,
    workspaceId: machine.workspaceId,
  });
  const generation = firstStorage.payload.resource.resourceId.slice(volumeId.length + 1);
  assert.equal(firstStorage.payload.resource.resourceId, `${volumeId}:${generation}`);
  assert.match(generation, /^[0-9a-f]{64}$/);
  const quotaIdentity = {
    tenantId: tenant.tenantId,
    workspaceId: machine.workspaceId,
    volumeId,
    generation,
  };
  const readQuota = () => privateJson(quotaUrl, quotaToken, "/v1/quota/read", quotaIdentity);
  const beforeQuota = await readQuota();
  assert.equal(beforeQuota.state, "ready");
  assert.equal(beforeQuota.capacityBytes, GiB);
  assert.equal(beforeQuota.revision, initialCapacity.revision);
  report.initialQuota = beforeQuota;

  await phase("Luna Bash reaches the real 1 GiB kernel quota");
  const name = `resource-accounting-${randomUUID()}`,
    directory = `/home/user/${name}`;
  const marker = `RESOURCE_${randomUUID().replaceAll("-", "")}`;
  const gateId = randomUUID(),
    gateName = "resource-capacity-grown.txt";
  const gate = `/home/user/${uploadRelativePath(gateId, gateName)}`;
  const command = `LC_ALL=C python3 - <<'PY'\n${[
    "import ctypes,errno,json,os,subprocess,time",
    `directory=${JSON.stringify(directory)}`,
    `gate=${JSON.stringify(gate)}`,
    `marker=${JSON.stringify(marker)}`,
    "assert os.getuid()==1000, 'Quota proof must run as the ordinary Tool user'",
    "os.mkdir(directory,0o700)",
    "normal=os.path.join(directory,'normal.txt')",
    "with open(normal,'x') as out: out.write(marker+'\\n'); out.flush(); os.fsync(out.fileno())",
    "large=os.path.join(directory,'allocation.bin')",
    "def publish(name,value):",
    "    temporary=os.path.join(directory,name+'.tmp')",
    "    with open(temporary,'w') as out: json.dump(value,out); out.flush(); os.fsync(out.fileno())",
    "    os.replace(temporary,os.path.join(directory,name))",
    "libc=ctypes.CDLL(None,use_errno=True)",
    "fallocate=getattr(libc,'fallocate',None)",
    "if fallocate is not None: fallocate.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_longlong,ctypes.c_longlong]; fallocate.restype=ctypes.c_int",
    "def allocate(method):",
    "    if method=='fallocate':",
    "        with open(large,'xb') as out:",
    "            if fallocate(out.fileno(),0,0,1100*1024*1024)!=0:",
    "                code=ctypes.get_errno(); raise OSError(code,os.strerror(code))",
    "            os.fsync(out.fileno())",
    "    else:",
    "        result=subprocess.run(['/usr/bin/dd','if=/dev/zero','of='+large,'bs=1048576','count=1024','conv=fsync','status=none'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=80)",
    "        if result.returncode:",
    "            detail=result.stderr.decode('utf8','replace')",
    "            code=errno.EDQUOT if 'Disk quota exceeded' in detail else errno.ENOSPC if 'No space left on device' in detail else errno.EIO",
    "            raise OSError(code,detail[:1024])",
    "method='fallocate' if fallocate is not None else 'dd'",
    "try:",
    "    allocate(method)",
    "except OSError as unsupported:",
    "    if method=='fallocate' and unsupported.errno in (errno.ENOSYS,errno.EOPNOTSUPP,errno.EINVAL):",
    "        if os.path.exists(large): os.unlink(large)",
    "        method='dd'",
    "        try: allocate(method)",
    "        except OSError as quota: blocked=quota",
    "        else: raise AssertionError('The 1 GiB quota allowed a full GiB beside the normal file')",
    "    else: blocked=unsupported",
    "else: raise AssertionError('The 1 GiB quota allowed 1100 MiB')",
    "assert blocked.errno in (errno.EDQUOT,errno.ENOSPC), 'Failure was not quota/space exhaustion: '+str(blocked)",
    "if os.path.exists(large): os.unlink(large)",
    "publish('blocked.json',{'phase':'blocked','method':method,'errno':blocked.errno,'errnoName':errno.errorcode[blocked.errno],'uid':os.getuid(),'normal':marker})",
    "deadline=time.monotonic()+150",
    "while not os.path.isfile(gate):",
    "    if time.monotonic()>deadline: raise TimeoutError('Operator growth gate did not arrive')",
    "    time.sleep(0.2)",
    "assert open(gate).read()=='CAPACITY_2_GIB_CONFIRMED'",
    "allocate(method)",
    "stat=os.stat(large)",
    "expected=(1100 if method=='fallocate' else 1024)*1024*1024",
    "assert stat.st_size==expected and stat.st_blocks*512>=expected, 'Allocation did not consume real filesystem blocks'",
    "publish('grown.json',{'phase':'grown','method':method,'sizeBytes':stat.st_size,'allocatedBytes':stat.st_blocks*512,'normal':marker})",
    "print('RESOURCE_CAPACITY_GROWN')",
  ].join("\n")}\nPY`;
  const first = await api.acceptTurn(
    sessions[0].sessionId,
    `Call bash exactly once, with timeout 300 seconds and command exactly this JSON string: ${JSON.stringify(command)}. It intentionally catches a quota error, then waits for an operator upload after capacity growth. Wait for that same Bash. Do not retry, modify the command, call other tools or delegate. Then reply RESOURCE_CAPACITY_GROWN.`,
    newIdempotencyKey("resource-quota"),
    "low",
  );
  report.activeRunId = first.runId;
  await save();
  const blocked = await readMarker(sessions[0].sessionId, `${name}/blocked.json`, first.runId);
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.normal, marker);
  assert.equal(blocked.uid, 1000);
  assert(["EDQUOT", "ENOSPC"].includes(blocked.errnoName));
  assert(["fallocate", "dd"].includes(blocked.method));
  const fullBoundary = await until(async () => {
    const value = await readQuota();
    return value.usedBytes <= beforeQuota.usedBytes + MiB && value;
  }, "Failed quota allocation physically released");
  assert.equal(fullBoundary.capacityBytes, GiB);
  assert.equal(fullBoundary.state, "ready");
  assert(
    (await privateJson(quotaUrl, quotaToken, "/v1/pool")).availableBytes >= 2 * GiB,
    "Backing-pool exhaustion could have caused the quota failure",
  );
  report.quotaFailure = { ...blocked, kernel: fullBoundary };

  await phase("grow the same Workspace to 2 GiB and acknowledge actual kernel enforcement");
  const desired = await api.growWorkspaceCapacity(machine.workspaceId, 2);
  assert.equal(desired.capacityBytes, 2 * GiB);
  assert(desired.revision > initialCapacity.revision);
  const enforced = await until(
    async () => {
      const value = await api.workspaceCapacity(machine.workspaceId);
      const kernel = await readQuota();
      return (
        !value.pending &&
        value.revision === desired.revision &&
        kernel.state === "ready" &&
        kernel.revision === desired.revision &&
        kernel.capacityBytes === 2 * GiB && { desired: value, kernel }
      );
    },
    "2 GiB source enforcement",
    90000,
  );
  const retry = await api.growWorkspaceCapacity(machine.workspaceId, 1);
  assert.equal(retry.capacityBytes, 2 * GiB);
  assert.equal(retry.revision, desired.revision, "An older minimum shrank/reversioned capacity");
  report.growth = enforced;
  const uploaded = await api.uploadWorkspaceFile(
    sessions[0].sessionId,
    gateId,
    new Blob(["CAPACITY_2_GIB_CONFIRMED"]),
    gateName,
  );
  assert.equal(uploaded.path, gate, "Operator gate was placed outside the bound directory");
  const grown = await readMarker(sessions[0].sessionId, `${name}/grown.json`, first.runId);
  await finishedOnce(first, command);
  assert.equal(grown.phase, "grown");
  assert.equal(grown.normal, marker);
  assert.equal(grown.method, blocked.method);
  assert.equal(grown.sizeBytes, (grown.method === "fallocate" ? 1100 : 1024) * MiB);
  assert(grown.allocatedBytes >= grown.sizeBytes && grown.allocatedBytes < 2 * GiB);
  const allocatedQuota = await readQuota();
  assert.equal(allocatedQuota.capacityBytes, 2 * GiB);
  assert(
    allocatedQuota.usedBytes >= grown.sizeBytes,
    "Kernel usage did not account the actual guest allocation",
  );
  report.guestAllocation = { ...grown, kernel: allocatedQuota };

  await phase("use a second Session on the same allocation and remove the large file");
  const sharedCommand = `python3 - <<'PY'\nimport os,json\np=${JSON.stringify(directory)}\nassert os.getuid()==1000\nassert open(p+'/normal.txt').read()==${JSON.stringify(marker + "\n")}\nassert os.stat(p+'/allocation.bin').st_size==${grown.sizeBytes}\nos.unlink(p+'/allocation.bin')\nprint('RESOURCE_SHARED_AND_CLEAN')\nPY`;
  const second = await api.acceptTurn(
    sessions[1].sessionId,
    `Call bash exactly once with timeout 30 seconds and command exactly this JSON string: ${JSON.stringify(sharedCommand)}. Do not retry, modify it, use other tools or delegate. Then reply RESOURCE_SHARED_AND_CLEAN.`,
    newIdempotencyKey("resource-shared"),
    "low",
  );
  report.activeRunId = second.runId;
  await save();
  await finishedOnce(second, sharedCommand);
  assert.deepEqual(
    await allocation(),
    physical,
    "Shared Sessions changed the physical allocation/profile",
  );
  const cleanedQuota = await until(async () => {
    const value = await readQuota();
    return (
      value.capacityBytes === 2 * GiB &&
      value.usedBytes <= fullBoundary.usedBytes + 16 * MiB &&
      value
    );
  }, "Large fixture file removed");
  report.sharedAllocation = {
    sessions: sessions.length,
    physicalAllocations: 1,
    kernelAfterFileRemoval: cleanedQuota,
  };
  const rowsAfterGrowth = await until(async () => {
    const rows = await receipts();
    return (
      rows.some(
        (row) =>
          positiveConfirmed(row) &&
          row.payload.resource.kind === "workspace" &&
          row.payload.quantity.capacityBytes === 2 * GiB,
      ) && rows
    );
  }, "2 GiB source retention interval");
  const computeResourceIds = [
    ...new Set(
      rowsAfterGrowth
        .filter((row) => row.payload.resource.kind === "compute")
        .map((row) => row.payload.resource.resourceId),
    ),
  ];
  const storageResourceIds = [
    ...new Set(
      rowsAfterGrowth
        .filter((row) => row.payload.resource.kind === "workspace")
        .map((row) => row.payload.resource.resourceId),
    ),
  ];
  assert.deepEqual(computeResourceIds, [physical.allocation_id]);
  assert.deepEqual(storageResourceIds, [`${volumeId}:${generation}`]);
  for (const { payload: event } of rowsAfterGrowth.filter(
    (row) => row.payload.resource.kind === "compute",
  ))
    assert.deepEqual(
      event.quantity,
      { kind: "compute", cpuMillis: machine.cpuCount * 1000, memoryBytes: machine.memoryMiB * MiB },
      "Source compute quantity differs from the accepted workload profile",
    );

  await phase("pause compute while the same 2 GiB Workspace keeps accruing confirmed retention");
  await until(async () => {
    const row = await db
      .selectFrom("development_environments")
      .select(["agent_activation_id", "terminal_active"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("id", "=", machine.environmentId)
      .executeTakeFirstOrThrow();
    return row.agent_activation_id === null && !row.terminal_active;
  }, "Machine Agent binding retirement");
  const pauseKey = newIdempotencyKey("resource-pause");
  await api.developmentEnvironmentAction(machine.environmentId, "pause", pauseKey);
  await machineState("paused");
  report.pauseObservedAt = new Date().toISOString();
  // The final unsampled compute interval is explicitly uncertain. Exclude a
  // full 30-second collection grace before measuring the stable paused window.
  await delay(31_000, undefined, { signal: abort.signal });
  const { rows: clocks } = await sql`select clock_timestamp() as now`.execute(db);
  const pausedFrom = clocks[0].now.toISOString();
  const pausedStorage = await until(
    async () => {
      const rows = await receipts();
      return rows.find(
        (row) =>
          positiveConfirmed(row) &&
          row.payload.resource.kind === "workspace" &&
          row.payload.quantity.capacityBytes === 2 * GiB &&
          Date.parse(row.payload.from) >= Date.parse(pausedFrom) &&
          Date.parse(row.payload.to) - Date.parse(row.payload.from) >= 20_000,
      );
    },
    "Storage interval wholly inside stable VM pause",
    150_000,
  );
  await machineState("paused");
  const pausedTo = pausedStorage.payload.to;
  const pausedRows = await receipts();
  assert(
    !pausedRows.some(
      (row) =>
        positiveConfirmed(row) &&
        row.payload.resource.kind === "compute" &&
        Date.parse(row.payload.from) < Date.parse(pausedTo) &&
        Date.parse(row.payload.to) > Date.parse(pausedFrom),
    ),
    "Confirmed compute time accrued during the stable paused window",
  );
  assert.equal((await readQuota()).capacityBytes, 2 * GiB);
  report.pause = {
    from: pausedFrom,
    to: pausedTo,
    confirmedComputeMilliseconds: "0",
    storageReceiptId: pausedStorage.id,
    storageCapacityBytes: 2 * GiB,
    unconfirmedComputeIntervalsObserved: pausedRows.filter(
      (row) => row.payload.resource.kind === "compute" && row.payload.quality === "unconfirmed",
    ).length,
    unconfirmedIntervalsHaveNoAmounts: true,
  };

  await phase("replay real receipts and inspect authenticated resource statements");
  const duplicates = [
    pausedRows.find((row) => positiveConfirmed(row) && row.payload.resource.kind === "compute"),
    pausedStorage,
  ];
  assert(duplicates.every(Boolean));
  for (let repeat = 0; repeat < 2; repeat++) {
    const ack = await privateJson(meteringUrl, meteringToken, "/internal/v1/resource-metering", {
      events: duplicates.map((row) => row.payload),
    });
    assert.equal(ack.accepted, duplicates.length);
  }
  const originIds = duplicates.map((row) => row.id);
  const { rows: duplicated } = await sql`select id,payload_hash from resource_metering_events
    where tenant_id=${tenant.tenantId}::uuid and payload->>'eventId'=any(${originIds}::text[]) order by id`.execute(
    db,
  );
  assert.equal(
    duplicated.length,
    originIds.length,
    "Receipt replay created a second accounting fact",
  );
  for (const row of duplicated)
    assert.equal(
      row.payload_hash,
      duplicates.find((original) => original.id === row.id)?.payload_hash,
    );
  report.receiptReplay = { originalIds: originIds, deliveries: 3, storedFacts: duplicated.length };
  const query = new URLSearchParams({
    from: new Date(started - 1000).toISOString(),
    to: new Date().toISOString(),
    workspaceId: machine.workspaceId,
    limit: "50",
  });
  const beforeStatement = await receipts(query.get("to"));
  const statement = await api.resourceBilling(query);
  const afterStatement = await receipts(query.get("to"));
  assert.equal(statement.next, null);
  assert.equal(statement.items.length, 2, "Shared Sessions were billed as extra resources");
  for (const item of statement.items) {
    assert.equal(item.resource.tenantId, tenant.tenantId);
    assert.equal(item.resource.workspaceId, machine.workspaceId);
    const lower = resourceTotals(beforeStatement, item.resource.resourceId),
      upper = resourceTotals(afterStatement, item.resource.resourceId);
    assert(
      BigInt(item.confirmedMilliseconds) >= BigInt(lower.confirmedMilliseconds) &&
        BigInt(item.confirmedMilliseconds) <= BigInt(upper.confirmedMilliseconds),
      "Public statement duration differs from source intervals",
    );
    assert(
      BigInt(item.unconfirmedMilliseconds) >= BigInt(lower.unconfirmedMilliseconds) &&
        BigInt(item.unconfirmedMilliseconds) <= BigInt(upper.unconfirmedMilliseconds),
    );
    for (const charge of item.charges)
      assert.equal(charge.amountPico, null, "An unpriced/uncertain statement has an amount");
  }
  assert.deepEqual(
    statement.items.map((item) => item.resource.resourceId).sort(),
    [physical.allocation_id, `${volumeId}:${generation}`].sort(),
  );
  const storage = statement.items.find((item) => item.resource.kind === "workspace");
  assert.equal(storage.quantity.capacityBytes, 2 * GiB);
  assert.deepEqual(statement.items.find((item) => item.resource.kind === "compute").quantity, {
    kind: "compute",
    cpuMillis: machine.cpuCount * 1000,
    memoryBytes: machine.memoryMiB * MiB,
  });
  const summary = await api.resourceBillingSummary(query);
  assert.equal(summary.collectionEnabled, false);
  assert.deepEqual([...new Set(summary.categories.map((item) => item.resourceKind))].sort(), [
    "compute",
    "workspace",
  ]);
  assert(
    summary.categories.every(
      (item) => ["unpriced", "unconfirmed"].includes(item.state) && item.amountPico === null,
    ),
  );
  const exportedResponse = await fetch(`${origin}/v1/resource-billing/export?${query}`, {
    headers: { authorization: `Bearer ${tenant.credential.token}` },
    signal: AbortSignal.timeout(15000),
  });
  assert(exportedResponse.ok);
  const exported = (await boundedText(exportedResponse, 1024 * 1024))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(exported.length > 0 && exported.length <= 400);
  assert.equal(new Set(exported.map((event) => event.eventId)).size, exported.length);
  assert(
    exported.every(
      (event) =>
        event.resource.tenantId === tenant.tenantId &&
        event.resource.workspaceId === machine.workspaceId,
    ),
  );
  report.statements = statement;
  report.summary = summary;
  report.intervalEvidence = afterStatement.map(({ payload, valuation }) => ({
    ...payload,
    valuation,
  }));
  report.quantities = Object.fromEntries(
    [physical.allocation_id, `${volumeId}:${generation}`].map((id) => [
      id,
      resourceTotals(afterStatement, id),
    ]),
  );
  report.exportedReceipts = exported.length;
  report.sourceQuantityIsAllocationNotUtilization = true;
  report.sharedWorkspaceCountedOnce = true;
  report.kernelQuotaAndGrowthVerified = true;
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = { phase: report.phase, ...safeFailure(error) };
} finally {
  cleanupDeadline = Date.now() + 5 * 60_000;
  const errors = [];
  const clean = async (work) => {
    try {
      await work();
    } catch (error) {
      errors.push(safeFailure(error));
    }
  };
  if (tenant && api) {
    await clean(() =>
      phase("retire only owned Runs, machine and Workspace before financial fixture purge"),
    );
    await clean(async () => {
      // Discover by the owned tenant as well: a lost create response must not
      // leave a Session or allocation outside the cleanup inventory.
      const owned = await db
        .selectFrom("sessions")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute();
      for (const session of owned) {
        const runs = await db
          .selectFrom("runs")
          .select(["id", "turn_id"])
          .where("tenant_id", "=", tenant.tenantId)
          .where("session_id", "=", session.id)
          .execute();
        await settleOwnedAcceptanceRuns(api, session.id, runs, settled);
        await until(async () => {
          try {
            await api.deleteConversation(session.id);
            return true;
          } catch (error) {
            if (error?.status === 404) return true;
            if ([409, 503].includes(error?.status)) return false;
            throw error;
          }
        }, "Owned Conversation deletion");
      }
    });
    await clean(async () => {
      const machines = await db
        .selectFrom("development_environments")
        .select(["id", "workspace_id"])
        .where("tenant_id", "=", tenant.tenantId)
        .execute();
      for (const owned of machines) {
        const key = newIdempotencyKey("resource-release");
        await until(async () => {
          try {
            await api.developmentEnvironmentAction(owned.id, "release", key);
            return true;
          } catch (error) {
            if (error?.status === 404) {
              const current = await db
                .selectFrom("development_environments")
                .select(["state", "allocation_closed", "allocation_absent", "runtime_name"])
                .where("tenant_id", "=", tenant.tenantId)
                .where("id", "=", owned.id)
                .executeTakeFirstOrThrow();
              if (
                current.state === "released" &&
                current.allocation_closed &&
                current.allocation_absent &&
                current.runtime_name === null
              )
                return true;
            }
            if ([409, 503].includes(error?.status)) return false;
            throw error;
          }
        }, "Owned machine release admission");
      }
      await until(
        async () => {
          const pending = await db
            .selectFrom("development_environments")
            .select("id")
            .where("tenant_id", "=", tenant.tenantId)
            .where((eb) =>
              eb.or([
                eb("state", "!=", "released"),
                eb("allocation_closed", "=", false),
                eb("allocation_absent", "=", false),
                eb("runtime_name", "is not", null),
                eb("agent_activation_id", "is not", null),
                eb("terminal_active", "=", true),
              ]),
            )
            .limit(1)
            .execute();
          return pending.length === 0;
        },
        "Confirmed physical absence of owned allocations",
        180000,
      );
      await until(
        async () => {
          const pending = await db
            .selectFrom("workspaces")
            .select("id")
            .where("tenant_id", "=", tenant.tenantId)
            .where((eb) =>
              eb.or([eb("deleted_at", "is", null), eb("storage_purged_at", "is", null)]),
            )
            .limit(1)
            .execute();
          return pending.length === 0;
        },
        "Owned Volume and kernel quota cleanup",
        180000,
      );
    });
    if (!errors.length)
      await clean(async () => {
        await until(
          async () =>
            !(
              await db
                .selectFrom("outbox")
                .select("id")
                .where("tenant_id", "=", tenant.tenantId)
                .where("published_at", "is", null)
                .limit(1)
                .execute()
            ).length,
          "Owned control publication",
        );
        const blobCredentials = JSON.parse(
          await readFile(`${runtimeDirectory}/secrets/session-image-s3-credentials.json`, "utf8"),
        );
        secrets.push(blobCredentials.accessKeyId, blobCredentials.secretAccessKey);
        blobs = new S3AttachmentBlobStore({
          endpoint: `http://${serviceAddress("session-images")}:8333`,
          region: "us-east-1",
          bucket: "pi-cloud-session-images",
          ...blobCredentials,
        });
        // The maintained helper requires physical settlement and source-delivery
        // closure before discarding this disposable account's financial records.
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
        report.cleanupConfirmed = true;
      });
  } else report.cleanupConfirmed = !tenant;
  if (errors.length) {
    report.cleanupErrors = errors;
    failure ??= new Error("Owned cleanup remains incomplete");
  }
  try {
    await blobs?.close();
  } catch (error) {
    report.blobCloseFailure = safeFailure(error);
    failure ??= error;
  }
  await db?.destroy();
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  await save();
}
console.log(
  JSON.stringify({ accepted: report.accepted, cleanupConfirmed: report.cleanupConfirmed, output }),
);
if (failure || !report.cleanupConfirmed)
  throw new Error(
    "Resource accounting acceptance failed; inspect the private report and retained owned identities",
  );
