import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
const directory = mkdtempSync(join(tmpdir(), "pi-cloud-android-chart-"));
try {
  const values = join(directory, "values.json");
  writeFileSync(
    values,
    JSON.stringify({
      targetId: "00000000-0000-4000-8000-000000000001",
      nodeName: "owned-node",
      artifactDirectory: "/var/lib/pi-cloud/android/one/artifacts",
      hostDirectory: "/var/lib/pi-cloud/android/one/host",
      stateDirectory: "/var/lib/pi-cloud/android/one/state",
      images: Object.fromEntries(
        ["runtime", "automation", "executor", "egress"].map((k) => [
          k,
          `pi-cloud/android-${k}:fixture`,
        ]),
      ),
    }),
  );
  const yaml = execFileSync(
    "helm",
    ["template", "android-fixture", "deploy/helm/pi-cloud-android", "-f", values],
    { encoding: "utf8" },
  );
  const objects = parseAllDocuments(yaml).map((d) => {
    assert.equal(d.errors.length, 0);
    return d.toJSON();
  });
  const set = objects.find((o) => o.kind === "StatefulSet"),
    pod = set.spec.template.spec;
  assert.equal(set.spec.updateStrategy.type, "OnDelete");
  assert.equal(pod.nodeSelector["kubernetes.io/hostname"], "owned-node");
  assert.equal(pod.hostNetwork, undefined);
  assert.equal(pod.automountServiceAccountToken, false);
  const guest = pod.containers.find((c) => c.name === "android");
  assert.equal(guest.securityContext.privileged, true);
  assert.deepEqual(guest.volumeMounts.map((m) => m.name).sort(), [
    "host",
    "runtime",
    "source",
    "state",
  ]);
  assert.equal(guest.env.length, 1);
  for (const c of pod.containers) assert.equal(c.resources.limits, undefined);
  assert(!yaml.includes("docker.sock"));
  assert(!yaml.includes("hostPort:"));
  assert.deepEqual(
    objects.find((o) => o.kind === "Service").spec.ports.map((p) => p.port),
    [8090],
  );
  assert(
    pod.containers.find((c) => c.name === "automation").args[0].includes("--address 127.0.0.1"),
  );
  const start = readFileSync("deploy/helm/pi-cloud-android/files/start.sh", "utf8");
  assert(start.includes("Partial Android initialization requires operator reconciliation"));
  assert(start.includes("PI_ANDROID_INPUT"));
  execFileSync("bash", ["-n", "deploy/helm/pi-cloud-android/files/start.sh"]);
  console.log(
    "Android chart: retained device state, private execution ports and separate credential mounts passed",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
