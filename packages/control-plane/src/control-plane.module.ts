import { Module, type DynamicModule } from "@nestjs/common";
import { ControlPlaneController } from "./control-plane.controller.ts";
import type { ControlPlaneStoreOptions } from "./control-plane-store.ts";
import { ControlPlaneStoreFactory } from "./control-plane-store-factory.ts";
import { DurableEventStore } from "@pi-cloud/runtime-core/durable-event-store";
import {
  PublicTenantRegistrationService,
  type PublicTenantRegistrationConfiguration,
} from "./public-tenant-registration.ts";
import { SessionEventHub } from "@pi-cloud/runtime-core/session-event-hub";
import {
  SessionEventStream,
  type LiveSessionTailSource,
  type SessionEventStreamOptions,
} from "@pi-cloud/runtime-core/session-event-stream";
import type { TenantRequestIdentity } from "./tenant-identity.ts";
import { TenantRequestContext } from "./tenant-request-context.ts";
import type { TenantModelCredentialVault } from "@pi-cloud/runtime-core/model-credential-runtime";
import { TenantModelConfigurationService } from "./tenant-model-configuration.ts";
import {
  WorkspaceVersionService,
  type TrustedArtifactReader,
  type TrustedProviderSnapshotReader,
} from "./workspace-version-service.ts";
import { WebAuthenticationService } from "./web-authentication.ts";
import { PlatformRuntimeSettingsService } from "./platform-runtime-settings.ts";
import type { SupervisorWebSocketGateway } from "./supervisor-websocket-gateway.ts";
import { TurnSteeringService } from "./turn-steering-service.ts";
import type { TurnSteerBackend } from "./turn-steer.ts";
import { ConversationTreeService } from "./conversation-tree-service.ts";
import { DevelopmentEnvironmentService } from "./development-environment-service.ts";
import { SshAccessTicketService } from "./ssh-access-ticket-service.ts";
import { SandboxHttpServiceService } from "./sandbox-http-service-service.ts";
import type { TerminalTurnProjectionSource } from "@pi-cloud/runtime-core/terminal-turn-projection";

export type ControlPlaneModuleOptions = Omit<
  ControlPlaneStoreOptions,
  "tenantId" | "defaultModelProfileId"
> & {
  sessionEventStreamOptions?: SessionEventStreamOptions;
  eventRuntime?: ControlPlaneEventRuntime;
  staticRequestIdentity?: TenantRequestIdentity;
  publicRegistration?: PublicTenantRegistrationConfiguration;
  modelCredentialVault?: TenantModelCredentialVault;
  artifactReader?: TrustedArtifactReader;
  providerSnapshotReader?: TrustedProviderSnapshotReader;
  webAuthentication?: WebAuthenticationService;
  platformOperatorTenantId?: string;
  platformModelSourceTenantId?: string;
  cubeEgressConfigToken?: string;
  supervisorWebSocketGateway?: SupervisorWebSocketGateway;
  turnSteerBackendFactory?: (sandboxId: string) => Promise<TurnSteerBackend>;
  developmentEnvironmentService?: DevelopmentEnvironmentService;
  sshAccessTicketService?: SshAccessTicketService;
};

export type ControlPlaneEventRuntime = {
  eventHub: SessionEventHub;
  eventStore: LiveSessionTailSource;
  terminalTurnProjectionSource?: TerminalTurnProjectionSource;
};

