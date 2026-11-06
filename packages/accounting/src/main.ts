import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createDatabase } from "@pi-cloud/database";
import { createMeteringApplication } from "./http.ts";

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
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= application.close().finally(() => database.destroy()));
  const onSignal = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    await application.listen({ host: process.env.HOST ?? "0.0.0.0", port: 3000 });
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
