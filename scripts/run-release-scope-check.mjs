import { imageReleaseTargets } from "./lib/release-impact.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [scope] = process.argv.slice(2);
assert(
  scope === "catalog" || Object.hasOwn(imageReleaseTargets, scope),
  "Use a declared component scope; protocol changes require full checks",
);
if (["session-api", "execution-maintenance"].includes(scope)) {
  const options = { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" };
  execFileSync(
    "npm",
    [
      "run",
      "typecheck",
      "--workspace",
      scope === "session-api" ? "@pi-cloud/control-plane" : "@pi-cloud/sandbox-control",
    ],
    options,
  );
  const tests =
    scope === "session-api"
      ? [
          "packages/control-plane/test/private-multi-tenant-api.test.ts",
          "packages/control-plane/test/production-http-gateway.test.ts",
          "packages/control-plane/test/session-live-service.test.ts",
        ]
      : [
          "packages/sandbox-control/test/execution-maintenance.postgres.test.ts",
          "packages/sandbox-control/test/execution-path-probes.test.ts",
          "packages/sandbox-control/test/runtime-retention.test.ts",
          "packages/runtime-core/test/path-probe.test.ts",
          "packages/runtime-core/test/session-projector-handoffs.test.ts",
          "packages/control-plane/test/control-plane-quiescence.test.ts",
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
      "scripts/lib/runtime-component-release.test.mjs",
      "scripts/lib/component-release.test.mjs",
      "scripts/lib/release-impact.test.mjs",
      "scripts/lib/release-image-evidence.test.mjs",
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--testTimeout=30000",
      "--hookTimeout=60000",
    ],
    options,
  );
  console.log(JSON.stringify({ scope, passed: true }));
  process.exit(0);
}
if (scope === "session-decoder") {
  const options = { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" };
  execFileSync("npm", ["run", "typecheck", "--workspace", "@pi-cloud/runtime-core"], options);
  execFileSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/runtime-core/test/session-log-envelope.test.ts",
      "packages/runtime-core/test/session-projector-handoffs.test.ts",
      "packages/control-plane/test/control-plane-quiescence.test.ts",
      "scripts/lib/runtime-component-release.test.mjs",
      "scripts/lib/component-release.test.mjs",
      "scripts/lib/release-impact.test.mjs",
      "scripts/lib/release-image-evidence.test.mjs",
      "--maxWorkers=1",
    ],
    options,
  );
  console.log(JSON.stringify({ scope, passed: true }));
  process.exit(0);
}
if (scope === "tool-host") {
  const options = { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" };
  execFileSync(process.execPath, ["scripts/check-helm-platform.mjs"], options);
  execFileSync("npm", ["run", "typecheck", "--workspace", "@pi-cloud/control-plane"], options);
  execFileSync(
    process.execPath,
    [
      "scripts/run-with-test-postgres.mjs",
      "--",
      "node",
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/control-plane/test/ordinary-tools",
      "packages/control-plane/test/control-image-tool.test.ts",
      "packages/control-plane/test/control-preview-tool.test.ts",
      "packages/control-plane/test/image-generation-client.test.ts",
      "packages/control-plane/test/image-reference-context.postgres.test.ts",
      "packages/control-plane/test/show-image-tool.test.ts",
      "packages/control-plane/test/control-tool-catalog.test.ts",
      "packages/control-plane/test/control-tool-results.test.ts",
      "packages/control-plane/test/control-tool-dispatcher.test.ts",
      "packages/control-plane/test/control-plane-quiescence.test.ts",
      "packages/runtime-core/test/session-projector-handoffs.test.ts",
      "packages/supervisor-host/test/worker-tool-runtime.test.ts",
      "packages/sandbox-supervisor/test/trusted-remote-tools.test.ts",
      "scripts/lib/component-release.test.mjs",
      "scripts/lib/runtime-component-release.test.mjs",
      "scripts/lib/tool-host-activation.test.mjs",
      "packages/control-plane/test/tool-host-client.test.ts",
      "packages/event-log/test/tool-catalog.test.ts",
      "scripts/lib/owned-runtime-outage.test.mjs",
      "scripts/lib/release-impact.test.mjs",
      "scripts/lib/release-image-evidence.test.mjs",
      "--maxWorkers=1",
      "--testTimeout=30000",
      "--hookTimeout=60000",
    ],
    options,
  );
  console.log(JSON.stringify({ scope, passed: true }));
  process.exit(0);
}
if (scope === "web") {
  const options = { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit" };
  execFileSync("npm", ["run", "typecheck", "--workspace", "@pi-cloud/web-ui"], options);
  execFileSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/web-ui/test",
      "scripts/lib/component-release.test.mjs",
      "scripts/lib/release-image-evidence.test.mjs",
      "--maxWorkers=1",
    ],
    options,
  );
  execFileSync(process.execPath, ["scripts/run-browser-presentation-check.mjs"], options);
  execFileSync(process.execPath, ["scripts/run-browser-queue-check.mjs"], options);
  execFileSync(process.execPath, ["scripts/run-skill-market-browser-check.mjs"], options);
  execFileSync(process.execPath, ["scripts/run-history-layout-check.mjs"], options);
  console.log(JSON.stringify({ scope, passed: true }));
  process.exit(0);
}
const tests = [
  "scripts/lib/provider-config-release.test.mjs",
  "scripts/lib/model-continuation-traffic.test.mjs",
  "scripts/lib/operator-fixtures.test.mjs",
  "scripts/lib/provider-runtime-policy.test.mjs",
  "scripts/lib/provider-websocket-policy.test.mjs",
  "scripts/lib/deepseek-configuration.test.mjs",
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
