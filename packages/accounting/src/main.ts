import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createDatabase } from "@pi-cloud/database";
import { createMeteringApplication } from "./http.ts";
import { CubeLifecycleSource } from "./cube-lifecycle-source.ts";
import { LifecycleCollector } from "./lifecycle-collector.ts";

async function secretFile(name: string): Promise<string> {
  const file = process.env[name];
  if (!file) throw new Error(`${name} is required`);
  const value = (await readFile(file, "utf8")).trim();
  if (!value) throw new Error(`${name} must name a nonempty secret`);
  return value;
}

export async function startMetering() {
  const databaseUrl = await secretFile("DATABASE_URL_FILE");
  const token = await secretFile("PI_CLOUD_METERING_TOKEN_FILE");
  const database = createDatabase({
    connectionString: databaseUrl,
    maxConnections: 4,
    checkoutTimeoutMs: 10_000,
  });
  const application = createMeteringApplication(database, token);
  const sourceUrl = process.env.PI_CLOUD_SANDBOX_LIFECYCLE_URL;
  const collector =
    sourceUrl && process.env.PI_CLOUD_CUBE_LIFECYCLE_REDIS_URL
      ? new LifecycleCollector(
          database,
          new CubeLifecycleSource({
            id: `cubesandbox:${process.env.PI_CLOUD_SANDBOX_DOMAIN_ID ?? "sandbox-domain-0001"}`,
            database,
            ...(process.env.PI_CLOUD_CUBE_LIFECYCLE_REDIS_PASSWORD_FILE
              ? {
                  lifecycleRedisPassword: await secretFile(
                    "PI_CLOUD_CUBE_LIFECYCLE_REDIS_PASSWORD_FILE",
                  ),
                }
              : {}),
            ...(process.env.PI_CLOUD_CUBE_LIFECYCLE_REDIS_URL
              ? { lifecycleRedisUrl: process.env.PI_CLOUD_CUBE_LIFECYCLE_REDIS_URL }
              : {}),
            url: sourceUrl,
            apiKey: await secretFile("PI_CLOUD_CUBESANDBOX_API_KEY_FILE"),
          }),
        )
      : undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await collector?.close();
      await application.close();
      await database.destroy();
    })());
  const onSignal = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    await application.listen({ host: process.env.HOST ?? "0.0.0.0", port: 3000 });
    collector?.start();
  } catch (error) {
    await close();
    throw error;
  }
  return { application, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMetering().catch(() => {
    // Driver/config errors may contain credentials. Keep the startup log bounded.
    process.stderr.write(
      "Metering startup failed; check configuration and PostgreSQL availability\n",
    );
    process.exitCode = 1;
  });
}
