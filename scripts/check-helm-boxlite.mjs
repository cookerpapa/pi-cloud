import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
const directory = mkdtempSync(join(tmpdir(), "boxlite-chart-"));
try {
  const adapter = JSON.parse(readFileSync("packages/boxlite-node/package.json", "utf8"));
  const native = JSON.parse(readFileSync("packages/boxlite-node/native/package-lock.json", "utf8"));
  const root = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(
    native.packages[""].dependencies["@boxlite-ai/boxlite"],
    adapter.dependencies["@boxlite-ai/boxlite"],
  );
  for (const [path, entry] of Object.entries(native.packages)) {
    if (!path) continue;
    assert(
      path.startsWith("node_modules/@boxlite-ai/"),
      "The native stage must not reinstall platform dependencies",
    );
    assert.equal(entry.version, root.packages[path]?.version);
    assert.equal(entry.integrity, root.packages[path]?.integrity);
  }
  const file = join(directory, "values.json");
  writeFileSync(
    file,
    JSON.stringify({
      nodeName: "owned-node",
      nodeId: "owned-boxlite",
      image: "pi-cloud/boxlite-node:fixture",
      dataDirectory: "/owned/boxlite",
      workspacePoolDirectory: "/owned/workspace",
      replicas: 1,
      profiles: {
        tool: {
          image: "owned.test/guest@sha256:" + "a".repeat(64),
          cpus: 1,
          memoryMiB: 1024,
          diskGiB: 8,
        },
      },
      allowedAddresses: ["10.0.0.1/32"],
    }),
  );
  const yaml = execFileSync(
    "helm",
    ["template", "pi-cloud-boxlite", "deploy/helm/pi-cloud-boxlite", "-f", file],
    { encoding: "utf8" },
  );
  const items = parseAllDocuments(yaml).map((doc) => {
    assert.equal(doc.errors.length, 0);
    return doc.toJSON();
  });
  const set = items.find((v) => v.kind === "StatefulSet"),
    pod = set.spec.template.spec,
    container = pod.containers[0];
  assert.equal(set.spec.updateStrategy.type, "OnDelete");
  assert.equal(pod.hostPID, true);
  assert.equal(pod.hostNetwork, undefined);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.nodeSelector["kubernetes.io/hostname"], "owned-node");
  assert.deepEqual(container.volumeMounts.map((v) => v.name).sort(), [
    "config",
    "secrets",
    "state",
    "workspace",
  ]);
  assert.equal(
    container.env.find((v) => v.name === "PI_CLOUD_SANDBOX_CONTROL_TOKEN_FILE").value,
    "/run/pi-cloud-secrets/sandbox-control-token",
  );
  assert(!yaml.includes("docker.sock"));
  assert(!yaml.includes("database-url"));
  assert(!yaml.includes("KAFKA"));
  assert(!yaml.includes("IMAGE_S3"));
  assert.equal(container.readinessProbe.httpGet.path, "/health/ready");
  assert(container.livenessProbe.exec.command.includes("/usr/bin/supervisorctl"));
  const config = JSON.parse(items.find((v) => v.kind === "ConfigMap").data["node.json"]);
  assert.equal(config.directory, "/var/lib/pi-cloud-boxlite");
  assert.equal(config.profiles.tool.image.endsWith("a".repeat(64)), true);
  const supervisor = readFileSync("deploy/boxlite/supervisord.conf", "utf8");
  for (const line of ["autorestart=true", "stopasgroup=false", "killasgroup=false", "chmod=0700"])
    assert(supervisor.includes(line));
  assert(!supervisor.includes("[inet_http_server]"));
  console.log(
    "BoxLite chart: owned KVM/PID boundary, scoped storage, API-child recovery and private credentials passed",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
