/** Real, isolated Guest/API acceptance. Does not switch the serving provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import sharp from "sharp";
import { testTls } from "../../packages/cube-completion/test/tls-fixture.ts";
import { completionServer } from "../../packages/cube-completion/src/http-server.ts";
import { ToolCompletionCapabilities } from "../../packages/protocol/src/completion-capability.ts";
import { parseToolWorkerOutput } from "../../packages/protocol/src/tool-sandbox.ts";

const [python, directoryArg, image, registry] = process.argv.slice(2);
assert(
  python && directoryArg && image && registry,
  "Supply pinned Python environment, new owned directory, pinned Guest image, registry",
);
const directory = resolve(directoryArg);
await mkdir(directory, { mode: 0o700 });
await writeFile(resolve(directory, ".pma-boxlite-guest"), "0.12.0", { mode: 0o600 });
await writeFile(resolve(directory, "config.json"), JSON.stringify({ image, registry }), {
  mode: 0o600,
});
const report = {
  version: "0.12.0",
  image,
  hostJailer: process.env.PMA_BOXLITE_ROOTFUL_PROBE !== "1",
  checks: [],
  cleanupConfirmed: false,
};
const authority = new ToolCompletionCapabilities(randomUUID() + randomUUID()),
  tls = await testTls(),
  received = new Map();
const server = completionServer({
  ...tls,
  authority,
  ready: async () => {},
  adapter: {
    accept: async (packet) => {
      if (packet.kind !== "result") return;
      const output = parseToolWorkerOutput(packet.result.output);
      received.set(packet.operationId, output);
    },
  },
});
await server.listen({ host: "0.0.0.0", port: 0 });
const port = server.server.address().port;
const address = Object.entries(networkInterfaces())
  .filter(([name]) => /^eth/.test(name))
  .flatMap(([, items]) => items)
  .find((i) => i.family === "IPv4" && !i.internal)?.address;
assert(address, "Host test callback address missing");
let child, lines, pending;
function start() {
  child = spawn(
    python,
    [
      fileURLToPath(new URL("./boxlite-guest-adapter.py", import.meta.url)),
      directory,
      image,
      registry,
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^(all|https?|no)_proxy$/i.test(k)),
      ),
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const r = JSON.parse(line);
    const p = pending;
    pending = undefined;
    r.ok ? p?.resolve(r.value) : p?.reject(new Error(`${r.type}: ${r.message}`));
  });
  child.on("exit", () => {
    pending?.reject(new Error("Adapter exited"));
    pending = undefined;
  });
}
function call(value) {
  assert(!pending, "Adapter requests must be serial");
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    child.stdin.write(JSON.stringify(value) + "\n");
  });
}
async function disconnect() {
  const p = child;
  const exited = new Promise((r) => p.once("exit", r));
  p.kill("SIGKILL");
  await exited;
  lines.close();
}
const until = async (read, label, ms = 45000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error("Timed out: " + label);
};
async function ownedProcesses() {
  const found = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (
        !args.some(
          (a) => a.startsWith(directory + "/runtime/boxes/") && a.endsWith("/bin/boxlite-shim"),
        )
      )
        continue;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8"),
        fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (!["Z", "X"].includes(fields[0])) found.push({ pid: Number(pid), start: fields[19] });
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return found;
}
let id,
  boot,
  offset = 0;
const scope = randomUUID(),
  writer = randomUUID(),
  sourceTopic = "boxlite-" + randomUUID();
const guest = (request) => call({ action: "guest", boxId: id, request });
const inspect = (command, args = []) => call({ action: "inspect", boxId: id, command, args });
function request(name, args, timeoutMs = 30000) {
  const operationId = randomUUID(),
    toolCallId = randomUUID(),
    expiresAt = Date.now() + timeoutMs + 15000;
  const context = {
    scope: {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      piSessionId: randomUUID(),
      writerId: writer,
      fencingToken: 1,
    },
    replyTopic: "isolated-fixture",
    toolCallId,
    nativeToolCallId: toolCallId,
    toolName: name,
    partition: 0,
  };
  return {
    version: 1,
    action: "submit",
    bootId: boot,
    operationId,
    scopeId: scope,
    writerId: writer,
    source: { topic: sourceTopic, partition: 0, offset: String(++offset) },
    timeoutMs,
    payload: {
      toolWorkerProtocolVersion: 7,
      type: "worker.operation",
      attachment: { activationId: scope, toolRoot: "/workspace" },
      request: {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        operation: "tool.execute",
        activationId: scope,
        operationId,
        toolCallId,
        toolName: name,
        args,
        timeoutMs,
        maximumOutputBytes: 51200,
      },
      delivery: {
        url: `https://localhost:${port}/v1/completions`,
        address,
        ca: tls.cert,
        capability: authority.issue({ operationId, expiresAt, context }),
        expiresAt,
      },
    },
  };
}
async function result(r) {
  const output = await until(() => received.get(r.operationId), "original Guest completion");
  assert.equal(output.type, "worker.operation_result", JSON.stringify(output));
  assert.equal(output.response.type, "tool_sandbox.operation_result");
  return output.response.event;
}
const text = (event) =>
  event.result.content
    .filter((v) => v.type === "text")
    .map((v) => v.text)
    .join("\n");
try {
  start();
  id = (await call({ action: "create" })).boxId;
  await disconnect();
  start();
  assert.equal((await call({ action: "info", boxId: id })).state, "running");
  report.checks.push("VM survives adapter SIGKILL");
  const env = await inspect("sh", [
    "-c",
    "test -w /sys/fs/cgroup && test ! -S /var/run/docker.sock && echo ready",
  ]);
  assert.equal(env.stdout.trim(), "ready");
  const prepared = await inspect("sh", [
    "-ec",
    "chown 1000:1000 /workspace; chmod 0700 /workspace; stat -c '%u:%g:%a' /workspace",
  ]);
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  report.workspaceMode = prepared.stdout.trim();
  boot = (await guest({ version: 1, action: "info" })).bootId;
  const r = request("bash", {
    command: "set -e; printf once >> /workspace/effects; sleep 3; id -u; printf done",
  });
  assert.equal((await guest(r)).accepted, true);
  assert.equal((await guest(r)).accepted, true);
  const changed = structuredClone(r);
  changed.payload.request.args.command = "echo changed";
  assert.equal((await guest(changed)).rejection, "operation_changed");
  await disconnect();
  start();
  const event = await result(r);
  assert.equal(event.isError, false);
  assert.match(text(event), /1000[\s\S]*done/);
  assert.equal(await readFile(resolve(directory, "workspace/effects"), "utf8"), "once");
  report.checks.push(
    "same fixed Guest, UID1000, duplicate refusal and HTTPS result survive caller loss",
  );
  const large = request("bash", { command: "python3 -c 'print(\"x\"*200000)'" });
  assert.equal((await guest(large)).accepted, true);
  const bounded = await result(large);
  assert(Buffer.byteLength(text(bounded)) < 54000);
  report.checks.push("200KB source output bounded before callback");
  for (const [name, args] of [
    ["write", { path: "/workspace/note.txt", content: "before" }],
    ["edit", { path: "/workspace/note.txt", edits: [{ oldText: "before", newText: "after" }] }],
    ["read", { path: "/workspace/note.txt" }],
  ]) {
    const operation = request(name, args);
    assert.equal((await guest(operation)).accepted, true);
    const event = await result(operation);
    assert.equal(event.isError, false, text(event));
    if (name === "read") assert.match(text(event), /after/);
  }
  await writeFile(
    resolve(directory, "workspace/pixel.png"),
    await sharp({ create: { width: 2, height: 3, channels: 3, background: "red" } })
      .png()
      .toBuffer(),
  );
  const picture = request("read", { path: "/workspace/pixel.png" });
  assert.equal((await guest(picture)).accepted, true);
  const pictured = await result(picture);
  assert.equal(pictured.isError, false, text(pictured));
  assert(pictured.result.content.some((part) => part.type === "image" && part.data.length > 0));
  report.checks.push("native write/edit/read and image HTTPS completion");
  const running = request(
    "bash",
    { command: "touch /workspace/cancel-started; sleep 60; touch /workspace/incorrect" },
    90000,
  );
  assert.equal((await guest(running)).accepted, true);
  await until(async () => {
    try {
      await readFile(resolve(directory, "workspace/cancel-started"));
      return true;
    } catch {
      return false;
    }
  }, "cancellable command start");
  assert.equal(
    (
      await guest({
        version: 1,
        action: "cancel",
        bootId: boot,
        scopeId: scope,
        writerId: writer,
        operationId: running.operationId,
        source: { topic: sourceTopic, partition: 0, offset: String(++offset) },
      })
    ).accepted,
    true,
  );
  const cancelled = await result(running);
  assert.equal(cancelled.isError, true);
  assert.match(text(cancelled), /abort|cancel/i);
  report.checks.push("exact operation cancellation");
  const inflight = request("bash", {
    command: "touch /workspace/restart-started; sleep 4; printf survived",
  });
  assert.equal((await guest(inflight)).accepted, true);
  await until(async () => {
    try {
      await readFile(resolve(directory, "workspace/restart-started"));
      return true;
    } catch {
      return false;
    }
  }, "Guest restart marker");
  const killed = await inspect("node", [
    "-e",
    "const fs=require('fs');const p=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).find(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes('/opt/pi-cloud/bin/guest-executor-service.mjs')}catch{return false}});if(!p)process.exit(2);process.kill(Number(p),'SIGKILL')",
  ]);
  assert.equal(killed.exitCode, 0);
  assert.equal((await guest({ version: 1, action: "info" })).bootId, boot);
  assert.match(text(await result(inflight)), /survived/);
  report.checks.push("Guest service replacement preserves accepted operation");
  // Keep the original operation identity across an actual VM restart; reject it.
  await call({ action: "stop", boxId: id });
  await call({ action: "start", boxId: id });
  const next = await guest({ version: 1, action: "info" });
  assert.notEqual(next.bootId, boot);
  assert.equal((await guest(r)).rejection, "executor_replaced");
  assert.equal(await readFile(resolve(directory, "workspace/effects"), "utf8"), "once");
  report.checks.push("VM restart preserves Workspace and refuses old boot work");
  report.accepted = true;
} catch (error) {
  report.accepted = false;
  report.failure = error.message;
  throw error;
} finally {
  try {
    if (!child || child.exitCode !== null) {
      start();
    }
    for (const box of await call({ action: "inventory" }))
      await call({ action: "remove", boxId: box.boxId });
    assert.equal((await call({ action: "inventory" })).length, 0);
    const survivors = await ownedProcesses();
    report.nativeRemovalConfirmed = survivors.length === 0;
    // Fixture cleanup only. This is deliberately not a provider fallback. Record
    // the failed native contract before stopping these exact owned test processes.
    if (survivors.length) {
      report.nativeRemovalLeftProcesses = survivors.length;
      for (const identity of survivors) {
        const current = (await ownedProcesses()).find(
          (v) => v.pid === identity.pid && v.start === identity.start,
        );
        if (current) process.kill(current.pid, "SIGKILL");
      }
      await until(
        async () => !(await ownedProcesses()).length,
        "owned fixture process cleanup",
        5000,
      );
      report.operatorCleanupRequired = true;
    }
    report.cleanupConfirmed = true;
  } finally {
    if (child?.exitCode === null) await disconnect();
    await server.close();
    await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(JSON.stringify(report));
  }
}
