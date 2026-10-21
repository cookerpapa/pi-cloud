import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [scope] = process.argv.slice(2);
assert(
  ["provider", "catalog"].includes(scope),
  "Use provider or catalog; protocol changes require full checks",
);
const tests = [
  "scripts/lib/component-release.test.mjs",
  "scripts/lib/release-impact.test.mjs",
  "scripts/lib/matched-release.test.mjs",
  "scripts/lib/release-image-evidence.test.mjs",
  "scripts/lib/guest-build-identity.test.mjs",
  "scripts/lib/model-catalog-probe.test.mjs",
  "packages/protocol/test/model-catalog.test.ts",
  "packages/supervisor-host/test/model-gateway.test.ts",
  ...(scope === "catalog"
    ? [
        "packages/control-plane/test/runtime-model-catalog.test.ts",
        "packages/control-plane/test/model-catalog-snapshot.postgres.test.ts",
        "packages/control-plane/test/tenant-model-configuration.test.ts",
        "packages/web-ui/test/model-settings-menu.test.ts",
        "packages/web-ui/test/api.test.ts",
      ]
    : []),
];
execFileSync(
  process.execPath,
  [
    "scripts/run-with-test-postgres.mjs",
    "--",
    "node",
    "node_modules/vitest/vitest.mjs",
    "run",
    ...tests,
    "--maxWorkers=1",
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  },
);
console.log(JSON.stringify({ scope, checks: tests, passed: true }));
