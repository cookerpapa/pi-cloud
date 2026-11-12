import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { createDatabase } from "@pi-cloud/database";
import { startServiceObservability } from "@pi-cloud/observability";
import { KafkaToolCatalogConsumer } from "@pi-cloud/event-log";
import { SessionEventHub } from "@pi-cloud/runtime-core/session-event-hub";
import { HttpPublicationClient } from "@pi-cloud/runtime-core/http-publication-client";
import { SessionControlOutbox } from "@pi-cloud/runtime-core/session-control-outbox";
import { ReplicatedSandboxControlClient } from "@pi-cloud/sandbox-control/client";
import { HttpExecutorTransport } from "@pi-cloud/sandbox-control";
import { configuredImageAttachments } from "@pi-cloud/session-attachments";
import { createControlPlaneApplication } from "./application.ts";
import { loadSessionApiConfig } from "./production-config.ts";
import { closeControlPlaneResources } from "./close-resources.ts";
import { ProductionHttpGateway } from "./production-http-gateway.ts";
import { PostgresTenantApiAuthenticator } from "./tenant-identity.ts";
import { WebAuthenticationService } from "./web-authentication.ts";
import { resolvePlatformInitialModel } from "./platform-model-configuration.ts";
import { PlatformRuntimeSettingsService } from "./platform-runtime-settings.ts";
import { WorkspaceTerminalGateway } from "./workspace-terminal-gateway.ts";
import { SandboxPreviewGateway } from "./sandbox-preview-gateway.ts";
import { DevelopmentEnvironmentService } from "./development-environment-service.ts";
import { SshAccessTicketService } from "./ssh-access-ticket-service.ts";
import { createSourceControlServices } from "./source-control-services.ts";
import { SessionScheduleService } from "./session-schedule-service.ts";
import { SkillMarketService } from "./skill-market-service.ts";
import { ToolCatalogAuthority } from "./tool-catalog-authority.ts";
import { ExecutionTargetService } from "./execution-target-service.ts";
import { HttpSupervisorManagementClient } from "./http-supervisor-management.ts";
import { runtimeModelCatalog } from "./runtime-model-catalog.ts";

/** Public admission/history/UI only: no Session consumer, Worker membership,
 * lease controller, VM allocator or Tool dispatcher is started in this process. */
