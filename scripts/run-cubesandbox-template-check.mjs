import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const image = process.env.PI_CLOUD_CUBESANDBOX_TOOL_IMAGE ?? "pi-cloud/cubesandbox-tool:experiment";
const containerName = `pi-cloud-cubesandbox-template-check-${String(process.pid)}`;

function capture(command, args, timeout = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 4 * 1_024 * 1_024,
        timeout,
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(new Error(stderr.trim() || error.message));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: repositoryRoot, env: process.env, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(`${command} failed (code=${String(code)}, signal=${String(signal)})`),
        );
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function connectEnvelope(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

async function envdRun(baseUrl, command, user = "root", timeoutMs = 30_000) {
  const response = await fetch(`${baseUrl}/process.Process/Start`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${user}:`).toString("base64")}`,
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      "connect-content-encoding": "identity",
      "connect-timeout-ms": String(timeoutMs),
    },
    body: connectEnvelope({
      process: { cmd: "/bin/bash", args: ["--noprofile", "--norc", "-lc", command], cwd: "/" },
      stdin: false,
    }),
    signal: AbortSignal.timeout(timeoutMs + 1_000),
  });
  assert(
    response.ok && response.body !== null,
    `envd command failed: HTTP ${String(response.status)}`,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  let offset = 0;
  let stdout = "";
  let stderr = "";
  let exitCode;
  const observedEvents = [];
  while (offset < bytes.byteLength) {
    assert(offset + 5 <= bytes.byteLength, "envd returned a partial frame");
    const flags = bytes.readUInt8(offset);
    const size = bytes.readUInt32BE(offset + 1);
    offset += 5;
    assert(offset + size <= bytes.byteLength, "envd returned a partial payload");
    const payload = JSON.parse(bytes.subarray(offset, offset + size).toString("utf8"));
    observedEvents.push(payload);
    offset += size;
    if ((flags & 0x02) !== 0) {
      if (payload.error) throw new Error(payload.error.message ?? "envd stream failed");
      break;
    }
    const event = payload.event ?? {};
    if (event.data?.stdout) stdout += Buffer.from(event.data.stdout, "base64").toString("utf8");
    if (event.data?.stderr) stderr += Buffer.from(event.data.stderr, "base64").toString("utf8");
    if (event.end?.exitCode !== undefined) exitCode = Number(event.end.exitCode);
    else if (event.end?.exit_code !== undefined) exitCode = Number(event.end.exit_code);
    else if (
      typeof event.end?.status === "string" &&
      /exit status (-?\d+)/u.test(event.end.status)
    ) {
      exitCode = Number(event.end.status.match(/exit status (-?\d+)/u)[1]);
    } else if (event.end?.status === "exited") exitCode = 0;
  }
  assert(
    Number.isSafeInteger(exitCode),
    `envd command ended without an exit code: ${JSON.stringify(observedEvents.slice(-3))}`,
  );
  return { stdout, stderr, exitCode };
}

async function writeEnvdFile(baseUrl, path, value) {
  const response = await fetch(`${baseUrl}/files?path=${encodeURIComponent(path)}&username=root`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from(JSON.stringify(value), "utf8"),
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `envd file write failed: HTTP ${String(response.status)}`);
  await response.body?.cancel();
}
const activationId = randomUUID();
const operation = (toolName, args) => ({
  toolBrokerProtocolVersion: 1,
  type: "tool_sandbox.operation",
  activationId,
  operationId: randomUUID(),

  operation: "tool.execute",
  toolCallId: randomUUID(),
  toolName,
  args,
  maximumOutputBytes: 51_200,
  timeoutMs: 30_000,
});

