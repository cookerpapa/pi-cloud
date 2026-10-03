import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const prometheusImage =
  "prom/prometheus@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996";
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
    prometheusImage,
    "test",
    "rules",
    "sampler.test.yml",
  ],
  { stdio: "inherit", timeout: 60_000 },
);
assert.equal(result.status, 0, result.error?.message ?? "Prometheus rule regression failed");
