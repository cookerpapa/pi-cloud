import { createDatabase } from "@pi-cloud/database";
import { operationalLog, startServiceObservability } from "@pi-cloud/observability";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import {
  HttpSupervisorManagementClient,
  HttpSupervisorSteerBackend,
  RoutedHttpSandboxAssignmentInventory,
  RoutedHttpSupervisorOwnerBoundary,
} from "./http-supervisor-management.ts";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { PostgresRuntimeObjectStore } from "@pi-cloud/runtime-core/postgres-runtime-object-store";
import { KafkaEventRuntime } from "@pi-cloud/runtime-core/kafka-event-runtime";
import {
  PostgresSupervisorCredentialAuthorizer,
  SupervisorBootProvisioner,
  SupervisorProvisioningGateway,
} from "./supervisor-boot-provisioner.ts";
import { loadProductionControlPlaneConfig } from "./production-config.ts";
import { ProductionHttpGateway } from "./production-http-gateway.ts";
import { PostgresTenantApiAuthenticator } from "./tenant-identity.ts";
import { TenantModelCredentialVault } from "@pi-cloud/runtime-core/model-credential-runtime";
import { resolvePlatformInitialModel } from "./platform-model-configuration.ts";
import { WebAuthenticationService } from "./web-authentication.ts";
import { createControlPlaneRuntime, type ControlPlaneRuntime } from "./control-plane-runtime.ts";
import { ReplicatedToolBrokerClient } from "@pi-cloud/tool-broker/client";
import { WorkspaceTerminalGateway } from "./workspace-terminal-gateway.ts";
import { DevelopmentEnvironmentService } from "./development-environment-service.ts";
import { TerminalTurnProjectionGateway } from "./terminal-turn-projection-gateway.ts";
import { SandboxPreviewGateway } from "./sandbox-preview-gateway.ts";
import { SshAccessTicketService } from "./ssh-access-ticket-service.ts";
import { AcceptedFactIngestGateway } from "./accepted-fact-ingest-gateway.ts";
import { OperationalMetricsSampler } from "./operational-metrics-sampler.ts";
import { GitHubAppClient } from "./github-app-client.ts";
import { SourceControlService } from "./source-control-service.ts";
import { SourceControlIssueCoordinator } from "./source-control-issue-coordinator.ts";
import { SourceControlCredentialVault } from "./source-control-credential-vault.ts";
import { OidcAuthenticationService } from "./oidc-authentication.ts";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

async function verifyBootstrap(database: ReturnType<typeof createDatabase>): Promise<void> {
  const profile = await database
    .selectFrom("tenant_runtime_policies as policy")
    .innerJoin("model_profiles as profile", (join) =>
      join
        .onRef("profile.tenant_id", "=", "policy.tenant_id")
        .onRef("profile.id", "=", "policy.default_model_profile_id"),
    )
    .select("policy.tenant_id")
    .where("profile.enabled", "=", true)
    .limit(1)
    .executeTakeFirst();
  if (profile === undefined) {
    throw new Error("Production database bootstrap is missing or inconsistent");
  }
}