@Module({})
export class ControlPlaneModule {
  static register(options: ControlPlaneModuleOptions): DynamicModule {
    const eventHub = options.eventRuntime?.eventHub ?? new SessionEventHub();
    const eventStore = options.eventRuntime?.eventStore ?? new DurableEventStore();
    const workspaceVersions = new WorkspaceVersionService({
      database: options.database,
      ...(options.artifactReader === undefined ? {} : { artifactReader: options.artifactReader }),
      ...(options.providerSnapshotReader === undefined
        ? {}
        : { providerSnapshotReader: options.providerSnapshotReader }),
      ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
    const controlPlaneStores = new ControlPlaneStoreFactory({
      database: options.database,
      ...(options.environmentImageRevision === undefined
        ? {}
        : { environmentImageRevision: options.environmentImageRevision }),
      ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
    });
    return {
      module: ControlPlaneModule,
      controllers: [ControlPlaneController],
      providers: [
        {
          provide: ControlPlaneStoreFactory,
          useValue: controlPlaneStores,
        },
        {
          provide: PublicTenantRegistrationService,
          useValue: new PublicTenantRegistrationService({
            database: options.database,
            ...(options.publicRegistration ?? {
              enabled: false,
              maximumTenants: 2,
              tenantQuotas: {
                maximumProjects: 10,
                maximumSessions: 100,
                maximumUnsettledTurns: 10,
                maximumConcurrentTurns: 1,
                maximumActiveSandboxes: 16,
              },
              ...(options.platformOperatorTenantId === undefined
                ? {}
                : { platformOperatorTenantId: options.platformOperatorTenantId }),
            }),
          }),
        },
        {
          provide: WebAuthenticationService,
          useValue:
            options.webAuthentication ??
            new WebAuthenticationService({
              database: options.database,
              enabled: false,
              maximumTenants: 2,
              tenantQuotas: {
                maximumProjects: 10,
                maximumSessions: 100,
                maximumUnsettledTurns: 10,
                maximumConcurrentTurns: 1,
                maximumActiveSandboxes: 16,
              },
            }),
        },
        {
          provide: TenantRequestContext,
          useValue: new TenantRequestContext(options.staticRequestIdentity),
        },
        {
          provide: TenantModelConfigurationService,
          useValue: new TenantModelConfigurationService({
            database: options.database,
            ...(options.modelCredentialVault === undefined
              ? {}
              : { vault: options.modelCredentialVault }),
            ...(options.platformOperatorTenantId === undefined
              ? {}
              : { platformOperatorTenantId: options.platformOperatorTenantId }),
            ...(options.platformModelSourceTenantId === undefined
              ? {}
              : { platformModelSourceTenantId: options.platformModelSourceTenantId }),
          }),
        },
        {
          provide: PlatformRuntimeSettingsService,
          useValue: new PlatformRuntimeSettingsService({
            database: options.database,
            ...(options.platformOperatorTenantId === undefined
              ? {}
              : { platformOperatorTenantId: options.platformOperatorTenantId }),
            ...(options.cubeEgressConfigToken === undefined
              ? {}
              : { internalServiceToken: options.cubeEgressConfigToken }),
            ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
          }),
        },
        {
          provide: TurnSteeringService,
          useValue: new TurnSteeringService({
            database: options.database,
            ...(options.supervisorWebSocketGateway === undefined
              ? {}
              : { gateway: options.supervisorWebSocketGateway }),
            ...(options.turnSteerBackendFactory === undefined
              ? {}
              : { backendFactory: options.turnSteerBackendFactory }),
            ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
          }),
        },
        {
          provide: ConversationTreeService,
          useValue: new ConversationTreeService({
            database: options.database,
            ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
          }),
        },
        {
          provide: DevelopmentEnvironmentService,
          useValue:
            options.developmentEnvironmentService ??
            new DevelopmentEnvironmentService({
              database: options.database,
              terminalToken: "development-environment-disabled-token-000000000000000000000000",
              allowInsecureInternalHttp: false,
              ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
            }),
        },
        {
          provide: SshAccessTicketService,
          useValue:
            options.sshAccessTicketService ??
            new SshAccessTicketService({ database: options.database, enabled: false }),
        },
        {
          provide: SandboxHttpServiceService,
          useValue: new SandboxHttpServiceService({ database: options.database }),
        },
        {
          provide: WorkspaceVersionService,
          useValue: workspaceVersions,
        },
        { provide: SessionEventHub, useValue: eventHub },
        { provide: DurableEventStore, useValue: eventStore },
        {
          provide: SessionEventStream,
          useValue: new SessionEventStream(eventStore, eventHub, options.sessionEventStreamOptions),
        },
      ],
      exports: [DurableEventStore, SessionEventHub, SessionEventStream, WorkspaceVersionService],
    };
  }
}
