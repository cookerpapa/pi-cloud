import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

if (process.env.PI_CLOUD_LIVE_TOOL_COMMAND_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_TOOL_COMMAND_CHECK=1 for private Kafka command acceptance");
if (process.argv[2] !== "inside") {
  const exec = promisify(execFile),
    runner = `pi-cloud-tool-command-${randomUUID()}`;
  try {
    const result = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        runner,
        "--network",
        "pi-cloud-production_event-log",
        "--cpus",
        "3",
        "--memory",
        "2g",
        "-v",
        `${process.cwd()}:/app:ro`,
        "-w",
        "/app",
        "-e",
        "PI_CLOUD_LIVE_TOOL_COMMAND_CHECK",
        "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
        "node",
        "--import",
        "tsx",
        "scripts/run-kafka-tool-command-check.mjs",
        "inside",
      ],
      { timeout: 240000, maxBuffer: 4 * 1024 * 1024 },
    );
    const line = result.stdout
      .trim()
      .split("\n")
      .findLast((line) => line.startsWith('{"format"'));
    if (!line)
      throw new Error(
        `No command report: ${result.stdout.slice(-2000)} ${result.stderr.slice(-1000)}`,
      );
    const report = JSON.parse(line);
    report.revision = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
    report.workingTreeDirty = true;
    await writeFile(
      "docs/reports/tool-result-retirement-acceptance-latest.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } finally {
    await exec("docker", ["rm", "-f", runner]).catch(() => {});
  }
} else {
  const { Admin } = await import("@platformatic/kafka");
  const { KafkaAcceptedFactBus } =
    await import("../packages/runtime-core/src/kafka-accepted-fact.ts");
  const { KafkaToolCommandConsumer } =
    await import("../packages/tool-broker/src/kafka-tool-command-consumer.ts");
  const { ToolBrokerServer } = await import("../packages/tool-broker/src/tool-broker-server.ts");
  const { ToolBrokerClient } = await import("../packages/tool-broker/src/tool-broker-client.ts");
  const { createExecutionLease } = await import("@pi-cloud/protocol");
  const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"],
    topic = `pi-cloud.tool-command-check.${randomUUID()}`;
  const admin = new Admin({ bootstrapBrokers: brokers, clientId: randomUUID() });
  const bus = new KafkaAcceptedFactBus({
    brokers,
    topic,
    partitions: 4,
    replicas: 3,
    retentionMs: 3600000,
    clientId: randomUUID(),
  });
  const ids = [randomUUID(), randomUUID()],
    consumers = [],
    servers = [],
    clients = [];
  const children = [],
    childGroups = [];
  const bindings = [new Map(), new Map()],
    effects = new Map(),
    times = [],
    progress = [];
  const lease = (c) =>
    createExecutionLease(c.scope.leaseId, c.scope.attemptId, c.scope.fencingToken);
  let firstCommand, releaseHeld;
  const held = new Promise((resolve) => {
    releaseHeld = resolve;
  });
  const resultFor = (request) => ({
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation_result",
    activationId: request.activationId,
    operationId: request.operationId,
    operation: "bash.exec",
    exitCode: 0,
    outputChunks:
      request.command === "large"
        ? [{ seq: 1, stream: "stdout", data: Buffer.alloc(96 * 1024, 120).toString("base64") }]
        : [],
    outputSha256: createHash("sha256")
      .update(request.command === "large" ? Buffer.alloc(96 * 1024, 120) : Buffer.alloc(0))
      .digest("hex"),
  });
  const command = (scope, activationId) => {
    const operationId = randomUUID();
    return {
      kind: "tool_command",
      factId: operationId,
      toolCallId: randomUUID(),
      scope,
      occurredAt: new Date().toISOString(),
      request: {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        activationId,
        operationId,
        turnContextSha256: "a".repeat(64),
        attemptContextSha256: "b".repeat(64),
        stepContextSequence: 1,
        stepContextSha256: "c".repeat(64),
        toolName: "bash",
        operation: "bash.exec",
        command: "test-only counting effect",
        cwd: "/workspace",
        timeoutMs: 1000,
      },
    };
  };
  const makeScope = () => ({
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    runId: randomUUID(),
    attemptId: randomUUID(),
    leaseId: randomUUID(),
    fencingToken: 1,
  });
  const receipt = (c) => ({
    kind: "pi_session_mutation",
    factId: randomUUID(),
    scope: c.scope,
    piSession: { id: c.scope.sessionId, lane: "main" },
    operation: {
      kind: "append_items",
      items: [
        {
          kind: "append_entry",
          lane: "main",
          entry: {
            id: randomUUID(),
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: c.toolCallId,
              toolName: "bash",
              content: [{ type: "text", text: "Harness-selected result" }],
              isError: false,
              timestamp: Date.now(),
            },
          },
        },
      ],
    },
    events: [
      { type: "tool.completed", payload: { toolCallId: c.toolCallId, outcome: "completed" } },
    ],
    occurredAt: new Date().toISOString(),
  });
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Kafka result-retirement probe timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const start = async (index) => {
    const broker = {
      providerId: "acceptance-counter",
      activeCount: 0,
      admittedCount: 0,
      admissionWaitingCount: 0,
      maximumActiveSandboxes: 1024,
      cleanPrewarmCount: 0,
      checkHealth: async () => {},
      close: async () => {},
      ownsToolBinding: (id) => bindings[index].has(id),
      assertToolResultReader: (id, value) => {
        if (bindings[index].get(id) !== value) throw new Error("wrong binding");
      },
      execute: async (value, request) => {
        assert.equal(bindings[index].get(request.activationId), value);
        effects.set(request.operationId, (effects.get(request.operationId) ?? 0) + 1);
        if (request.command === "hold") await held;
        return resultFor(request);
      },
    };
    const consumer = new KafkaToolCommandConsumer({
      broker,
      brokers,
      topic,
      instanceId: ids[index],
    });
    consumers.push(consumer);
    await consumer.start();
    const server = new ToolBrokerServer({
      host: "0.0.0.0",
      port: 0,
      broker,
      commands: consumer,
      serviceToken: "s".repeat(40),
    });
    servers.push(server);
    const url = await server.listen();
    const client = new ToolBrokerClient({
      baseUrl: url,
      serviceToken: "s".repeat(40),
      allowInsecureHttp: true,
    });
    clients.push(client);
    return url;
  };
  try {
    await bus.start();
    const urls = [await start(0), await start(1)];
    for (const concurrency of [1, 16, 128, 1024]) {
      const roundTimes = [],
        started = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, async (_, i) => {
          const index = i % 2,
            scope = makeScope(),
            activationId = randomUUID();
          const first = command(scope, activationId);
          bindings[index].set(activationId, lease(first));
          firstCommand ??= first;
          for (let round = 0; round < 3; round++) {
            const c = round === 0 ? first : command(scope, activationId),
              before = performance.now();
            await bus.append(c);
            const result = await clients[index].operationResult(lease(c), activationId, c.factId);
            assert.equal(result.operationId, c.factId);
            assert.equal(effects.get(c.factId), 1);
            roundTimes.push(performance.now() - before);
            await bus.append(receipt(c));
          }
        }),
      );
      roundTimes.sort((a, b) => a - b);
      progress.push({
        sessions: concurrency,
        commands: roundTimes.length,
        commandsPerSecond: +((roundTimes.length * 1000) / (performance.now() - started)).toFixed(1),
        latencyMs: {
          p50: +roundTimes[Math.floor(roundTimes.length * 0.5)].toFixed(2),
          p95: +roundTimes[
            Math.min(roundTimes.length - 1, Math.floor(roundTimes.length * 0.95))
          ].toFixed(2),
        },
      });
      times.push(...roundTimes);
    }
    const c = firstCommand;
    await waitUntil(() =>
      consumers.every((consumer) => consumer.statistics().retainedResults === 0),
    );
    await bus.append(c);
    await assert.rejects(
      clients[0].operationResult(lease(c), c.request.activationId, c.factId),
      /no longer retained/,
    );
    assert.equal(effects.get(c.factId), 1);
    // One unsealed Run, many Tools: acknowledgement frees every body before
    // the next command. Raw responses differ from the Harness's final text.
    const longScope = makeScope(),
      longActivation = randomUUID();
    const longFirst = command(longScope, longActivation);
    bindings[0].set(longActivation, lease(longFirst));
    const beforeLong = consumers[0].statistics().releasedResults;
    for (let i = 0; i < 250; i++) {
      const step = command(longScope, longActivation);
      step.request.command = "large";
      await bus.append(step);
      await clients[0].operationResult(lease(step), longActivation, step.factId);
      await bus.append(receipt(step));
      await waitUntil(() => consumers[0].statistics().retainedResults === 0);
    }
    assert.equal(consumers[0].statistics().releasedResults - beforeLong, 250);
    const longRunRetainedBytes = consumers[0].statistics().retainedResultBytes;
    assert.equal(longRunRetainedBytes, 0);
    const forbidden = await fetch(`${urls[0]}/internal/v1/tool-operation`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease(c)}`, "content-type": "application/json" },
      body: JSON.stringify(c.request),
    });
    assert.equal(forbidden.status, 404);
    const resultPost = await fetch(clients[0].operationResultUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${lease(c)}`, "content-type": "application/json" },
      body: JSON.stringify(c.request),
    });
    assert.equal(resultPost.status, 404);
    const heldCommand = command(makeScope(), randomUUID());
    heldCommand.request.command = "hold";
    bindings[0].set(heldCommand.request.activationId, lease(heldCommand));
    await bus.append(heldCommand);
    const heldResult = clients[0].operationResult(
      lease(heldCommand),
      heldCommand.request.activationId,
      heldCommand.factId,
    );
    const other = command(makeScope(), randomUUID());
    bindings[0].set(other.request.activationId, lease(other));
    await bus.append(other);
    await clients[0].operationResult(lease(other), other.request.activationId, other.factId);
    assert.equal(effects.get(other.factId), 1);
    releaseHeld();
    await heldResult;
    await bus.append({
      kind: "execution_seal",
      factId: randomUUID(),
      scope: heldCommand.scope,
      agentId: "root",
      baseSequence: 0,
      terminal: { type: "turn.cancelled", payload: { reason: "user_request", forced: false } },
      occurredAt: new Date().toISOString(),
    });
    const late = command(heldCommand.scope, heldCommand.request.activationId);
    await bus.append(late);
    await assert.rejects(
      clients[0].operationResult(lease(late), late.request.activationId, late.factId),
      /closed execution/,
    );
    assert.equal(effects.has(late.factId), false);
    const spawnBroker = async (c, hold) => {
      const boot = randomUUID(),
        child = fork(new URL("./kafka-tool-command-fault-child.mjs", import.meta.url), [], {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
      const messages = [];
      child.on("message", (message) => messages.push(message));
      children.push(child);
      childGroups.push(`pi-cloud-tool-commands-${boot}`);
      child.send({ boot, command: c, brokers, topic, hold });
      const wait = async (predicate) => {
        const deadline = Date.now() + 45000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error("Broker process probe timed out");
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      await wait(() => messages.some((m) => m.type === "ready"));
      return { child, messages, wait };
    };
    const abandoned = command(makeScope(), randomUUID()),
      replaced = command(makeScope(), randomUUID());
    const old = await spawnBroker(abandoned, true);
    await bus.append(abandoned);
    await old.wait(() => old.messages.some((m) => m.type === "entered"));
    old.child.kill("SIGKILL");
    await old.wait(() => old.child.signalCode === "SIGKILL");
    const replacement = await spawnBroker(replaced, false);
    await bus.append(abandoned);
    await bus.append(replaced);
    await replacement.wait(() => replacement.messages.some((m) => m.type === "effect"));
    replacement.child.send({ type: "stats" });
    await replacement.wait(() => replacement.messages.some((m) => m.type === "stats"));
    assert.equal(replacement.messages.find((m) => m.type === "stats").effects, 1);
    assert.equal(
      old.messages.some((m) => m.type === "effect"),
      false,
    );
    await bus.append(receipt(other));
    await waitUntil(() =>
      consumers.every((consumer) => consumer.statistics().retainedResults === 0),
    );
    console.log(
      JSON.stringify({
        format: "pi-cloud.kafka-tool-command-acceptance.v2",
        checkedAt: new Date().toISOString(),
        topology:
          "two real Kafka consumers + production result HTTP servers; R=3 four-partition private topic; 3 CPU/2 GiB runner",
        scope:
          "accepted command -> Kafka -> Broker dispatch -> counting executor -> HTTP result -> native Kafka receipt; command latency ends at HTTP result, aggregate throughput includes receipt publication; no Gate SQL, model or Cube time",
        resultRetirement: {
          beforeRunSeal: true,
          longRunTools: 250,
          rawBytesPerLongRunTool: 96 * 1024,
          retainedBytesAfterLongRun: longRunRetainedBytes,
          duplicateAfterReleaseNotExecuted: true,
        },
        progress,
        effects: effects.size,
        duplicateEffects: [...effects.values()].filter((n) => n !== 1).length,
        directExecutionPostRejected: true,
        processFault: { killedBeforeEffect: true, replacementExecutedOnlyNewBinding: true },
        longCommandDidNotBlockAnother: true,
        sealedCommandNotExecuted: true,
        consumerStatistics: consumers.map((c) => c.statistics()),
      }),
    );
  } finally {
    releaseHeld();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    for (const c of consumers) await c.close();
    for (const s of servers) await s.close();
    await bus.close();
    const groups = [...ids.map((id) => `pi-cloud-tool-commands-${id}`), ...childGroups];
    const alreadyGone = (error) =>
      error?.apiId === "GROUP_ID_NOT_FOUND" ||
      (Array.isArray(error?.errors) && error.errors.length > 0 && error.errors.every(alreadyGone));
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.deleteGroups({ groups });
        break;
      } catch (error) {
        if (alreadyGone(error)) break;
        if (attempt === 30) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await admin.deleteTopics({ topics: [topic] }).catch(() => {});
    await admin.close();
  }
}
