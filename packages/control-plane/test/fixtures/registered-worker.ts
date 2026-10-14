import type { Database } from "@pi-cloud/database";
import { PINNED_PI_DURABLE_VERSION } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import { SupervisorConnectionManager } from "../../src/supervisor-connection-manager.ts";

/** Explicit provisioned identity: production registration never bypasses PG authorization. */
export async function authorizeTestWorker(database: Kysely<Database>, workerId: string) {
  const worker = await database
    .selectFrom("workers")
    .selectAll()
    .where("id", "=", workerId)
    .executeTakeFirstOrThrow();
  await database
    .insertInto("supervisor_hosts")
    .values({
      supervisor_id: worker.supervisor_id,
      maximum_capacity: worker.max_concurrent_sessions,
      management_base_url: `http://${worker.supervisor_id}:4100/`,
      created_at: sql<Date>`clock_timestamp()`,
      updated_at: sql<Date>`clock_timestamp()`,
    })
    .onConflict((c) => c.column("supervisor_id").doNothing())
    .execute();
  await database
    .insertInto("supervisor_boot_credentials")
    .values({
      credential_id: crypto.randomUUID(),
      credential_sha256:
        crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
      provision_request_id: crypto.randomUUID(),
      worker_id: worker.id,
      supervisor_id: worker.supervisor_id,
      boot_id: worker.boot_id,
      created_at: sql<Date>`clock_timestamp()`,
      expires_at: sql<Date>`clock_timestamp() + interval '1 hour'`,
      revoked_at: null,
    })
    .onConflict((c) => c.column("worker_id").doNothing())
    .execute();
  return worker;
}

/** Queue fixtures have a real persisted registration, even when their Agent backend is fake. */
export async function registerTestWorker(database: Kysely<Database>, workerId: string) {
  const worker = await authorizeTestWorker(database, workerId);
  const manager = new SupervisorConnectionManager({
    database,
    controlPlaneInstanceId: crypto.randomUUID(),
    ownerBoundary: {
      async stopAndConfirm() {
        throw new Error("Unexpected fixture retirement");
      },
    },
    assignmentRetirerFactory() {
      throw new Error("Unexpected fixture retirement");
    },
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 3_600_000,
    leaseDurationMs: 3_600_000,
  });
  const authority = {
    supervisorId: worker.supervisor_id,
    sandboxId: worker.id,
    bootId: worker.boot_id,
    transportId: crypto.randomUUID(),
  };
  const message = {
    protocolVersion: 1,
    type: "supervisor.register",
    messageId: crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    payload: {
      supervisorId: worker.supervisor_id,
      sandboxId: worker.id,
      bootId: worker.boot_id,
      supervisorVersion: "0.1.0",
      pi: { packageName: "@earendil-works/pi-durable", version: PINNED_PI_DURABLE_VERSION },
      supportedProtocolVersions: [1],
      capabilities: ["pi.sdk"],
      acceptingAssignments: false,
      maxConcurrentSessions: worker.max_concurrent_sessions,
    },
  };
  const registration = await manager.register(message, authority);
  return { manager, authority, message, registration };
}
