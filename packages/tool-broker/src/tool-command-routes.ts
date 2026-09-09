import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import type { ToolLogFact } from "./tool-command-executor.ts";

export type ToolCommandRoute = Readonly<{
  bindingId: string;
  instanceId: string;
  baseUrl: string;
}>;
export interface ToolCommandRoutes {
  find(scope: ToolLogFact["scope"], wholeWriter: boolean): Promise<readonly ToolCommandRoute[]>;
  isAlive(instanceId: string): Promise<boolean>;
}

/** Immutable route metadata only. Execution authority remains in Broker admission. */
export class PostgresToolCommandRoutes implements ToolCommandRoutes {
  constructor(
    readonly database: Kysely<Database>,
    readonly sandboxDomainId: string,
  ) {}

  async find(
    scope: ToolLogFact["scope"],
    wholeWriter: boolean,
  ): Promise<readonly ToolCommandRoute[]> {
    let query = this.database
      .selectFrom("tool_broker_binding_routes as route")
      .innerJoin("tool_broker_instances as owner", "owner.instance_id", "route.owner_instance_id")
      .innerJoin("run_attempts as attempt", "attempt.id", "route.attempt_id")
      .select([
        "route.binding_id as bindingId",
        "owner.instance_id as instanceId",
        "owner.owner_base_url as baseUrl",
      ])
      .where("route.tenant_id", "=", scope.tenantId!)
      .where("owner.sandbox_domain_id", "=", this.sandboxDomainId);
    query = wholeWriter
      ? query.where("attempt.native_writer_id", "=", scope.writerId)
      : query.where("route.attempt_id", "=", scope.attemptId);
    return query.execute();
  }

  async isAlive(instanceId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom("tool_broker_instances")
      .select("instance_id")
      .where("instance_id", "=", instanceId)
      .where("sandbox_domain_id", "=", this.sandboxDomainId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return row !== undefined;
  }
}
