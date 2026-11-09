import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { SandboxAssignmentInventory } from "@pi-cloud/protocol";
import { installBinaryBodyParser } from "./binary-body-parser.ts";
import { AssignmentReconciler } from "./assignment-reconciler.ts";
import {
  SupervisorConnectionManager,
  type SupervisorBootIdentity,
  type SupervisorOwnerBoundary,
} from "./supervisor-connection-manager.ts";
import {
  SupervisorWebSocketGateway,
  type SupervisorUpgradeAuthorizer,
  type SupervisorWebSocketGatewayOptions,
} from "./supervisor-websocket-gateway.ts";
import {
  SupervisorMaintenanceRuntime,
  type SupervisorMaintenanceRuntimeOptions,
} from "./supervisor-maintenance-runtime.ts";

/** Worker control and private execution ports have no public API controllers. */
export class SupervisorControlRuntime {
  readonly server: FastifyInstance;
  readonly connectionManager: SupervisorConnectionManager;
  readonly gateway: SupervisorWebSocketGateway;
  readonly maintenance: SupervisorMaintenanceRuntime;
  state: "ready" | "running" | "closing" | "closed" = "ready";
  #closing: Promise<void> | undefined;
  constructor(options: {
    database: Kysely<Database>;
    maintenanceDatabase: Kysely<Database>;
    instanceId: string;
    authorizer: SupervisorUpgradeAuthorizer;
    ownerBoundary: SupervisorOwnerBoundary;
    inventory: (identity: SupervisorBootIdentity) => SandboxAssignmentInventory;
    gateway?: Omit<SupervisorWebSocketGatewayOptions, "manager" | "authorizer">;
    maintenance?: Omit<SupervisorMaintenanceRuntimeOptions, "maintenanceRunner">;
  }) {
    this.server = Fastify({ logger: false });
    installBinaryBodyParser(this.server);
    this.connectionManager = new SupervisorConnectionManager({
      database: options.database,
      maintenanceDatabase: options.maintenanceDatabase,
      controlPlaneInstanceId: options.instanceId,
      ownerBoundary: options.ownerBoundary,
      assignmentRetirerFactory: (identity) =>
        new AssignmentReconciler({
          database: options.database,
          workerId: identity.sandboxId,
          inventory: options.inventory(identity),
        }),
    });
    this.gateway = new SupervisorWebSocketGateway({
      ...options.gateway,
      manager: this.connectionManager,
      authorizer: options.authorizer,
    });
    this.maintenance = new SupervisorMaintenanceRuntime({
      ...options.maintenance,
      maintenanceRunner: this.connectionManager,
    });
    this.gateway.install(this.server);
  }
  async listen(port: number, host: string): Promise<void> {
    if (this.state !== "ready") throw new Error("Execution control can only listen once");
    await this.server.listen({ port, host });
    this.maintenance.start();
    this.state = "running";
  }
  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }
  async #close(): Promise<void> {
    this.state = "closing";
    this.maintenance.beginDrain();
    this.gateway.shutdown();
    try {
      await this.maintenance.stop();
    } finally {
      await this.server.close();
      this.state = "closed";
    }
  }
}