export async function startControlPlane(): Promise<void> {
  const config = await loadProductionControlPlaneConfig();
  const observability = await startServiceObservability({
    serviceName: "pi-cloud-control-plane",
    defaultMetricsPort: 9464,
  });
  const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 12 });
  const objectStore = new PostgresRuntimeObjectStore(database);
  const controlPlaneInstanceId = randomUUID();
  let agentEvents: KafkaEventRuntime | undefined;
  let runtime: ControlPlaneRuntime | undefined;
  let developmentEnvironmentService: DevelopmentEnvironmentService | undefined;
  let operationalMetrics: OperationalMetricsSampler | undefined;
  let issueCoordinator: SourceControlIssueCoordinator | undefined;
  let sourceControlDispatcher: EnvHttpProxyAgent | undefined;
  let closing = false;
  try {
    agentEvents = new KafkaEventRuntime({
      database,
      brokers: config.kafkaBrokers,
      instanceId: controlPlaneInstanceId,
      partitions: config.kafkaPartitions,
      replicas: config.kafkaReplicas,
      retentionMs: config.acceptedFactRetentionMs,
      factChannelLeaseMs: config.factChannelLeaseMs,
      factChannelMaximumActive: config.factChannelMaximumActive,
    });
    const activeAgentEvents = agentEvents;
    await verifyBootstrap(database);
    await activeAgentEvents.start();
    operationalMetrics = new OperationalMetricsSampler({
      database,
      events: activeAgentEvents,
      metrics: observability.metrics,
      onError: (source) =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "observability.sample_failed",
          attributes: { source },
        }),
    });
    await operationalMetrics.start();
    const modelCredentialVault = new TenantModelCredentialVault(config.modelCredentialMasterKey);
    const platformInitialModel = await resolvePlatformInitialModel(
      database,
      modelCredentialVault,
      config.platformModelSourceTenantId,
    );
    const registrationConfiguration = {
      ...config.publicRegistration,
      ...(platformInitialModel === undefined ? {} : { initialModel: platformInitialModel }),
    };
    const webAuthentication = new WebAuthenticationService({
      database,
      ...registrationConfiguration,
      initialModel: () =>
        resolvePlatformInitialModel(
          database,
          modelCredentialVault,
          config.platformModelSourceTenantId,
        ),
      secureCookie: config.webSessionCookieSecure,
      sessionTtlMs: config.webSessionTtlMs,
      platformOperatorTenantId: config.platformOperatorTenantId,
    });
    await objectStore.checkHealth();
    const managementClients = new Map<string, HttpSupervisorManagementClient>();
    const resolveManagementClient = async (identity: {
      supervisorId: string;
      bootId: string;
      sandboxId: string;
    }): Promise<HttpSupervisorManagementClient> => {
      const host = await database
        .selectFrom("supervisor_hosts as host")
        .innerJoin("sandboxes as sandbox", "sandbox.supervisor_id", "host.supervisor_id")
        .select("host.management_base_url")
        .where("sandbox.id", "=", identity.sandboxId)
        .where("sandbox.supervisor_id", "=", identity.supervisorId)
        .where("sandbox.boot_id", "=", identity.bootId)
        .executeTakeFirst();
      if (host === undefined) {
        throw new Error("Supervisor management identity is not registered");
      }
      let client = managementClients.get(host.management_base_url);
      if (client === undefined) {
        client = new HttpSupervisorManagementClient({
          baseUrl: host.management_base_url,
          managementToken: config.supervisorManagementToken,
          allowInsecureHttp: config.allowInsecureInternalHttp,
        });
        managementClients.set(host.management_base_url, client);
      }
      return client;
    };
    const resolveSteerBackend = async (sandboxId: string): Promise<HttpSupervisorSteerBackend> => {
      const identity = await database
        .selectFrom("sandboxes")
        .select(["supervisor_id", "boot_id"])
        .where("id", "=", sandboxId)
        .executeTakeFirst();
      if (identity === undefined) throw new Error("Active Pi Worker identity is unavailable");
      return new HttpSupervisorSteerBackend({
        client: await resolveManagementClient({
          supervisorId: identity.supervisor_id,
          bootId: identity.boot_id,
          sandboxId,
        }),
        leaseCoordinator: new SessionLeaseCoordinator({ database, sandboxId }),
      });
    };
    const workspaceBrowserClient = new ReplicatedToolBrokerClient({
      baseUrls: config.toolBrokerBaseUrls,
      serviceToken: config.workspaceServiceToken,
      allowInsecureHttp: config.allowInsecureInternalHttp,
    });
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: config.supervisorIdPrefix,
      managementBaseUrlTemplates: config.supervisorManagementBaseUrlTemplates,
      maximumCapacity: config.supervisorMaximumCapacity,
      enrollmentToken: config.supervisorEnrollmentToken,
    });
    const provisioningGateway = new SupervisorProvisioningGateway({ provisioner });
    const terminalTurnProjectionGateway = new TerminalTurnProjectionGateway({
      source: activeAgentEvents.terminalTurnProjectionSource,
      authorize: (authorization) => provisioner.authorize(authorization),
    });
    const acceptedFactIngestGateway = new AcceptedFactIngestGateway({
      channels: activeAgentEvents.factChannels,
      serviceToken: config.workerEventIngestToken,
    });
    const httpGateway = new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database }),
      publicRegistrationEnabled: config.publicRegistration.enabled,
      webSessionAuthenticator: webAuthentication,
      readiness: async () => {
        if (runtime?.state !== "running") return false;
        await Promise.all([
          activeAgentEvents.checkHealth(),
          sql`select 1`.execute(database),
          workspaceBrowserClient.checkHealth(),
        ]);
        return true;
      },
    });
    const workspaceTerminalGateway = new WorkspaceTerminalGateway({
      database,
      terminalToken: config.workspaceTerminalToken,
      allowInsecureInternalHttp: config.allowInsecureInternalHttp,
    });
    const sandboxPreviewGateway = new SandboxPreviewGateway({
      database,
      previewToken: config.workspaceTerminalToken,
      publicOriginBaseUrl: config.previewPublicOriginBaseUrl,
      allowInsecureInternalHttp: config.allowInsecureInternalHttp,
    });
    developmentEnvironmentService = new DevelopmentEnvironmentService({
      database,
      terminalToken: config.workspaceTerminalToken,
      allowInsecureInternalHttp: config.allowInsecureInternalHttp,
      environmentImageRevision: config.environmentImageRevision,
    });
    developmentEnvironmentService.start();
    const sshAccessTicketService = new SshAccessTicketService({
      database,
      enabled: config.sshGatewayEnabled,
      advertisedHost: config.sshAdvertisedHost,
      advertisedPort: config.sshAdvertisedPort,
      ticketTtlMs: config.sshTicketTtlMs,
    });
    let githubRuntime;
    if (
      config.githubApp !== undefined ||
      config.gitlabProject !== undefined ||
      config.gitlabOidc !== undefined
    ) {
      sourceControlDispatcher = new EnvHttpProxyAgent();
    }
    if (config.githubApp !== undefined) {
      const dispatcher = sourceControlDispatcher!;
      githubRuntime = {
        appSlug: config.githubApp.appSlug,
        issueLabel: config.githubApp.issueLabel,
        client: new GitHubAppClient({
          appId: config.githubApp.appId,
          privateKeyPem: config.githubApp.privateKeyPem,
          webhookSecret: config.githubApp.webhookSecret,
          fetch: (input, init) =>
            undiciFetch(input as Parameters<typeof undiciFetch>[0], {
              ...(init as Parameters<typeof undiciFetch>[1]),
              dispatcher,
            }) as unknown as Promise<Response>,
        }),
      };
    }
    const gitlabRuntime =
      config.gitlabProject === undefined
        ? undefined
        : {
            vault: new SourceControlCredentialVault(config.gitlabProject.credentialMasterKey),
            webhookUrl: config.gitlabProject.webhookUrl,
            publicOrigin: config.publicOriginBaseUrl,
            issueLabel: config.gitlabProject.issueLabel,
            ...(config.gitlabProject.internalBaseUrl === undefined
              ? {}
              : { internalBaseUrl: config.gitlabProject.internalBaseUrl }),
            ...(config.gitlabProject.workspaceBaseUrl === undefined
              ? {}
              : { workspaceBaseUrl: config.gitlabProject.workspaceBaseUrl }),
            ...(config.gitlabOidc === undefined
              ? {}
              : {
                  oauthClientId: config.gitlabOidc.clientId,
                  oauthClientSecret: config.gitlabOidc.clientSecret,
                  oauthIssuer: config.gitlabOidc.issuer,
                }),
            fetch: (input: string | URL | Request, init?: RequestInit) =>
              undiciFetch(input as Parameters<typeof undiciFetch>[0], {
                ...(init as Parameters<typeof undiciFetch>[1]),
                dispatcher: sourceControlDispatcher!,
              }) as unknown as Promise<Response>,
          };
    const sourceControlService = new SourceControlService({
      database,
      workspaceServiceToken: config.workspaceServiceToken,
      allowInsecureInternalHttp: config.allowInsecureInternalHttp,
      ...(githubRuntime === undefined ? {} : { github: githubRuntime }),
      ...(gitlabRuntime === undefined ? {} : { gitlab: gitlabRuntime }),
    });
    const oidcAuthenticationService = new OidcAuthenticationService({
      database,
      webAuthentication,
      publicOrigin: config.publicOriginBaseUrl,
      providers:
        config.gitlabOidc === undefined
          ? []
          : [
              {
                key: "gitlab",
                label: config.gitlabOidc.label,
                issuer: config.gitlabOidc.issuer,
                clientId: config.gitlabOidc.clientId,
                clientSecret: config.gitlabOidc.clientSecret,
                tenantId: config.gitlabOidc.tenantId,
                defaultRole: "member",
                kind: "gitlab",
                allowInsecureHttp: config.gitlabOidc.allowInsecureHttp,
                fetch: (input: string | URL | Request, init?: RequestInit) =>
                  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
                    ...(init as Parameters<typeof undiciFetch>[1]),
                    dispatcher: sourceControlDispatcher!,
                  }) as unknown as Promise<Response>,
              },
            ],
    });
    runtime = await createControlPlaneRuntime({
      database,
      controlPlaneInstanceId,
      eventRuntime: {
        eventHub: activeAgentEvents.eventHub,
        eventStore: activeAgentEvents.eventStore,
        terminalTurnProjectionSource: activeAgentEvents.terminalTurnProjectionSource,
      },
      developmentEnvironmentService,
      sshAccessTicketService,
      supervisorAuthorizer: new PostgresSupervisorCredentialAuthorizer({ database }),
      supervisorOwnerBoundary: new RoutedHttpSupervisorOwnerBoundary(resolveManagementClient),
      assignmentInventoryFactory: (identity) =>
        new RoutedHttpSandboxAssignmentInventory(resolveManagementClient, identity),
      supervisorProvisioningGateway: provisioningGateway,
      terminalTurnProjectionGateway,
      acceptedFactIngestGateway,
      turnSteerBackendFactory: resolveSteerBackend,
      productionHttpGateway: httpGateway,
      publicRegistration: registrationConfiguration,
      webAuthentication,
      modelCredentialVault,
      platformOperatorTenantId: config.platformOperatorTenantId,
      platformModelSourceTenantId: config.platformModelSourceTenantId,
      cubeEgressConfigToken: config.cubeEgressConfigToken,
      workspaceTerminalGateway,
      sandboxPreviewGateway,
      sourceControlService,
      oidcAuthenticationService,
      publicOriginBaseUrl: config.publicOriginBaseUrl,
      environmentImageRevision: config.environmentImageRevision,
      metrics: observability.metrics,
      workspaceBrowser: {
        listWorkspaceDirectory: (request, signal) =>
          workspaceBrowserClient.listWorkspaceDirectory(request, signal),
        readWorkspaceFile: (request, signal) =>
          workspaceBrowserClient.readWorkspaceFile(request, signal),
      },
      maintenance: {
        onActivity: (activity) =>
          operationalLog({
            service: "pi-cloud-control-plane",
            level: activity.type === "runtime.failure" ? "error" : "info",
            event: activity.type,
            attributes: { ...activity },
          }),
      },
    });
    await runtime.listen(config.port, config.host);
    if (sourceControlService.configured) {
      issueCoordinator = new SourceControlIssueCoordinator({
        database,
        sourceControl: sourceControlService,
        instanceId: controlPlaneInstanceId,
        environmentImageRevision: config.environmentImageRevision,
      });
      issueCoordinator.start();
    }
    process.stdout.write(
      `PiCloud production control plane listening on ${config.host}:${String(config.port)}\n`,
    );

    const close = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      await issueCoordinator?.close();
      await runtime?.close();
      await developmentEnvironmentService?.close();
      await operationalMetrics?.close();
      await activeAgentEvents.close();
      await sourceControlDispatcher?.close();
      objectStore.destroy();
      await database.destroy();
      await observability.close();
    };
    const closeAfterSignal = (): void => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", closeAfterSignal);
    process.once("SIGTERM", closeAfterSignal);
  } catch (error: unknown) {
    closing = true;
    await issueCoordinator?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await developmentEnvironmentService?.close().catch(() => undefined);
    await operationalMetrics?.close().catch(() => undefined);
    await agentEvents?.close().catch(() => undefined);
    await sourceControlDispatcher?.close().catch(() => undefined);
    objectStore.destroy();
    await database.destroy();
    await observability.close().catch(() => undefined);
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startControlPlane().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown startup failure";
    process.stderr.write(`PiCloud production control plane failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
