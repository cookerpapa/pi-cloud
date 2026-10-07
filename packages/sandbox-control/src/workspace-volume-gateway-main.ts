import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  PersistentVolumeWorkspaceVolumeGateway,
  WorkspaceVolumeGatewayServer,
} from "./workspace-volume-gateway.ts";
import { Pool } from "pg";
import { operationalLog, startServiceObservability } from "@pi-cloud/observability";
import { FilesystemWorkspaceVolumeGatewayLock } from "./filesystem-workspace-volume-gateway-lock.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length < 1) throw new TypeError(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

async function secret(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new TypeError("Secret path is invalid");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o137) !== 0 ||
      ((metadata.mode & 0o040) !== 0 &&
        ![process.getegid?.(), ...(process.getgroups?.() ?? [])].includes(metadata.gid)) ||
      metadata.size > 8_192
    ) {
      throw new TypeError("Secret file is invalid");
    }
    return (await handle.readFile("utf8")).replace(/\r?\n$/, "");
  } finally {
    await handle.close();
  }
}

const database = new Pool({
  connectionString: await secret(required("DATABASE_URL_FILE")),
  max: 4,
});
database.on("error", () =>
  operationalLog({
    service: "pi-cloud-workspace-volume-gateway",
    level: "error",
    event: "volume.database_connection.failed",
  }),
);
const observability = await startServiceObservability({
  serviceName: "pi-cloud-workspace-volume-gateway",
  defaultMetricsPort: 9_469,
});
const gateway = new PersistentVolumeWorkspaceVolumeGateway({
  workspaceRoot: required("PI_CLOUD_WORKSPACE_POSIX_ROOT"),
  lock: new FilesystemWorkspaceVolumeGatewayLock(required("PI_CLOUD_WORKSPACE_POSIX_ROOT")),
  authorizeUpload: async (input, byteLength) => {
    const result = await database.query(
      `select u.id from session_uploads u
      join sessions s on s.id=u.session_id and s.tenant_id=u.tenant_id
      join workspaces w on w.id=u.workspace_id and w.tenant_id=u.tenant_id
      where u.id=$1::uuid and u.claim_token=$2::uuid and u.tenant_id=$3::uuid
        and u.workspace_id=$4::uuid and u.session_id=$5::uuid and u.sha256=$6
        and u.name=$7 and u.byte_length=$8 and u.state='uploading'
        and u.lease_expires_at>clock_timestamp() and s.pruned_at is null
        and s.workspace_id=u.workspace_id and s.working_directory=u.working_directory
        and u.working_directory=$9 and w.deleted_at is null and w.workspace_kind='user'`,
      [
        input.uploadId,
        input.claimToken,
        input.tenantId,
        input.workspaceId,
        input.sessionId,
        input.sha256,
        input.name,
        byteLength,
        input.rootPath ? `/workspace/${input.rootPath}` : "/workspace",
      ],
    );
    if (result.rowCount !== 1) throw new Error("Workspace upload grant is no longer current");
  },
});
const server = new WorkspaceVolumeGatewayServer({
  host: process.env.PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_HOST ?? "127.0.0.1",
  port: integer("PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_PORT", 4_500, 1, 65_535),
  serviceToken: await secret(required("PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE")),
  gateway,
  maximumConcurrentOperations: integer(
    "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_CONCURRENT_OPERATIONS",
    2,
    1,
    64,
  ),
  maximumQueuedOperations: integer(
    "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_QUEUED_OPERATIONS",
    32,
    0,
    4_096,
  ),
  queueWaitTimeoutMs: integer(
    "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS",
    30_000,
    1,
    600_000,
  ),
  metrics: observability.metrics,
});
try {
  await server.listen();
  gateway.startUploadMaintenance(() =>
    operationalLog({
      service: "pi-cloud-workspace-volume-gateway",
      level: "warn",
      event: "upload.staging.cleanup_deferred",
    }),
  );
} catch (error: unknown) {
  await Promise.allSettled([server.close(), observability.close(), database.end()]);
  throw error;
}
process.stdout.write("PiCloud Workspace Volume Gateway ready\n");

let closing: Promise<void> | undefined;
const closeService = (): Promise<void> =>
  (closing ??= server
    .close()
    .finally(() => Promise.allSettled([observability.close(), database.end()]))
    .then(() => undefined));
process.once("SIGTERM", () => void closeService());
process.once("SIGINT", () => void closeService());
