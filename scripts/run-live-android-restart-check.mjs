/** Owned Cuttlefish restart acceptance. Run after the Session/operation gate
 * has settled and unbound the target; preserve its existing state directory. */
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { kubectl, runtimeDirectory, serviceAddress } from "./lib/production-kubernetes.mjs";
import { createDatabase } from "../packages/database/src/index.ts";
const [targetId, targetDirectory, out] = process.argv.slice(2);
assert.equal(process.env.PI_CLOUD_LIVE_ANDROID_CHECK, "1");
assert(
  /^[a-f0-9-]{36}$/.test(targetId ?? "") && targetDirectory && out,
  "Supply target UUID, owned target directory and private report path",
);
const target = JSON.parse(await readFile(targetDirectory + "/target.json", "utf8"));
assert.equal(target.targetId, targetId);
const endpoint = new URL(
  (await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 1 });
try {
  const registered = await database
    .selectFrom("execution_targets")
    .select(["id", "bound_session_id"])
    .where("id", "=", targetId)
    .executeTakeFirstOrThrow();
  assert.equal(registered.bound_session_id, null, "Do not restart a bound device");
  assert.equal(
    (
      await database
        .selectFrom("execution_target_bindings")
        .select("id")
        .where("target_id", "=", targetId)
        .execute()
    ).length,
    0,
    "Device work is not settled",
  );
} finally {
  await database.destroy();
}
const pod = "pi-android-" + targetId.slice(0, 8) + "-0";
const adb = (...args) =>
  kubectl(["exec", pod, "-c", "automation", "--", "adb", "-s", "127.0.0.1:6520", ...args], {
    timeout: 30000,
  }).trim();
const marker = randomUUID(),
  key = "pma_recovery_" + marker.replaceAll("-", ""),
  path = "/data/local/tmp/pma-" + marker;
const userdata = targetDirectory + "/state/images/userdata.img";
const before = await stat(userdata);
const boot = adb("shell", "cat", "/proc/sys/kernel/random/boot_id");
const report = {
  marker,
  key,
  path,
  boot,
  userdata: { inode: before.ino, device: before.dev, size: before.size },
  passed: false,
  markersRemoved: false,
};
await writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
adb("shell", "settings", "put", "global", key, marker);
adb("shell", `printf '%s' '${marker}' > '${path}'`);
await delay(2000);
adb("shell", "sync");
assert.equal(adb("shell", "settings", "get", "global", key), marker);
assert.equal(adb("shell", "cat", path), marker);
const previous = JSON.parse(kubectl(["get", "pod/" + pod, "-o", "json"]));
kubectl(["delete", "pod/" + pod, "--wait=true", "--timeout=120s"], { timeout: 125000 });
const end = Date.now() + 600000;
let ready = false;
while (Date.now() < end) {
  const raw = kubectl(["get", "pod/" + pod, "--ignore-not-found", "-o", "json"]);
  if (raw.trim()) {
    const current = JSON.parse(raw);
    if (
      current.metadata.uid !== previous.metadata.uid &&
      current.status.conditions?.some((c) => c.type === "Ready" && c.status === "True")
    ) {
      ready = true;
      break;
    }
  }
  await delay(1000);
}
assert(ready, "Android restart did not become ready");
const nextBoot = adb("shell", "cat", "/proc/sys/kernel/random/boot_id");
assert.notEqual(nextBoot, boot);
assert.equal(adb("shell", "settings", "get", "global", key), marker);
assert.equal(adb("shell", "cat", path), marker);
const after = await stat(userdata);
assert.equal(after.ino, before.ino);
assert.equal(after.dev, before.dev);
assert.equal(after.size, before.size);
report.bootChanged = true;
report.settingRetained = true;
report.fileRetained = true;
report.originalUserdataFileRetained = true;
adb("shell", "settings", "delete", "global", key);
adb("shell", "rm", "--", path);
report.markersRemoved = true;
report.passed = true;
await writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log({
  passed: true,
  bootChanged: true,
  settingRetained: true,
  fileRetained: true,
  originalUserdataFileRetained: true,
  markersRemoved: true,
});