let started = false;
try {
  await capture("docker", ["image", "inspect", image]);
  await run("docker", [
    "run",
    "--detach",
    "--name",
    containerName,
    "--cpus",
    "1",
    "--memory",
    "768m",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/workspace:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700",
    "--publish",
    "127.0.0.1:0:49983",
    image,
  ]);
  started = true;
  const published = await capture("docker", ["port", containerName, "49983/tcp"]);
  const port = Number(published.slice(published.lastIndexOf(":") + 1));
  assert(Number.isSafeInteger(port) && port > 0, "envd port mapping was invalid");
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) })
      .then((response) => response.status === 204)
      .catch(() => false);
    if (ready) break;
    if (attempt === 99) throw new Error("Cube envd did not become ready");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  const processView = await envdRun(baseUrl, "ps -eo comm= | sort -u");
  assert(processView.exitCode === 0 && processView.stdout.includes("envd"), "envd was not running");
  assert(
    !processView.stdout.includes("pi-cloud-cube-tool"),
    "a persistent PiCloud guest daemon was running",
  );

  const evidencePath = `/tmp/pi-cloud-envd-${randomUUID()}.json`;
  await writeEnvdFile(baseUrl, evidencePath, { mode: "evidence" });
  const evidenceResult = await envdRun(
    baseUrl,
    `/bin/chown 1000:1000 ${evidencePath} && /bin/chmod 0400 ${evidencePath} && /usr/bin/setpriv --reuid 1000 --regid 1000 --clear-groups --no-new-privs /usr/local/bin/node /opt/pi-cloud/bin/envd-guest-control.mjs ${evidencePath}`,
  );
  assert(
    evidenceResult.exitCode === 0,
    `Guest evidence failed: ${evidenceResult.stderr || evidenceResult.stdout}`,
  );
  const evidence = JSON.parse(evidenceResult.stdout).evidence;
  assert(evidence.uid === 1000 && evidence.gid === 1000, "Tool process identity was invalid");
  assert(evidence.noNewPrivileges === true, "Tool process allowed new privileges");
  assert(/^0+$/u.test(evidence.effectiveCapabilities), "Tool process retained capabilities");

  const runControl = async (request) => {
    const path = `/tmp/pi-cloud-envd-${randomUUID()}.json`;
    await writeEnvdFile(baseUrl, path, request);
    const result = await envdRun(
      baseUrl,
      `/bin/chmod 0400 ${path} && /usr/local/bin/node /opt/pi-cloud/bin/envd-guest-control.mjs ${path}`,
    );
    assert(result.exitCode === 0, `Guest control failed: ${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const rootDirectory = await runControl({ mode: "list_directory", path: "/" });
  assert(
    rootDirectory.path === "/" &&
      rootDirectory.entries.some(
        (entry) => entry.name === "workspace" && entry.kind === "directory",
      ),
    "Guest directory listing was invalid",
  );
  const createdDirectory = await runControl({
    mode: "create_directory",
    path: "/tmp",
    name: `pi-cloud-template-${activationId}`,
  });
  assert(
    createdDirectory.entries.some(
      (entry) => entry.name === `pi-cloud-template-${activationId}` && entry.kind === "directory",
    ),
    "Guest directory creation was invalid",
  );
  await envdRun(baseUrl, `/bin/rm -rf -- /tmp/pi-cloud-template-${activationId}`);

  await envdRun(
    baseUrl,
    "printf 'PI_CLOUD_PREVIEW_OK\\n' > /workspace/preview.txt && setsid --fork python3 -m http.server 5173 --bind 0.0.0.0 --directory /workspace </dev/null >/tmp/pi-cloud-preview.log 2>&1",
  );
  let previewResult;
  const previewDeadline = Date.now() + 10_000;
  do {
    previewResult = await envdRun(
      baseUrl,
      "curl --max-time 1 --fail --silent http://127.0.0.1:5173/preview.txt",
    );
    if (previewResult.exitCode === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < previewDeadline);
  const previewDiagnostics =
    previewResult.exitCode === 0
      ? undefined
      : await envdRun(baseUrl, "cat /tmp/pi-cloud-preview.log");
  assert(
    previewResult.exitCode === 0 && previewResult.stdout === "PI_CLOUD_PREVIEW_OK\n",
    `Guest HTTP service failed: ${JSON.stringify({ previewResult, previewDiagnostics })}`,
  );
  await envdRun(baseUrl, "/usr/bin/pkill -f '^python3 -m http.server 5173 '");

  const attachment = {
    activationId,
    toolRoot: "/workspace",
  };
  const runTool = async (request, expectedError = false) => {
    const path = `/tmp/pi-cloud-envd-${randomUUID()}.json`;
    await writeEnvdFile(baseUrl, path, {
      toolWorkerProtocolVersion: 7,
      type: "worker.operation",
      attachment,
      request,
    });
    const result = await envdRun(
      baseUrl,
      `/bin/chown 1000:1000 ${path} && /bin/chmod 0400 ${path} && /usr/bin/setpriv --reuid 1000 --regid 1000 --clear-groups --no-new-privs /usr/local/bin/node /opt/pi-cloud/bin/envd-tool-exec.mjs ${path}`,
      "root",
      request.timeoutMs + 5_000,
    );
    assert(result.exitCode === 0, `Guest Tool launcher failed: ${result.stderr.slice(0, 2000)}`);
    assert(result.stdout.trim(), "Guest Tool launcher omitted its protocol output");
    const frames = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const final = frames.pop();
    assert(
      frames.every(
        (frame) =>
          frame.operationId === request.operationId &&
          frame.event?.type === "tool_execution_update",
      ),
      "Unexpected Tool progress frame",
    );
    assert(final?.type === "worker.operation_result", "Guest omitted its final Tool result");
    const response = final.response;
    assert(
      response.activationId === request.activationId &&
        response.operationId === request.operationId &&
        response.operation === "tool.execute",
      "Tool result identity changed",
    );
    assert(
      response.event?.type === "tool_execution_end" &&
        Boolean(response.event.isError) === expectedError,
      "Native Tool outcome did not match",
    );
    return response.event.result;
  };

  const source = "print('envd-tool-worker-ok')\n";
  await runTool(operation("write", { path: "check.py", content: source }));
  const executed = await runTool(operation("bash", { command: "python3 check.py" }));
  const output = executed.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  assert(output === "envd-tool-worker-ok\n", "Tool command failed");
  const guestFile = await runTool(operation("read", { path: "../etc/passwd" }));
  assert(
    guestFile.content.some((part) => part.type === "text" && part.text.includes("root:")),
    "Native guest read did not resolve cwd-relative paths inside the isolated guest",
  );

  const browser = await runTool(
    operation("bash", {
      command: "node /opt/pi-cloud/browser/check.mjs /workspace/browser-check.png",
    }),
  );
  const browserEvidence = JSON.parse(browser.content.map((part) => part.text ?? "").join(""));
  assert(browserEvidence.interaction && browserEvidence.canvas && browserEvidence.screenshot);
  const screenshot = await runTool(operation("read", { path: "browser-check.png" }));
  assert(
    screenshot.content.some((part) => part.type === "image"),
    "Read omitted the screenshot",
  );

  await runTool(
    operation("write", {
      path: "browser-timeout.mjs",
      content: `import { chromium } from '/opt/pi-cloud/browser/index.mjs';
const browser = await chromium.launch();
await browser.newPage();
console.log('BROWSER_RUNNING');
setInterval(() => {}, 1000);
`,
    }),
  );
  const timedOut = await runTool(
    {
      ...operation("bash", { command: "node browser-timeout.mjs", timeout: 5 }),
      timeoutMs: 5000,
    },
    true,
  );
  const timeoutText = timedOut.content.map((part) => part.text ?? "").join("");
  assert(timeoutText.includes("BROWSER_RUNNING"), "Browser did not start before cancellation");
  assert(timeoutText.includes("timed out"), "Native timeout did not settle the Tool");
  await runTool(
    operation("bash", {
      command:
        "if pgrep -af '^/opt/pi-cloud/browser/browsers/.*/(chrome|headless_shell|chrome-headless-shell)( |$)'; then exit 1; fi",
    }),
  );

  process.stdout.write(
    `${JSON.stringify({
      image,
      imageRevision: evidence.imageRevision,
      cubeDataPlane: "cube-agent-vsock-envd",
      persistentPiCloudGuestDaemon: false,
      toolProcess: {
        uid: evidence.uid,
        gid: evidence.gid,
        noNewPrivileges: evidence.noNewPrivileges,
      },
      execution: { exitCode: executed.exitCode, output: output.trim() },
      nativeGuestPathSemanticsVerified: true,
      directoryControl: true,
      arbitraryPortPreview: true,
      guestBrowser: { ...browserEvidence, nativeRead: true, timeoutCleanup: true },
    })}\n`,
  );
} catch (error) {
  if (started) {
    const logs = await capture("docker", ["logs", "--tail", "200", containerName]).catch(() => "");
    if (logs.length > 0) process.stderr.write(`${logs}\n`);
  }
  throw error;
} finally {
  if (started) await capture("docker", ["rm", "--force", containerName]).catch(() => undefined);
}
