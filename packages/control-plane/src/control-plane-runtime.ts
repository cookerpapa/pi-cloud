import type { Database } from "@pi-cloud/database";
import type { SandboxAssignmentInventory } from "@pi-cloud/sandbox-supervisor/sandbox-assignment-inventory";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Kysely } from "kysely";

import {
  createControlPlaneApplication,
  type ControlPlaneApplicationOptions,
} from "./application.ts";
import { AssignmentReconciler } from "./assignment-reconciler.ts";
import type { LiveSessionTailSource } from "@pi-cloud/runtime-core/session-event-stream";
import {
  SupervisorMaintenanceRuntime,
  type SupervisorMaintenanceRuntimeOptions,
} from "./supervisor-maintenance-runtime.ts";
import { SessionEventHub } from "@pi-cloud/runtime-core/session-event-hub";
import {
  SupervisorConnectionManager,
  type SupervisorBootIdentity,
  type SupervisorConnectionManagerOptions,
  type SupervisorOwnerBoundary,
} from "./supervisor-connection-manager.ts";
import {
  SupervisorWebSocketGateway,
  type SupervisorUpgradeAuthorizer,
  type SupervisorWebSocketGatewayOptions,
} from "./supervisor-websocket-gateway.ts";
import type { SupervisorProvisioningGateway } from "./supervisor-boot-provisioner.ts";
import type { ProductionHttpGateway } from "./production-http-gateway.ts";

type ConnectionManagerConfiguration = Omit<
  SupervisorConnectionManagerOptions,
  "database" | "controlPlaneInstanceId" | "ownerBoundary" | "assignmentRetirerFactory"
>;

type GatewayConfiguration = Omit<SupervisorWebSocketGatewayOptions, "manager" | "authorizer">;

type MaintenanceConfiguration = Omit<SupervisorMaintenanceRuntimeOptions, "maintenanceRunner">;

export type ControlPlaneRuntimeOptions = Omit<
  ControlPlaneApplicationOptions,
  "supervisorWebSocketGateway" | "eventRuntime"
> & {
  database: Kysely<Database>;
  controlPlaneInstanceId: string;
  supervisorAuthorizer: SupervisorUpgradeAuthorizer;
  supervisorOwnerBoundary: SupervisorOwnerBoundary;
  assignmentInventoryFactory: (identity: SupervisorBootIdentity) => SandboxAssignmentInventory;
  supervisorProvisioningGateway?: SupervisorProvisioningGateway;
  productionHttpGateway?: ProductionHttpGateway;
  eventRuntime: ControlPlaneApplicationOptions["eventRuntime"];
  connectionManager?: ConnectionManagerConfiguration;
  gateway?: GatewayConfiguration;
  maintenance?: MaintenanceConfiguration;
};

export type ControlPlaneRuntimeState = "ready" | "running" | "closing" | "closed";

export class ControlPlaneRuntime {
  readonly application: NestFastifyApplication;
  readonly eventHub: SessionEventHub;
  readonly eventStore: LiveSessionTailSource;
  readonly connectionManager: SupervisorConnectionManager;
  readonly gateway: SupervisorWebSocketGateway;
  readonly maintenance: SupervisorMaintenanceRuntime;
  #state: ControlPlaneRuntimeState = "ready";
  #closing: Promise<void> | undefined;

  constructor(options: {
    application: NestFastifyApplication;
    eventHub: SessionEventHub;
    eventStore: LiveSessionTailSource;
    connectionManager: SupervisorConnectionManager;
    gateway: SupervisorWebSocketGateway;
    maintenance: SupervisorMaintenanceRuntime;
  }) {
    this.application = options.application;
    this.eventHub = options.eventHub;
    this.eventStore = options.eventStore;
    this.connectionManager = options.connectionManager;
    this.gateway = options.gateway;
    this.maintenance = options.maintenance;
  }

  get state(): ControlPlaneRuntimeState {
    return this.#state;
  }

  async listen(port: number, host: string): Promise<string> {
    if (this.#state !== "ready") {
      throw new Error("Remote control-plane runtime can only listen once");
    }
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new TypeError("runtime port must be an integer between 0 and 65535");
    }
    if (host.trim().length === 0) throw new TypeError("runtime host must not be empty");
    try {
      await this.application.listen(port, host);
      this.maintenance.start();
      this.#state = "running";
      return this.application.getUrl();
    } catch (error: unknown) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    this.maintenance.beginDrain();
    this.gateway.shutdown();
    try {
      await this.maintenance.stop();
    } finally {
      try {
        await this.application.close();
      } finally {
        this.#state = "closed";
      }
    }
  }
}

export async function createControlPlaneRuntime(
  options: ControlPlaneRuntimeOptions,
): Promise<ControlPlaneRuntime> {
  const {
    controlPlaneInstanceId,
    supervisorAuthorizer,
    supervisorOwnerBoundary,
    assignmentInventoryFactory,
    connectionManager: connectionOptions,
    gateway: gatewayOptions,
    maintenance: maintenanceOptions,
    ...applicationOptions
  } = options;
  const { eventHub, eventStore } = applicationOptions.eventRuntime;
  const connectionManager = new SupervisorConnectionManager({
    ...connectionOptions,
    database: options.database,
    controlPlaneInstanceId,
    ownerBoundary: supervisorOwnerBoundary,
    assignmentRetirerFactory: (identity) =>
      new AssignmentReconciler({
        database: options.database,
        sandboxId: identity.sandboxId,
        inventory: assignmentInventoryFactory(identity),
      }),
  });
  const gateway = new SupervisorWebSocketGateway({
    ...gatewayOptions,
    manager: connectionManager,
    authorizer: supervisorAuthorizer,
  });
  const maintenance = new SupervisorMaintenanceRuntime({
    ...maintenanceOptions,
    maintenanceRunner: connectionManager,
  });

  let application: NestFastifyApplication | undefined;
  try {
    application = await createControlPlaneApplication({
      // Application options cross this boundary unchanged: selecting them by
      // hand previously dropped the non-local Steer transport and metrics.
      ...applicationOptions,
      supervisorWebSocketGateway: gateway,
    });
  } catch (error: unknown) {
    gateway.shutdown();
    throw error;
  }
  return new ControlPlaneRuntime({
    application,
    eventHub,
    eventStore,
    connectionManager,
    gateway,
    maintenance,
  });
}
