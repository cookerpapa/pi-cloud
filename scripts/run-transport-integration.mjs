// Explicit isolated RF3/PG coverage for cases skipped by the default suite.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testKafka } from "./lib/test-kafka.mjs";
import { testPostgres } from "./lib/test-postgres.mjs";

let kafka, postgres;
try {
  kafka = await testKafka({});
  postgres = await testPostgres({});
  const files = [
    "packages/event-log/test/publication.integration.test.ts",
    "packages/event-log/test/rolling-reader.integration.test.ts",
    "packages/event-log/test/tool-reply-recovery.integration.test.ts",
    "packages/runtime-core/test/kafka-topic-policy.integration.test.ts",
    "packages/control-plane/test/session-publication.integration.test.ts",
    "packages/control-plane/test/ordered-binding-views.integration.test.ts",
    "packages/control-plane/test/subagent-views.integration.test.ts",
    "packages/control-plane/test/agent-stop-binding-closure.integration.test.ts",
  ];
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      ...files,
      "--maxWorkers=1",
      "--testTimeout=180000",
      "--hookTimeout=60000",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PI_CLOUD_POSTGRES_INTEGRATION_URL: postgres.url,
        PI_CLOUD_KAFKA_INTEGRATION_BROKERS: kafka.brokers.join(","),
      },
      stdio: "inherit",
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  const closed = await Promise.allSettled([kafka?.close(), postgres?.close()]);
  const errors = closed.filter((value) => value.status === "rejected").map((value) => value.reason);
  if (errors.length) throw new AggregateError(errors, "Owned transport fixture cleanup failed");
}
