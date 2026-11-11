import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, release } from "node:os";
import { join } from "node:path";

const marker = "# Managed by PiCloud's WSL local web adapter.\n";
const unitNames = ["pi-cloud-local-web.socket", "pi-cloud-local-web.service"];
const unitDirectory = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user");
const run = (args) =>
  execFileSync("systemctl", ["--user", ...args], { stdio: "inherit", timeout: 30_000 });

// A matched maintenance run can require root for storage operations. The WSL
// localhost socket still belongs to the runtime owner's user service manager.
export function runWslWebAsRuntimeOwner({ runtimeDirectory, script }) {
  if (!release().toLowerCase().includes("microsoft") || process.geteuid() !== 0) return false;
  const owner = statSync(join(runtimeDirectory, "secrets/cubesandbox-api-key"));
  if (owner.uid === 0) return false;
  const fields = execFileSync("getent", ["passwd", String(owner.uid)], { encoding: "utf8" })
    .trim()
    .split(":");
  assert(fields.length === 7 && Number(fields[2]) === owner.uid, "Runtime owner is unavailable");
  assert(fields[5].startsWith("/"), "Runtime owner home is invalid");
  execFileSync(
    "runuser",
    [
      "--user",
      fields[0],
      "--",
      "/usr/bin/env",
      `XDG_CONFIG_HOME=${join(fields[5], ".config")}`,
      `XDG_RUNTIME_DIR=/run/user/${owner.uid}`,
      `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${owner.uid}/bus`,
      process.execPath,
      script,
      "local-web",
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  return true;
}
async function readUnit(directory, name) {
  const body = await readFile(join(directory, name), "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  assert(body === undefined || body.startsWith(marker), "Refuse to replace an unrelated user unit");
  return body;
}

export async function removeWslWebForwarder() {
  if (!release().toLowerCase().includes("microsoft")) return;
  const directory = unitDirectory();
  const existing = [];
  for (const name of unitNames)
    if ((await readUnit(directory, name)) !== undefined) existing.push(name);
  if (existing.length === 0) return;
  if (existing.includes(unitNames[0])) run(["disable", "--now", unitNames[0]]);
  if (existing.includes(unitNames[1])) run(["stop", unitNames[1]]);
  for (const name of existing) await unlink(join(directory, name));
  run(["daemon-reload"]);
}

// WSL's Windows localhost discovery needs a real listening socket. A K3s
// hostPort implemented only by DNAT is reachable inside Linux but may be
// invisible to Windows. Adopt systemd's TCP proxy; keep the application in K3s.
export async function ensureWslWebForwarder({ port, hostIP, upstreamIP }) {
  if (!release().toLowerCase().includes("microsoft")) return false;
  if (!port || hostIP !== "127.0.0.1") {
    await removeWslWebForwarder();
    return false;
  }
  assert(Number.isInteger(port) && port > 0 && port <= 65535, "Invalid local web port");
  assert.equal(isIP(upstreamIP), 4, "Expected the web Service's IPv4 ClusterIP");
  const directory = unitDirectory();
  const units = {
    "pi-cloud-local-web.socket": `${marker}[Unit]
Description=PiCloud Windows localhost web entry

[Socket]
ListenStream=127.0.0.1:${port}
NoDelay=true

[Install]
WantedBy=sockets.target
`,
    "pi-cloud-local-web.service": `${marker}[Unit]
Description=PiCloud localhost to Kubernetes web Service
Requires=pi-cloud-local-web.socket
After=pi-cloud-local-web.socket

[Service]
ExecStart=/usr/lib/systemd/systemd-socket-proxyd ${upstreamIP}:8080
Restart=on-failure
NoNewPrivileges=true
`,
  };
  const previous = new Map();
  for (const name of Object.keys(units)) previous.set(name, await readUnit(directory, name));
  if (Object.entries(units).some(([name, body]) => previous.get(name) !== body)) {
    if (previous.get("pi-cloud-local-web.socket") !== undefined)
      run(["stop", "pi-cloud-local-web.service", "pi-cloud-local-web.socket"]);
    await mkdir(directory, { recursive: true });
    for (const [name, body] of Object.entries(units))
      await writeFile(join(directory, name), body, { mode: 0o644 });
    run(["daemon-reload"]);
  }
  run(["enable", "--now", "pi-cloud-local-web.socket"]);
  return true;
}
