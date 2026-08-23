import { createDatabase, type Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { pathToFileURL } from "node:url";
import {
  loadProductionDatabaseUrl,
  type ProductionControlPlaneEnvironment,
} from "./production-config.ts";

export type RegisteredPlatformAdministrator = Readonly<{
  username: string;
  tenantId: string;
  userId: string;
}>;

export async function resolveRegisteredPlatformAdministrator(
  database: Kysely<Database>,
  rawUsername: string,
): Promise<RegisteredPlatformAdministrator> {
  const username = rawUsername.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,47}$/u.test(username)) {
    throw new TypeError("Platform administrator username is invalid");
  }
  const account = await database
    .selectFrom("user_password_credentials")
    .select(["username", "tenant_id as tenantId", "user_id as userId"])
    .where("username", "=", username)
    .executeTakeFirst();
  if (account === undefined) {
    throw new TypeError("Registered platform administrator account was not found");
  }
  return account;
}

function usernameArgument(values: readonly string[]): string {
  if (values.length !== 3 || values[0] !== "resolve" || values[1] !== "--username") {
    throw new TypeError("Usage: platform-administrator resolve --username <registered-username>");
  }
  return values[2]!;
}

export async function runPlatformAdministratorResolver(
  values: readonly string[],
  environment: ProductionControlPlaneEnvironment = process.env,
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): Promise<void> {
  const database = createDatabase({
    connectionString: await loadProductionDatabaseUrl(environment),
    maxConnections: 1,
  });
  try {
    const account = await resolveRegisteredPlatformAdministrator(
      database,
      usernameArgument(values),
    );
    output.write(`${JSON.stringify(account)}\n`);
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runPlatformAdministratorResolver(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Platform administrator lookup failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
