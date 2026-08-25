import type { Database } from "@pi-cloud/database";
import type { SandboxHttpServiceListResource } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import type { TenantRequestIdentity } from "./tenant-identity.ts";
import { ControlPlaneStoreError } from "./control-plane-store.ts";

export class SandboxHttpServiceService {
  readonly #database: Kysely<Database>;

  constructor(options: { database: Kysely<Database> }) {
    this.#database = options.database;
  }

  async forConversation(
    identity: TenantRequestIdentity,
    sessionId: string,
  ): Promise<SandboxHttpServiceListResource> {
    const session = await this.#database
      .selectFrom("sessions")
      .select("development_environment_id")
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (session === undefined) {
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    }
    const targetKind =
      session.development_environment_id === null ? "conversation" : "development_environment";
    const targetId = session.development_environment_id ?? sessionId;
    const rows = await this.#database
      .selectFrom("sandbox_http_services as service")
      .leftJoin("development_environments as environment", (join) =>
        join
          .onRef("environment.tenant_id", "=", "service.tenant_id")
          .onRef("environment.id", "=", "service.development_environment_id"),
      )
      .select([
        "service.id",
        "service.port",
        "service.protocol",
        "service.first_seen_at",
        "service.last_seen_at",
      ])
      .where("service.tenant_id", "=", identity.tenantId)
      .where("service.target_kind", "=", targetKind)
      .where("service.target_id", "=", targetId)
      .where("service.state", "=", "active")
      .where((expression) =>
        targetKind === "conversation"
          ? expression.val(true)
          : expression.and([
              expression("environment.owner_user_id", "=", identity.userId),
              expression("environment.state", "=", "running"),
            ]),
      )
      .orderBy("service.port", "asc")
      .limit(65)
      .execute();
    return this.#resource(
      rows,
      (port) => `/v1/conversations/${encodeURIComponent(sessionId)}/preview/${String(port)}/`,
    );
  }

  async forDevelopmentEnvironment(
    identity: TenantRequestIdentity,
    environmentId: string,
  ): Promise<SandboxHttpServiceListResource> {
    const environment = await this.#database
      .selectFrom("development_environments")
      .select("id")
      .where("tenant_id", "=", identity.tenantId)
      .where("owner_user_id", "=", identity.userId)
      .where("id", "=", environmentId)
      .executeTakeFirst();
    if (environment === undefined) {
      throw new ControlPlaneStoreError("not_found", "Development environment was not found");
    }
    const rows = await this.#database
      .selectFrom("sandbox_http_services")
      .select(["id", "port", "protocol", "first_seen_at", "last_seen_at"])
      .where("tenant_id", "=", identity.tenantId)
      .where("target_kind", "=", "development_environment")
      .where("target_id", "=", environmentId)
      .where("state", "=", "active")
      .orderBy("port", "asc")
      .limit(65)
      .execute();
    return this.#resource(
      rows,
      (port) =>
        `/v1/development-environments/${encodeURIComponent(environmentId)}/preview/${String(port)}/`,
    );
  }

  #resource(
    rows: ReadonlyArray<{
      id: string;
      port: number;
      protocol: "http";
      first_seen_at: Date;
      last_seen_at: Date;
    }>,
    previewPath: (port: number) => string,
  ): SandboxHttpServiceListResource {
    return {
      services: rows.slice(0, 64).map((row) => ({
        serviceId: row.id,
        port: row.port,
        protocol: row.protocol,
        previewPath: previewPath(row.port),
        firstSeenAt: row.first_seen_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
      })),
      truncated: rows.length > 64,
    };
  }
}
