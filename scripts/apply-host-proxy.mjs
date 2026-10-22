import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  statSync,
  chownSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  normalizeUpstreamProxy,
  dockerProxyDropIn,
  k3sProxyEnvironment,
} from "./lib/upstream-proxy.mjs";

assert.equal(process.getuid?.(), 0, "Host proxy configuration requires administrator access");
const proxy = normalizeUpstreamProxy(readFileSync(process.argv[2], "utf8").trim());
const capture = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const info = JSON.parse(capture(["info", "--format", "{{json .}}"]));
const restart = info.HttpProxy !== proxy || info.HttpsProxy !== proxy;
if (restart)
  assert.equal(
    capture(["ps", "-q"]),
    "",
    "Finish Docker build/test containers before changing the daemon proxy",
  );
const path = "/etc/systemd/system/docker.service.d/http-proxy.conf";
const current = existsSync(path) ? readFileSync(path, "utf8") : "";
assert(
  current
    .split(/\r?\n/u)
    .every(
      (line) =>
        !line.trim() ||
        line.startsWith("#") ||
        line === "[Service]" ||
        /^Environment="(?:HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=.*"$/u.test(line),
    ),
  "Docker http-proxy.conf contains unrelated settings; preserve them before using this operator",
);
const next = dockerProxyDropIn(proxy, info.NoProxy || "127.0.0.1,localhost");
if (current !== next) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + `.${process.pid}.tmp`;
  writeFileSync(temporary, next, { mode: 0o644 });
  renameSync(temporary, path);
  execFileSync("systemctl", ["daemon-reload"]);
}
if (restart) {
  // systemd owns the restart job even if this operator exits. BuildKit catalog
  // initialization on a large host can exceed systemctl's former client budget.
  execFileSync("systemctl", ["restart", "--no-block", "docker"], {
    stdio: "inherit",
    timeout: 10000,
  });
  const deadline = Date.now() + 300000;
  for (;;) {
    try {
      const currentInfo = JSON.parse(capture(["info", "--format", "{{json .}}"]));
      if (currentInfo.HttpProxy === proxy && currentInfo.HttpsProxy === proxy) break;
    } catch {
      /* The daemon socket is unavailable during restart. */
    }
    if (Date.now() >= deadline)
      throw new Error(
        "Docker restart is still unconfirmed; inspect its systemd job and reapply after it becomes ready",
      );
    await delay(1000);
  }
}
const actual = JSON.parse(capture(["info", "--format", "{{json .}}"]));
assert.equal(actual.HttpProxy, proxy);
assert.equal(actual.HttpsProxy, proxy);
console.log(JSON.stringify({ dockerProxy: proxy, restarted: restart }));

const k3sPath = "/etc/systemd/system/k3s.service.env";
if (existsSync(k3sPath)) {
  const system = (args) =>
    execFileSync("systemctl", args, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  // This operator supports the normal K3s unit, whose stop preserves containers.
  // A custom unit that kills workloads requires its own maintenance procedure.
  assert.equal(system(["show", "k3s", "--property=KillMode", "--value"]), "process");
  assert.equal(system(["show", "k3s", "--property=ExecStop", "--value"]), "");
  assert.equal(system(["show", "k3s", "--property=ExecStopPost", "--value"]), "");
  const processEnvironment = () => {
    const pid = system(["show", "k3s", "--property=MainPID", "--value"]);
    assert(/^[1-9][0-9]*$/u.test(pid), "K3s is not running");
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .filter((x) => x.includes("="))
        .map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]),
    );
  };
  const source = readFileSync(k3sPath, "utf8");
  const nextK3s = k3sProxyEnvironment(source, proxy),
    before = processEnvironment();
  const restartK3s = nextK3s.keys.some((key) => before[key] !== proxy);
  if (source !== nextK3s.content) {
    const info = statSync(k3sPath),
      temporary = k3sPath + `.${process.pid}.tmp`;
    writeFileSync(temporary, nextK3s.content, { mode: info.mode & 0o777 });
    chownSync(temporary, info.uid, info.gid);
    renameSync(temporary, k3sPath);
  }
  if (restartK3s) {
    system(["restart", "--no-block", "k3s"]);
    const deadline = Date.now() + 300000;
    for (;;) {
      try {
        const actual = processEnvironment();
        assert(nextK3s.keys.every((key) => actual[key] === proxy));
        execFileSync(
          "/usr/local/bin/k3s",
          [
            "kubectl",
            "--kubeconfig",
            "/etc/rancher/k3s/k3s.yaml",
            "--request-timeout=3s",
            "get",
            "--raw=/readyz",
          ],
          { stdio: "pipe", timeout: 5000 },
        );
        break;
      } catch {
        /* Wait for the existing service and its API to become ready. */
      }
      if (Date.now() >= deadline)
        throw new Error(
          "K3s proxy restart remains unconfirmed; inspect its systemd job before reapplying",
        );
      await delay(1000);
    }
  }
  console.log(JSON.stringify({ k3sProxy: proxy, restarted: restartK3s }));
}
