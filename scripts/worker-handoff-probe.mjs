import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { Admin } from "@platformatic/kafka";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { PiWorkerRuntime } from "../packages/supervisor-host/src/runtime.ts";
import { PostgresRuntimeObjectStore } from "../packages/runtime-core/src/postgres-runtime-object-store.ts";
import {
  FactChannelService,
  WebSocketAcceptedFactIngestor,
} from "../packages/runtime-core/src/accepted-fact-channel.ts";
import { PostgresExecutionLeaseAuthorityGate } from "../packages/runtime-core/src/session-lease-authority-gate.ts";
import { PostgresAcceptedFactProgressStore } from "../packages/runtime-core/src/postgres-accepted-fact-progress.ts";
import { KafkaAcceptedFactBus } from "../packages/runtime-core/src/kafka-accepted-fact.ts";
import { KafkaAcceptedFactConsumer } from "../packages/runtime-core/src/kafka-accepted-fact-consumer.ts";
import { KafkaLiveSessionTail } from "../packages/runtime-core/src/kafka-live-session-tail.ts";
import { ExecutionStreamProjector } from "../packages/runtime-core/src/execution-stream-projection.ts";
import { AcceptedFactTerminalOutboxRelay } from "../packages/runtime-core/src/accepted-fact-terminal-outbox-relay.ts";
import { SessionLeaseCoordinator } from "../packages/runtime-core/src/session-lease-coordinator.ts";
import { AcceptedFactIngestGateway } from "../packages/control-plane/src/accepted-fact-ingest-gateway.ts";
import { createControlPlaneRuntime } from "../packages/control-plane/src/control-plane-runtime.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PostgresTenantApiAuthenticator } from "../packages/control-plane/src/tenant-identity.ts";
import { ProductionHttpGateway } from "../packages/control-plane/src/production-http-gateway.ts";
import {
  SupervisorBootProvisioner,
  SupervisorProvisioningGateway,
  PostgresSupervisorCredentialAuthorizer,
} from "../packages/control-plane/src/supervisor-boot-provisioner.ts";
import {
  HttpSupervisorManagementClient,
  RoutedHttpSupervisorOwnerBoundary,
  RoutedHttpSandboxAssignmentInventory,
  HttpSupervisorSteerBackend,
} from "../packages/control-plane/src/http-supervisor-management.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const db = createDatabase({
  connectionString: process.env.HANDOFF_DATABASE_URL,
  maxConnections: 8,
});
const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"];
const token = "t".repeat(48),
  management = "m".repeat(48),
  enrollment = "e".repeat(48);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, label, ms = 120000) => {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(100);
  }
};
const busFor = (topic) =>
  new KafkaAcceptedFactBus({
    brokers,
    topic,
    clientId: randomUUID(),
    partitions: 3,
    replicas: 3,
    retentionMs: 3600000,
  });

