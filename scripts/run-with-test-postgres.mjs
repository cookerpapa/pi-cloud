import { spawn } from "node:child_process";
import { testPostgres } from "./lib/test-postgres.mjs";

const [separator, command, ...args] = process.argv.slice(2);
if (separator !== "--" || !command)
  throw new Error("Usage: run-with-test-postgres.mjs -- command [args]");
let child, stopping;
const stop = (signal) => {
  stopping = signal;
  child?.kill(signal);
};
const interrupt = () => stop("SIGINT"),
  terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
const fixture = await testPostgres();
try {
  process.exitCode = stopping
    ? 1
    : await new Promise((resolve, reject) => {
        child = spawn(command === "node" ? process.execPath : command, args, {
          stdio: "inherit",
          env: {
            ...process.env,
            PI_CLOUD_POSTGRES_INTEGRATION_URL: fixture.url,
            PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL:
              process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL ?? fixture.url,
          },
        });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  await fixture.close();
}
