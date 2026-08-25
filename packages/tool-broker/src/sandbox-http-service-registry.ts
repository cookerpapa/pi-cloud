import type { Database } from "@pi-cloud/database";
import type { SandboxHttpServiceDiscovery } from "./sandbox-provider.ts";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";

export type SandboxHttpServiceTarget = Readonly<
  | {
      kind: "conversation";
      targetId: string;
      tenantId: string;
      workspaceId: string;
      sessionId: string;
    }
  | {
      kind: "development_environment";
      targetId: string;
      tenantId: string;
      workspaceId: string;
      sessionId: string;
      developmentEnvironmentId: string;
    }
>;

export type SandboxHttpServiceObservation = Readonly<{
  target: SandboxHttpServiceTarget;
  runtimeId: string;
  activationId: string;
  operationId: string;
  listeningPorts: SandboxHttpServiceDiscovery["listeningPorts"];
  httpServices: SandboxHttpServiceDiscovery["httpServices"];
}>;

export interface SandboxHttpServiceRegistry {
  observe(input: SandboxHttpServiceObservation): Promise<void>;
  end(target: SandboxHttpServiceTarget, runtimeId: string): Promise<void>;
}

export class PostgresSandboxHttpServiceRegistry implements SandboxHttpServiceRegistry {
  readonly #database: Kysely<Database>;
  readonly #clock: () => Date;

  constructor(options: { database: Kysely<Database>; clock?: () => Date }) {
    this.#database = options.database;
    this.#clock = options.clock ?? (() => new Date());
  }

  async observe(input: SandboxHttpServiceObservation): Promise<void> {
    const now = this.#clock();
    const listeningPorts = [...new Set(input.listeningPorts)].sort((left, right) => left - right);
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("sandbox_http_services")
        .set({ state: "ended", ended_at: now, last_seen_at: now })
        .where("tenant_id", "=", input.target.tenantId)
        .where("target_kind", "=", input.target.kind)
        .where("target_id", "=", input.target.targetId)
        .where("state", "=", "active")
        .where("runtime_id", "!=", input.runtimeId)
        .execute();

      let missing = transaction
        .updateTable("sandbox_http_services")
        .set({ state: "ended", ended_at: now, last_seen_at: now })
        .where("tenant_id", "=", input.target.tenantId)
        .where("target_kind", "=", input.target.kind)
        .where("target_id", "=", input.target.targetId)
        .where("runtime_id", "=", input.runtimeId)
        .where("state", "=", "active");
      if (listeningPorts.length > 0) missing = missing.where("port", "not in", listeningPorts);
      await missing.execute();

      for (const service of input.httpServices) {
        await transaction
          .insertInto("sandbox_http_services")
          .values({
            id: randomUUID(),
            tenant_id: input.target.tenantId,
            target_kind: input.target.kind,
            target_id: input.target.targetId,
            workspace_id: input.target.workspaceId,
            session_id: input.target.sessionId,
            development_environment_id:
              input.target.kind === "development_environment"
                ? input.target.developmentEnvironmentId
                : null,
            runtime_id: input.runtimeId,
            activation_id: input.activationId,
            last_operation_id: input.operationId,
            port: service.port,
            protocol: service.protocol,
            state: "active",
            first_seen_at: now,
            last_seen_at: now,
            ended_at: null,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["tenant_id", "target_kind", "target_id", "runtime_id", "port"])
              .doUpdateSet({
                workspace_id: input.target.workspaceId,
                session_id: input.target.sessionId,
                development_environment_id:
                  input.target.kind === "development_environment"
                    ? input.target.developmentEnvironmentId
                    : null,
                activation_id: input.activationId,
                last_operation_id: input.operationId,
                protocol: service.protocol,
                state: "active",
                last_seen_at: now,
                ended_at: null,
              }),
          )
          .executeTakeFirstOrThrow();
      }
    });
  }

  async end(target: SandboxHttpServiceTarget, runtimeId: string): Promise<void> {
    const now = this.#clock();
    await this.#database
      .updateTable("sandbox_http_services")
      .set({ state: "ended", ended_at: now, last_seen_at: now })
      .where("tenant_id", "=", target.tenantId)
      .where("target_kind", "=", target.kind)
      .where("target_id", "=", target.targetId)
      .where("runtime_id", "=", runtimeId)
      .where("state", "=", "active")
      .execute();
  }
}
