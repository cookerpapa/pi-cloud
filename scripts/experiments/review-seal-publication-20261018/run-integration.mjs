// Existing Session publication contract on disposable, loopback-only RF3/PG.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testKafka } from "../../lib/test-kafka.mjs";
import { testPostgres } from "../../lib/test-postgres.mjs";

let kafka, postgres;
try {
  kafka = await testKafka({});
  postgres = await testPostgres({});
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/control-plane/test/session-publication.integration.test.ts",
      "--maxWorkers=1",
      "--testTimeout=180000",
      "--hookTimeout=60000",
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
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
  const errors = closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Review fixture cleanup failed");
}
