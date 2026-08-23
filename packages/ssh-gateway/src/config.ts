import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type SshGatewayConfig = Readonly<{
  databaseUrl: string;
  terminalToken: string;
  hostKey: Buffer;
  host: string;
  port: number;
  allowInsecureInternalHttp: boolean;
}>;

async function privateFile(path: string | undefined, label: string): Promise<Buffer> {
  if (path === undefined || !path.startsWith("/")) throw new TypeError(`${label} file is missing`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 64 * 1_024) {
      throw new TypeError(`${label} file is invalid`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "2222");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("SSH gateway port is invalid");
  }
  return parsed;
}

export async function loadSshGatewayConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SshGatewayConfig> {
  return {
    databaseUrl: (await privateFile(environment.DATABASE_URL_FILE, "Database URL"))
      .toString("utf8")
      .trim(),
    terminalToken: (
      await privateFile(
        environment.PI_CLOUD_WORKSPACE_TERMINAL_TOKEN_FILE,
        "Workspace terminal token",
      )
    )
      .toString("utf8")
      .trim(),
    hostKey: await privateFile(environment.PI_CLOUD_SSH_HOST_KEY_FILE, "SSH host key"),
    host: environment.HOST?.trim() || "0.0.0.0",
    port: port(environment.PORT),
    allowInsecureInternalHttp:
      environment.PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP?.toLowerCase() === "true",
  };
}
