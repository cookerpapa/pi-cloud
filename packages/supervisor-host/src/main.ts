import { createDatabase } from "@pi-cloud/database";
import { startServiceObservability } from "@pi-cloud/observability";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadSupervisorHostConfig } from "./config.ts";
import { PiWorkerRuntime } from "./runtime.ts";

type StopReason = "sigint" | "sigterm" | "owner_stopped" | "connection_failed";

function safeFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof TypeError) return "invalid_supervisor_configuration";
  return "pi_worker_start_failed";
}

function signalPromise(onCleanup: (cleanup: () => void) => void): Promise<"sigint" | "sigterm"> {
  return new Promise((resolvePromise) => {
    const interrupt = () => resolvePromise("sigint");
    const terminate = () => resolvePromise("sigterm");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    onCleanup(() => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    });
  });
}

export async function startSupervisorHost(): Promise<void> {
  const config = await loadSupervisorHostConfig();
  let observability: Awaited<ReturnType<typeof startServiceObservability>> | undefined;
  let database: ReturnType<typeof createDatabase> | undefined;
  let runtime: PiWorkerRuntime | undefined;
  let removeSignals: (() => void) | undefined;
  const errors: unknown[] = [];
  try {
    observability = await startServiceObservability({
      serviceName: "pi-cloud-trusted-runner",
      defaultMetricsPort: 9465,
    });
    database = createDatabase({
      connectionString: config.databaseUrl,
      maxConnections: config.databaseMaxConnections,
    });
    runtime = new PiWorkerRuntime({ config, database, metrics: observability.metrics });
    await runtime.start();
    const identity = runtime.identity!;
    process.stdout.write(
      `PiCloud Supervisor host ready supervisor=${identity.supervisorId} boot=${identity.bootId} sandbox=${identity.sandboxId}\n`,
    );
    const reason: StopReason = await Promise.race([
      runtime.waitUntilTerminal(),
      signalPromise((cleanup) => {
        removeSignals = cleanup;
      }),
    ]);
    if (reason === "owner_stopped") {
      // Give Fastify a bounded window to flush the owner proof before this
      // process exits and the container runtime starts a fresh boot.
      await delay(250);
    }
    if (reason === "connection_failed") {
      process.stderr.write(
        `PiCloud Supervisor host failed code=${runtime.terminalFailureCode ?? "supervisor_connection_failed"}\n`,
      );
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    errors.push(error);
  }
  for (const close of [
    removeSignals,
    () => runtime?.close(),
    () => observability?.close(),
    () => database?.destroy(),
  ]) {
    try {
      await close?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Pi Worker startup/shutdown failed", { cause: errors[0] });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startSupervisorHost().catch((error: unknown) => {
    process.stderr.write(`PiCloud Supervisor host failed code=${safeFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
