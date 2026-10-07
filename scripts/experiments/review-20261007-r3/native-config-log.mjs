import { kubectl } from "../../lib/production-kubernetes.mjs";
import { parse, stringify } from "yaml";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
if (process.env.PI_CLOUD_REVIEW_NATIVE_LOG !== "1")
  throw Error("Set PI_CLOUD_REVIEW_NATIVE_LOG=1 for the owned, network-disabled container probe");
const deployment = JSON.parse(kubectl(["get", "deployment", "cube-master", "-o", "json"]));
const image = deployment.spec.template.spec.containers.find((c) => c.name === "cube-master").image;
const secret = JSON.parse(kubectl(["get", "secret", "cube-master-config", "-o", "json"]));
const cfg = parse(Buffer.from(secret.data["conf.yaml"], "base64").toString());
const sentinel = "REVIEW_ONLY_FAKE_PASSWORD_20261007";
function scrub(value, sensitive = false) {
  if (typeof value === "string") return sensitive ? sentinel : value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, sensitive));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        scrub(
          v,
          sensitive || /authorization|api[_-]?key|pwd|password|secret|token|credential/i.test(k),
        ),
      ]),
    );
  return value;
}
const dir = await mkdtemp(join(tmpdir(), "pi-cloud-review-config-")),
  path = join(dir, "config.yaml"),
  name = "pi-cloud-review-config-" + randomUUID();
let output = "";
try {
  await writeFile(path, stringify(scrub(cfg)), { mode: 0o600 });
  try {
    output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--mount",
        "type=bind,src=" + path + ",dst=/tmp/review-config.yaml,readonly",
        "--env",
        "CUBE_MASTER_CONFIG_PATH=/tmp/review-config.yaml",
        image,
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 10000, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    output = (error.stdout ?? "") + (error.stderr ?? "");
  }
} finally {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  } catch {}
  await rm(dir, { recursive: true, force: true });
}
const result = {
  checkedAt: new Date().toISOString(),
  image,
  isolatedNetwork: true,
  syntheticCredentialsOnly: true,
  configurationDump: output.includes("cfg:"),
  fakePasswordLogged: output.includes(sentinel),
  productionCredentialsUsed: false,
};
await writeFile(
  process.argv[2] ?? "/tmp/pi-cloud-native-config-log.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
