import { spawn, execFileSync } from "node:child_process";
import { readFile, realpath, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { connectDevice } from "@pi-cloud/device-link";

export async function localNamespaceArguments(options: {
  repository: string;
  project: string;
  receiverTokenFile: string;
  targetId: string;
  port: number;
}) {
  if (process.platform !== "linux")
    throw new Error("Local execution currently requires Linux and Bubblewrap 0.9.0");
  const project = await realpath(options.project);
  try {
    const privateRuntime = await realpath(resolve(options.repository, "deploy/production/runtime"));
    if (privateRuntime === project || privateRuntime.startsWith(project + "/"))
      throw new Error("Select a project without platform runtime credentials");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (project === "/" || project === (await realpath(homedir())))
    throw new Error("Select a project directory, not the host root or home");
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)
    throw new Error("Invalid local receiver port");
  if (!/^[0-9a-f-]{36}$/i.test(options.targetId)) throw new Error("Invalid target ID");
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
  ];
  for (const path of ["/usr", "/bin", "/lib", "/lib64"]) {
    try {
      await access(path);
      args.push("--ro-bind", path, path);
    } catch {
      if (path === "/usr") throw new Error("Linux runtime unavailable");
    }
  }
  args.push(
    "--tmpfs",
    "/usr/local/bin",
    "--ro-bind",
    process.execPath,
    "/usr/local/bin/node",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/etc",
  );
  const npm = resolve(dirname(process.execPath), "../lib/node_modules/npm");
  try {
    await access(npm);
    args.push(
      "--ro-bind",
      npm,
      "/opt/pma-npm",
      "--symlink",
      "/opt/pma-npm/bin/npm-cli.js",
      "/usr/local/bin/npm",
      "--symlink",
      "/opt/pma-npm/bin/npx-cli.js",
      "/usr/local/bin/npx",
    );
  } catch {}
  args.push("--chmod", "0555", "/usr/local/bin");
  for (const path of ["/etc/resolv.conf", "/etc/ssl", "/etc/hosts"]) {
    try {
      await access(path);
      args.push("--ro-bind", path, path);
    } catch {}
  }
  args.push(
    "--dir",
    "/app",
    "--ro-bind",
    resolve(options.repository, "node_modules"),
    "/app/node_modules",
  );
  for (const name of [
    "protocol",
    "workspace-runtime",
    "tool-sandbox",
    "executor-runtime",
    "local-executor",
    "device-link",
  ]) {
    args.push("--ro-bind", resolve(options.repository, "packages", name), `/app/packages/${name}`);
  }
  args.push(
    "--ro-bind",
    resolve(options.repository, "tsconfig.base.json"),
    "/app/tsconfig.base.json",
    "--ro-bind",
    resolve(options.repository, "package.json"),
    "/app/package.json",
    "--dir",
    "/run/pma",
    "--ro-bind",
    await realpath(options.receiverTokenFile),
    "/run/pma/receiver-token",
    "--bind",
    project,
    "/workspace",
    "--chdir",
    "/workspace",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "PI_CLOUD_LOCAL_EXECUTION_ISOLATED",
    "1",
    "--setenv",
    "PI_CLOUD_EXECUTION_TARGET_ID",
    options.targetId,
    "--setenv",
    "PI_CLOUD_EXECUTOR_PORT",
    String(options.port),
    "--",
    "/usr/local/bin/node",
    "/app/node_modules/tsx/dist/cli.mjs",
    "--tsconfig",
    "/app/tsconfig.base.json",
    "/app/packages/local-executor/src/main.ts",
  );
  return args;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: local-executor CONFIG_JSON");
  if (execFileSync("bwrap", ["--version"], { encoding: "utf8" }).trim() !== "bubblewrap 0.9.0")
    throw new Error("Use the validated Bubblewrap 0.9.0 runtime");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("Invalid local executor configuration");
  }
  const config = parsed as {
    targetId: string;
    project: string;
    port: number;
    gatewayUrl: string;
    deviceTokenFile: string;
    receiverTokenFile: string;
  };
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const args = await localNamespaceArguments({ repository, ...config });
  const controller = new AbortController();
  const child = spawn("bwrap", args, { stdio: ["ignore", "inherit", "inherit"] });
  const stop = () => {
    controller.abort();
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const exited = new Promise<void>((resolveExit, reject) => {
    child.once("error", (error) => {
      controller.abort();
      reject(error);
    });
    child.once("exit", (code) => {
      const stopped = controller.signal.aborted;
      controller.abort();
      if (code && !stopped) reject(new Error("Local executor exited"));
      else resolveExit();
    });
  });
  void exited.catch(() => {});
  try {
    const receiverToken = (await readFile(config.receiverTokenFile, "utf8")).trim();
    for (let attempt = 0; attempt < 100; attempt++) {
      controller.signal.throwIfAborted();
      try {
        const response = await fetch(`http://127.0.0.1:${config.port}/health/ready`, {
          headers: { authorization: "Bearer " + receiverToken },
          signal: AbortSignal.timeout(500),
        });
        const value = (await response.json()) as { targetId?: string };
        if (response.ok && value.targetId === config.targetId) break;
      } catch {}
      if (attempt === 99) throw new Error("Local executor did not become ready");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    await connectDevice({
      url: config.gatewayUrl,
      deviceToken: (await readFile(config.deviceTokenFile, "utf8")).trim(),
      receiverUrl: `http://127.0.0.1:${config.port}`,
      receiverToken,
      signal: controller.signal,
      onStatus: (state) =>
        process.stdout.write(JSON.stringify({ event: "local_device_link", state }) + "\n"),
    });
  } finally {
    stop();
    await exited;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : "Local executor failed") + "\n");
    process.exitCode = 1;
  });