export async function startSessionApi(): Promise<void> {
  const config = await loadSessionApiConfig();
  runtimeModelCatalog();
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  let closing: Promise<void> | undefined;
  let ready = false;
  const close = () => {
    ready = false;
    return (closing ??= closeControlPlaneResources(cleanup.splice(0).reverse()));
  };
  try {
    const observability = await startServiceObservability({
      serviceName: "pi-cloud-session-api",
      defaultMetricsPort: 9464,
    });
    cleanup.push(() => observability.close());
    const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 12 });
    cleanup.push(() => database.destroy());
    const readDatabase = createDatabase({
      connectionString: config.databaseUrl,
      maxConnections: 4,
      readTimeoutMs: 5000,
    });
    cleanup.push(() => readDatabase.destroy());
    const admissionDatabase = createDatabase({
      connectionString: config.databaseNotificationUrl,
      maxConnections: 3,
      checkoutTimeoutMs: 5000,
    });
    cleanup.push(() => admissionDatabase.destroy());
    const images = await configuredImageAttachments(database);
    if (images) {
      await images.blobs.checkHealth();
      cleanup.push(() => images.blobs.close());
    }
    const runtimeUrl = process.env.PI_CLOUD_SESSION_RUNTIME_URL ?? "http://session-runtime:3000";
    const executionUrl =
      process.env.PI_CLOUD_SESSION_EXECUTION_URL ?? "http://session-runtime:4300";
    const publication = new HttpPublicationClient({
      baseUrl: runtimeUrl,
      token: config.supervisorManagementToken,
    });
    cleanup.push(() => publication.close());
    const changes = new SessionControlOutbox(admissionDatabase, publication);
    const transport = new HttpExecutorTransport(config.supervisorManagementToken);
    cleanup.push(() => transport.close());
    const executionTargets = new ExecutionTargetService({
      database,
      transport,
      publish: (ids) => changes.flushEntities("execution_binding", ids),
    });
    const managementFiles = new ReplicatedSandboxControlClient({
      baseUrls: config.sandboxControlBaseUrls,
      serviceToken: config.workspaceServiceToken,
      allowInsecureHttp: config.allowInsecureInternalHttp,
    });
    const executionFiles = new ReplicatedSandboxControlClient({
      baseUrls: [executionUrl],
      serviceToken: config.workspaceServiceToken,
      allowInsecureHttp: config.allowInsecureInternalHttp,
    });
    const catalogAuthority = new ToolCatalogAuthority(database);
    // This is only the small configuration topic, never Session execution logs.
    const catalog = new KafkaToolCatalogConsumer({
      brokers: config.kafkaBrokers,
      replicas: config.kafkaReplicas,
      instanceId: randomUUID(),
      minimumGeneration: async () => (await catalogAuthority.read())?.generation ?? 1,
    });
    cleanup.push(() => catalog.close());
    await catalog.start();
    const dispatcher = new EnvHttpProxyAgent();
    cleanup.push(() => dispatcher.close());
    const skills = new SkillMarketService({
      database,
      ...(images ? { blobs: images.blobs } : {}),
      catalog: () => catalog.view.read().tools,
      maximumDepth: config.subagentTreePolicy.maximumDepth,
      fetch: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        undiciFetch(url as Parameters<typeof undiciFetch>[0], {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher,
        })) as unknown as typeof fetch,
    });
    await skills.initialize();
    const registration = {
      ...config.publicRegistration,
      initialModel: () => resolvePlatformInitialModel(database, config.platformModelSourceTenantId),
    };
    const webAuthentication = new WebAuthenticationService({
      database,
      ...registration,
      secureCookie: config.webSessionCookieSecure,
      sessionTtlMs: config.webSessionTtlMs,
      platformOperatorTenantId: config.platformOperatorTenantId,
    });
    const platformRuntimeSettings = new PlatformRuntimeSettingsService({
      database,
      platformOperatorTenantId: config.platformOperatorTenantId,
      internalServiceToken: config.cubeEgressConfigToken,
    });
    const developmentEnvironmentService = new DevelopmentEnvironmentService({
      database,
      terminalToken: config.workspaceTerminalToken,
      allowInsecureInternalHttp: config.allowInsecureInternalHttp,
      environmentImageRevision: config.environmentImageRevision,
    });
    cleanup.push(() => developmentEnvironmentService.close());
    const source = createSourceControlServices(database, config);
    cleanup.push(() => source.close());
    const application = await createControlPlaneApplication({
      database,
      conversationReadDatabase: readDatabase,
      skills,
      executionTargets,
      schedules: new SessionScheduleService({
        database,
        admissionDatabase,
        environmentImageRevision: config.environmentImageRevision,
      }),
      eventRuntime: {
        eventHub: new SessionEventHub(),
        eventStore: {
          snapshot: () => {
            throw new Error("Session live reads require the execution owner");
          },
        },
      },
      sessionEventStreamOptions: {
        remote: { baseUrl: runtimeUrl, token: config.supervisorManagementToken },
      },
      platformRuntimeSettings,
      developmentEnvironmentService,
      nativeInputBackendFactory: async (workerId) => {
        const host = await database
          .selectFrom("workers as worker")
          .innerJoin("supervisor_hosts as host", "host.supervisor_id", "worker.supervisor_id")
          .select("host.management_base_url")
          .where("worker.id", "=", workerId)
          .executeTakeFirst();
        if (!host) throw new Error("Active Pi Worker identity is unavailable");
        return new HttpSupervisorManagementClient({
          baseUrl: host.management_base_url,
          managementToken: config.supervisorManagementToken,
          allowInsecureHttp: config.allowInsecureInternalHttp,
        });
      },
      productionHttpGateway: new ProductionHttpGateway({
        authenticator: new PostgresTenantApiAuthenticator({ database }),
        publicRegistrationEnabled: config.publicRegistration.enabled,
        webSessionAuthenticator: webAuthentication,
        readiness: async () => {
          if (!ready) return false;
          await sql`select 1`.execute(database);
          return true;
        },
      }),
      publicRegistration: registration,
      webAuthentication,
      platformOperatorTenantId: config.platformOperatorTenantId,
      platformModelSourceTenantId: config.platformModelSourceTenantId,
      cubeEgressConfigToken: config.cubeEgressConfigToken,
      workspaceTerminalGateway: new WorkspaceTerminalGateway({
        database,
        terminalToken: config.workspaceTerminalToken,
        allowInsecureInternalHttp: config.allowInsecureInternalHttp,
      }),
      sandboxPreviewGateway: new SandboxPreviewGateway({
        database,
        previewToken: config.workspaceTerminalToken,
        executionBaseUrl: executionUrl,
        publicOriginBaseUrl: config.previewPublicOriginBaseUrl,
        listenHost: config.host,
        listenPort: config.previewPort,
        allowInsecureInternalHttp: config.allowInsecureInternalHttp,
      }),
      sshAccessTicketService: new SshAccessTicketService({
        database,
        enabled: config.sshGatewayEnabled,
        advertisedHost: config.sshAdvertisedHost,
        advertisedPort: config.sshAdvertisedPort,
        ticketTtlMs: config.sshTicketTtlMs,
      }),
      sourceControlService: source.sourceControlService,
      environmentImageRevision: config.environmentImageRevision,
      metrics: observability.metrics,
      workspaceBrowser: {
        listWorkspaceDirectory: (request) => executionFiles.listWorkspaceDirectory(request),
        readWorkspaceFile: (request, signal) => executionFiles.readWorkspaceFile(request, signal),
      },
      workspaceUploader: {
        uploadWorkspaceFile: (request, bytes, signal) =>
          managementFiles.uploadWorkspaceFile(request, bytes, signal),
      },
      workspaceFileTransfers: managementFiles,
      ...(images ? { imageAttachmentStore: images.store } : {}),
    });
    cleanup.push(() => application.close());
    await application.listen(config.port, config.host);
    ready = true;
    process.stdout.write(`PiCloud Session API listening on ${config.host}:${config.port}\n`);
    const stop = () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    await close();
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href)
  startSessionApi().catch(() => {
    process.stderr.write("PiCloud Session API startup failed\n");
    process.exitCode = 1;
  });