if (process.argv[2] === "ingress") {
  const [input] = await once(process, "message");
  const bus = busFor(input.topic);
  await bus.start();
  let armed;
  process.on("message", (message) => {
    if (message.type === "arm") {
      armed = message.runId;
      process.send({ type: "armed" });
    }
  });
  const channels = new FactChannelService({
    authority: new PostgresExecutionLeaseAuthorityGate({ database: db }),
    progress: new PostgresAcceptedFactProgressStore(db),
    instanceId: randomUUID(),
    bus: {
      checkHealth: () => bus.checkHealth(),
      append: async (fact) => {
        const entry =
          fact.kind === "pi_session_mutation" && fact.operation.kind === "append_items"
            ? fact.operation.items.find(
                (item) =>
                  item.kind === "append_entry" &&
                  item.entry.type === "message" &&
                  item.entry.message.role === "assistant",
              )?.entry
            : undefined;
        if (armed === fact.scope.runId && entry) {
          armed = undefined;
          await new Promise((resolve) =>
            process.send(
              {
                type: "paused",
                factId: fact.factId,
                entryId: entry.id,
                runId: fact.scope.runId,
                eventIds: fact.events.map((event) => event.eventId),
              },
              resolve,
            ),
          );
          process.kill(process.pid, "SIGSTOP");
        }
        return bus.append(fact);
      },
    },
  });
  const server = Fastify({ logger: false });
  await server.register(fastifyWebsocket, { options: { perMessageDeflate: false } });
  new AcceptedFactIngestGateway({ channels, serviceToken: token }).install(server);
  const url = await server.listen({ port: 0, host: "127.0.0.1" });
  process.send({ type: "ready", url });
  process.on("message", (message) => {
    if (message.type === "close")
      void (async () => {
        await server.close();
        await channels.close().catch(() => {});
        await bus.close();
        await db.destroy();
        process.disconnect();
      })();
  });
} else if (process.argv[2] === "worker") {
  const [input] = await once(process, "message");
  const index = input.index;
  const state = `/tmp/handoff-worker-${index}`;
  await mkdir(state, { recursive: true });
  const factChannels = new WebSocketAcceptedFactIngestor({
    baseUrl: input.ingress,
    serviceToken: token,
    allowInsecureHttp: true,
  });
  const config = {
    supervisorId: `handoff-${index === 1 ? "a" : "b"}`,
    controlPlaneBaseUrl: input.api,
    supervisorWebSocketUrl: input.api.replace("http", "ws") + "/internal/v1/supervisor",
    allowInsecureInternalHttp: true,
    enrollmentToken: enrollment,
    managementToken: management,
    toolBrokerServiceToken: token,
    providerGatewayBaseUrl: input.provider,
    providerGatewayApiKey: token,
    databaseUrl: process.env.HANDOFF_DATABASE_URL,
    databaseNotificationUrl: process.env.HANDOFF_DATABASE_URL,
    workerEventIngestToken: token,
    managementHost: "0.0.0.0",
    managementPort: 4100 + index,
    managementAdvertisedBaseUrl: `http://handoff-${index === 1 ? "a" : "b"}:${4100 + index}`,
    maxConcurrentSessions: 2,
    databaseMaxConnections: 8,
    subagentMaximumDepth: 4,
    subagentMaximumNodes: 32,
    subagentMaximumConcurrent: 1,
    toolBrokerBaseUrls: ["http://127.0.0.1:9"],
    toolBrokerRequestTimeoutMs: 1000,
    trustedWorkspaceDirectory: state,
    bootStateDirectory: state + "/boot",
    runtimeObjectCacheTtlMs: 600000,
    runtimeObjectCacheMaximumEntries: 32,
    runtimeObjectCacheMaximumBytes: 1024 * 1024,
    modelGatewayHost: "127.0.0.1",
    modelGatewayPort: 4200 + index,
    modelGatewayAdvertisedBaseUrl: `http://127.0.0.1:${4200 + index}`,
    modelGatewayCapabilityTtlMs: 360000,
    modelGatewayMaximumRequestsPerTurn: 20,
    modelGatewayUpstreamConnectTimeoutMs: 10000,
    modelGatewayUpstreamIdleTimeoutMs: 120000,
    piModelRequestTimeoutMs: 120000,
    piTurnTimeoutMs: 300000,
  };
  const runtime = new PiWorkerRuntime({
    config,
    database: db,
    objectStore: new PostgresRuntimeObjectStore(db),
    factChannels,
  });
  try {
    await runtime.start();
    process.send({ type: "ready", identity: runtime.identity });
  } catch (error) {
    process.send({ type: "startup-error", message: error.message });
    throw error;
  }
  process.on("message", (message) => {
    if (message.type === "close")
      void (async () => {
        await runtime.close();
        await factChannels.close();
        await db.destroy();
        process.disconnect();
      })();
  });
} else {
  const topic = `pi-cloud.handoff-api.${randomUUID()}`,
    groupId = topic,
    instanceId = randomUUID();
  const bus = busFor(topic),
    admin = new Admin({ clientId: randomUUID(), bootstrapBrokers: brokers });
  let consumer, tail, relay, cp, provider, stream;
  const children = [];
  const abort = new AbortController();
  const report = {
    format: "pi-cloud.worker-handoff-probe.v1",
    checkedAt: new Date().toISOString(),
    normal: {},
    fault: {},
    maintenance: [],
    facts: [],
    usage: [],
  };
  const requests = [];
  let sample = 0;
  let faultInfo;
  let eventCount = 0;
  const shownEventIds = new Set(),
    tailConsumedFactIds = new Set();
  const spawn = async (role, input) => {
    const child = fork(new URL(import.meta.url), [role], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    children.push(child);
    let ready;
    child.on("message", (value) => {
      if (value.type === "ready" || value.type === "startup-error") ready = value;
      if (value.type === "paused") faultInfo = value;
      if (value.type === "armed") child.armed = true;
    });
    child.send(input);
    await waitFor(() => ready || child.exitCode !== null, `${role} ready`);
    if (!ready || ready.type === "startup-error")
      throw new Error(`${role} startup failed: ${ready?.message ?? child.exitCode}`);
    return { child, ...ready };
  };
  try {
    await runMigrations(db, "up");
    await createPrivateTenant(db, {
      slug: "bootstrap",
      ownerDisplayName: "Probe operator",
      initialModel: { provider: "deepseek", modelId: "deepseek-v4-flash" },
    });
    await bus.start();
    const projector = new ExecutionStreamProjector(db);
    const makeConsumer = () =>
      new KafkaAcceptedFactConsumer({
        brokers,
        topic,
        clientId: randomUUID(),
        groupId,
        mode: "earliest",
        commitEvery: 64,
        onReset: () => projector.reset(),
        handler: async (record) => {
          await projector.project(record);
          if (record.fact.kind !== "agent_event")
            report.facts.push({
              factId: record.fact.factId,
              runId: record.fact.scope.runId,
              kind: record.fact.kind,
              offset: String(record.offset),
              partition: record.partition,
            });
        },
      });
    consumer = makeConsumer();
    await consumer.start();
    tail = new KafkaLiveSessionTail({
      database: db,
      brokers,
      topic,
      clientId: randomUUID(),
      instanceId,
    });
    const projectTail = tail.projectRecord.bind(tail),
      failedTailFacts = new Set();
    tail.projectRecord = async (record) => {
      const { fact } = record;
      try {
        await projectTail(record);
        tailConsumedFactIds.add(fact.factId);
      } catch (error) {
        if (
          error.constructor.name !== "AcceptedFactProjectionPendingError" &&
          !failedTailFacts.has(fact.factId)
        ) {
          failedTailFacts.add(fact.factId);
          (report.tailFailures ??= []).push({
            factId: fact.factId,
            runId: fact.scope.runId,
            kind: fact.kind,
            message: error.message,
            event: fact.event
              ? { type: fact.event.type, seq: fact.event.seq }
              : fact.events?.map((e) => ({ type: e.type, seq: e.seq })),
          });
        }
        throw error;
      }
    };
    await tail.start();
    relay = new AcceptedFactTerminalOutboxRelay({ database: db, bus });
    relay.start();
    const resolver = async (identity) => {
      const row = await db
        .selectFrom("supervisor_hosts")
        .select("management_base_url")
        .where("supervisor_id", "=", identity.supervisorId)
        .executeTakeFirstOrThrow();
      return new HttpSupervisorManagementClient({
        baseUrl: row.management_base_url,
        managementToken: management,
        allowInsecureHttp: true,
      });
    };
    const provisioner = new SupervisorBootProvisioner({
      database: db,
      allowedSupervisorIdPrefix: "handoff-",
      managementBaseUrlTemplates: ["http://{supervisorId}:4101", "http://{supervisorId}:4102"],
      maximumCapacity: 2,
      enrollmentToken: enrollment,
    });
    cp = await createControlPlaneRuntime({
      database: db,
      controlPlaneInstanceId: randomUUID(),
      eventRuntime: {
        eventHub: tail.eventHub,
        eventStore: tail,
      },
      supervisorAuthorizer: new PostgresSupervisorCredentialAuthorizer({ database: db }),
      supervisorOwnerBoundary: new RoutedHttpSupervisorOwnerBoundary(resolver),
      assignmentInventoryFactory: (identity) =>
        new RoutedHttpSandboxAssignmentInventory(resolver, identity),
      supervisorProvisioningGateway: new SupervisorProvisioningGateway({ provisioner }),
      productionHttpGateway: new ProductionHttpGateway({
        authenticator: new PostgresTenantApiAuthenticator({ database: db }),
        publicRegistrationEnabled: true,
        readiness: () => true,
      }),
      publicRegistration: {
        enabled: true,
        maximumTenants: 10,
        tenantQuotas: { maximumProjects: 10, maximumSessions: 20 },
        initialModel: { provider: "deepseek", modelId: "deepseek-v4-flash" },
      },
      turnSteerBackendFactory: async (sandboxId) => {
        const identity = await db
          .selectFrom("sandboxes")
          .select(["supervisor_id as supervisorId", "boot_id as bootId", "id as sandboxId"])
          .where("id", "=", sandboxId)
          .executeTakeFirstOrThrow();
        return new HttpSupervisorSteerBackend({
          client: await resolver(identity),
          leaseCoordinator: new SessionLeaseCoordinator({ database: db, sandboxId }),
        });
      },
      maintenance: {
        onActivity: (value) => {
          if (value.type === "runtime.failure" || value.retirements > 0)
            report.maintenance.push(value);
        },
      },
    });
    const apiUrl = await cp.listen(0, "127.0.0.1");
    const realKey = (
      await readFile("/app/deploy/production/runtime/secrets/cli-proxy-api-key", "utf8")
    ).trim();
    provider = createServer(
      (req, res) =>
        void (async () => {
          if (req.url === "/healthz") {
            res.writeHead(200);
            res.end();
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          sample++;
          requests.push({ sample, body: body.toString(), at: Date.now() });
          const headers = new Headers(req.headers);
          for (const name of ["host", "connection", "content-length", "transfer-encoding"])
            headers.delete(name);
          headers.set("authorization", `Bearer ${realKey}`);
          const upstream = await fetch(new URL(req.url, "http://cli-proxy-api:8317"), {
            method: req.method,
            headers,
            body,
          });
          res.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          });
          if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
          else res.end();
        })().catch((error) => {
          res.writeHead(502);
          res.end(JSON.stringify({ error: { message: "Probe upstream failed" } }));
        }),
    );
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    const ingressA = await spawn("ingress", { topic });
    const ingressB = await spawn("ingress", { topic });
    const workerA = await spawn("worker", {
      index: 1,
      api: apiUrl,
      ingress: ingressA.url,
      provider: providerUrl,
    });
    const registration = await (
      await fetch(apiUrl + "/v1/registrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantSlug: "handoff-api", displayName: "Handoff API acceptance" }),
      })
    ).json();
    assert(registration.apiToken, `Public registration failed: ${JSON.stringify(registration)}`);
    const api = new PiCloudApi(
      (path, init) => fetch(new URL(path, apiUrl), init),
      registration.apiToken,
    );
    const project = await api.createProject("Handoff API");
    const settings = {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "off",
      fastMode: false,
    };
    const makeSession = (title) =>
      api.createSession(
        project.projectId,
        project.workspaceId,
        title,
        "elastic",
        "starter",
        "/workspace",
        settings,
      );
    const rows = async (sessionId) =>
      db
        .selectFrom("pi_session_entries")
        .select(["id", "seq", "parent_id", "turn_id", "payload"])
        .where("session_id", "=", sessionId)
        .orderBy("seq")
        .execute();
    const users = async (sessionId) =>
      (await rows(sessionId))
        .filter((row) => row.payload.message?.role === "user")
        .map((row) => JSON.stringify(row.payload.message.content));
    const finished = async (runId) => {
      await waitFor(
        async () =>
          ["completed", "failed", "cancelled", "timed_out", "superseded"].includes(
            (await api.getRun(runId)).state,
          ),
        "Run terminal",
        240000,
      );
      await waitFor(
        async () =>
          !!(
            await db
              .selectFrom("runs as run")
              .innerJoin("run_attempts as attempt", "attempt.id", "run.current_attempt_id")
              .select("attempt.output_sealed_at")
              .where("run.id", "=", runId)
              .executeTakeFirst()
          )?.output_sealed_at,
        "execution seal projected",
      );
      return api.getRun(runId);
    };
    const normal = await makeSession("Normal Follow-up and Steer");
    const first = await api.acceptTurn(
      normal.sessionId,
      "NORMAL_FIRST。不要工具，请写一篇约1000字的中文文章，解释排序算法。",
      newIdempotencyKey("normal"),
      "off",
    );
    await waitFor(
      () => requests.some((r) => r.body.includes("NORMAL_FIRST")),
      "first model request",
    );
    const follow = await api.acceptTurn(
      normal.sessionId,
      "NORMAL_FOLLOWUP。不要工具，只回复 FOLLOWUP_OK",
      newIdempotencyKey("follow"),
      "off",
    );
    assert.equal((await api.getRun(follow.runId)).state, "queued");
    assert(!(await users(normal.sessionId)).some((text) => text.includes("NORMAL_FOLLOWUP")));
    const steer = await api.steerTurn(
      normal.sessionId,
      first.turnId,
      "NORMAL_STEER。接下来不要再写文章，只回复 STEER_OK",
      newIdempotencyKey("steer"),
    );
    assert.equal((await finished(first.runId)).state, "completed");
    assert.equal((await finished(follow.runId)).state, "completed");
    const normalUsers = await users(normal.sessionId);
    report.normal.observedMarkers = normalUsers.map((text) =>
      ["NORMAL_FIRST", "NORMAL_STEER", "NORMAL_FOLLOWUP"].filter((marker) => text.includes(marker)),
    );
    assert(
      normalUsers.findIndex((s) => s.includes("NORMAL_STEER")) >
        normalUsers.findIndex((s) => s.includes("NORMAL_FIRST")),
    );
    assert(
      normalUsers.findIndex((s) => s.includes("NORMAL_FOLLOWUP")) >
        normalUsers.findIndex((s) => s.includes("NORMAL_STEER")),
    );
    const timing = await db
      .selectFrom("runs")
      .select(["id", "started_at", "settled_at"])
      .where("id", "in", [first.runId, follow.runId])
      .execute();
    assert(
      new Date(timing.find((r) => r.id === follow.runId).started_at) >=
        new Date(timing.find((r) => r.id === first.runId).settled_at),
    );
    report.normal = {
      passed: true,
      followupQueued: true,
      queuedFollowupNotYetInPiHistory: true,
      modelReceivedSteer: requests.some((r) => r.body.includes("NORMAL_STEER")),
      steerState: steer.state,
      userOrder: ["NORMAL_FIRST", "NORMAL_STEER", "NORMAL_FOLLOWUP"],
    };
    console.log("[handoff] normal Follow-up and Steer passed");
    const session = await makeSession("Faulted Follow-up and Steer");
    stream = streamSessionEvents({
      sessionId: session.sessionId,
      signal: abort.signal,
      authorizationToken: registration.apiToken,
      fetchImplementation: (path, init) => fetch(new URL(path, apiUrl), init),
      onSnapshot() {},
      onStatus() {},
      onEvent(event) {
        eventCount++;
        shownEventIds.add(event.eventId);
      },
    });
    const old = await api.acceptTurn(
      session.sessionId,
      "FAULT_FIRST。不要工具，请写一篇约1200字的中文文章，解释二分查找的边界条件。",
      newIdempotencyKey("fault"),
      "off",
    );
    ingressA.child.send({ type: "arm", runId: old.runId });
    await waitFor(() => ingressA.child.armed, "fault armed");
    await waitFor(
      () => requests.some((r) => r.body.includes("FAULT_FIRST")),
      "fault model request",
    );
    const next = await api.acceptTurn(
      session.sessionId,
      "FAULT_FOLLOWUP。不要工具，只回复 NEXT_OK",
      newIdempotencyKey("fault-follow"),
      "off",
    );
    const pendingSteer = await api.steerTurn(
      session.sessionId,
      old.turnId,
      "FAULT_STEER。下一次只回复 STEER_AFTER_FAULT",
      newIdempotencyKey("fault-steer"),
    );
    await waitFor(() => faultInfo, "ingress paused before complete assistant mutation");
    // Lose only the canonical consumer's volatile fold while old text is in Kafka.
    // Rejoining must replay it, even if group offsets were already committed.
    await consumer.close();
    consumer = makeConsumer();
    const prefixEnds = await consumer.captureEndOffsets();
    await consumer.start();
    await consumer.waitUntilInitialReplay(prefixEnds);
    report.fault.canonicalRestartDuringUnsealedPrefix = true;
    // Exceed the ingress's default 9-second lease while the real Worker still
    // heartbeats. A single paused ingress must not bypass the Run mailbox.
    await delay(12000);
    assert.equal((await api.getRun(old.runId)).state, "running");
    assert.equal((await api.getRun(next.runId)).state, "queued");
    report.fault.followupStayedQueued = true;
    report.fault.ingressPauseBeforeWorkerKillMs = 12000;
    report.fault.steerBeforeKill = {
      state: pendingSteer.state,
      nativeUserPresent: (await users(session.sessionId)).some((s) => s.includes("FAULT_STEER")),
    };
    console.log(
      "[handoff] ingress paused; Follow-up remains queued; killing only isolated Worker A",
    );
    workerA.child.kill("SIGKILL");
    await once(workerA.child, "exit");
    const oldResult = await finished(old.runId);
    report.fault.oldRunState = oldResult.state;
    report.fault.oldRunFailure = oldResult.failure?.code;
    const workerB = await spawn("worker", {
      index: 2,
      api: apiUrl,
      ingress: ingressB.url,
      provider: providerUrl,
    });
    const nextResult = await finished(next.runId);
    assert.equal(nextResult.state, "completed");
    const before = await db
      .selectFrom("pi_session_lanes")
      .select("leaf_id")
      .where("session_id", "=", session.sessionId)
      .where("lane", "=", "main")
      .executeTakeFirstOrThrow();
    report.fault.followupCompletedByReplacement = true;
    report.fault.replacementBootDifferent = workerA.identity.bootId !== workerB.identity.bootId;
    console.log(
      "[handoff] real reconciliation failed Run A; real Worker B completed queued Follow-up; resuming ingress A",
    );
    ingressA.child.kill("SIGCONT");
    await waitFor(
      () =>
        report.facts.some((f) => f.factId === faultInfo.factId) &&
        tailConsumedFactIds.has(faultInfo.factId),
      "late complete assistant fact consumed",
    );
    const after = await db
      .selectFrom("pi_session_lanes")
      .select("leaf_id")
      .where("session_id", "=", session.sessionId)
      .where("lane", "=", "main")
      .executeTakeFirstOrThrow();
    const late = await db
      .selectFrom("pi_session_mutation_results")
      .select(["state", "error_code"])
      .where("mutation_id", "=", faultInfo.factId)
      .executeTakeFirst();
    report.latePublicationChangedBranch = before.leaf_id !== after.leaf_id;
    report.fault.lateMutation = late ?? { state: "discarded_after_seal" };
    report.fault.lateEventsShown = faultInfo.eventIds.some((id) => shownEventIds.has(id));
    assert.equal(report.fault.lateEventsShown, false);
    const oldAttempt = await db
      .selectFrom("run_attempts")
      .select("output_sealed_at")
      .where("run_id", "=", old.runId)
      .executeTakeFirstOrThrow();
    const newRun = await db
      .selectFrom("runs")
      .select("started_at")
      .where("id", "=", next.runId)
      .executeTakeFirstOrThrow();
    report.fault.replacementStartedAfterSeal = newRun.started_at >= oldAttempt.output_sealed_at;
    assert(report.fault.replacementStartedAfterSeal);
    const prefixRow = (await rows(session.sessionId)).find(
      (row) => row.payload.customType === "pi-cloud.interrupted_assistant_prefix",
    );
    assert(prefixRow?.payload.data.text.length > 0);
    const prefix = JSON.stringify(prefixRow.payload.data.text).slice(1, -1);
    report.fault.replacementModelReceivedVisiblePrefix = requests
      .filter((r) => r.body.includes("FAULT_FOLLOWUP"))
      .some((r) => r.body.includes(prefix));
    assert(report.fault.replacementModelReceivedVisiblePrefix);
    await consumer.close();
    projector.reset();
    consumer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      clientId: randomUUID(),
      groupId,
      mode: "earliest",
      commitMessages: false,
      onReset: () => projector.reset(),
      handler: (record) => projector.project(record),
    });
    const ends = await consumer.captureEndOffsets();
    await consumer.start();
    await consumer.waitUntilInitialReplay(ends);
    const replayedHead = await db
      .selectFrom("pi_session_lanes")
      .select("leaf_id")
      .where("session_id", "=", session.sessionId)
      .where("lane", "=", "main")
      .executeTakeFirstOrThrow();
    assert.equal(replayedHead.leaf_id, before.leaf_id);
    report.fault.canonicalRestartKeptHead = true;
    assert.equal(report.latePublicationChangedBranch, false);
    assert.equal(late, undefined);
    report.fault.lateEntryBecameHead = after.leaf_id === faultInfo.entryId;
    const steerRow = await db
      .selectFrom("turn_control_requests")
      .select(["state", "payload"])
      .where("id", "=", pendingSteer.controlRequestId)
      .executeTakeFirstOrThrow();
    report.fault.steerAfterRecovery = {
      state: steerRow.state,
      nativeUserPresent: (await users(session.sessionId)).some((s) => s.includes("FAULT_STEER")),
      textStillPersisted: String(steerRow.payload.text).includes("FAULT_STEER"),
    };
    report.steerDeliveryWasNotConsumption =
      steerRow.state === "completed" && !report.fault.steerAfterRecovery.nativeUserPresent;
    report.fault.replacementModelSawSteer = requests
      .filter((r) => r.body.includes("FAULT_FOLLOWUP"))
      .some((r) => r.body.includes("FAULT_STEER"));
    report.fault.sseEvents = eventCount;
    report.fault.lateFactId = faultInfo.factId;
    report.scope =
      "real REST API, PiWorkerRuntime/Pi SDK, PostgreSQL queue/leases, maintenance/reconciler, Kafka R3 and SSE; SIGSTOP ingress plus SIGKILL Worker; no direct lifecycle/lease SQL writes; no Cube operations";
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    console.error(`[handoff] ${error.name}: ${error.message}`);
  } finally {
    abort.abort();
    await stream?.catch(() => {});
    report.providerRequests = requests.length;
    try {
      const records = await db.selectFrom("pi_session_entries").select("payload").execute();
      for (const { payload } of records)
        if (payload.message?.usage) report.usage.push(payload.message.usage);
    } catch {}
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => {});
      }
    await cp?.close();
    await relay?.close();
    await consumer?.close();
    await tail?.close();
    await bus.close();
    provider?.closeAllConnections();
    await new Promise((resolve) => (provider ? provider.close(resolve) : resolve()));
    await admin
      .deleteGroups({ groups: [groupId, `pi-cloud-live-tail-${instanceId}`] })
      .catch(() => {});
    await admin.deleteTopics({ topics: [topic] });
    await admin.close();
    await db.destroy();
    // Never persist input bodies or provider credentials; markers/counts only.
    console.log(JSON.stringify(report));
  }
}
