import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const compose = parse(readFileSync(resolve(root, "deploy/production/compose.yaml"), "utf8"), {
  customTags: [{ tag: "!override", collection: "seq", resolve: (value) => value }],
});
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--security-opt",
    "no-new-privileges:true",
    "--mount",
    `type=bind,src=${resolve(root, "deploy/observability")},dst=/contracts,readonly`,
    "--workdir",
    "/contracts/tests",
    "--entrypoint",
    "/bin/promtool",
    compose.services.prometheus.image,
    "test",
    "rules",
    "sampler.test.yml",
  ],
  { stdio: "inherit", timeout: 60_000 },
);
assert.equal(result.status, 0, result.error?.message ?? "Prometheus rule regression failed");
