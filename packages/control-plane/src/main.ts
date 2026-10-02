import { SessionPublicationService } from "./session-publication-service.ts";
import { SubagentController } from "./subagent-controller.ts";
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
import { SessionProjector } from "@pi-cloud/runtime-core/session-projector";
import { kafkaProducerLane } from "@pi-cloud/runtime-core/kafka-accepted-fact";
import { SessionControlOutbox } from "@pi-cloud/runtime-core/session-control-outbox";
import { InputQueueView } from "./input-queue-view.ts";
import { readInputQueue } from "./input-queue-snapshot.ts";
import { QueuedInputService } from "./queued-input-service.ts";
import { createSandboxControl } from "@pi-cloud/sandbox-control/runtime";
import {
  PostgresSupervisorCredentialAuthorizer,
  SupervisorBootProvisioner,
  SupervisorProvisioningGateway,
} from "./supervisor-boot-provisioner.ts";
import { loadProductionControlPlaneConfig } from "./production-config.ts";
import { ProductionHttpGateway } from "./production-http-gateway.ts";
import { PostgresTenantApiAuthenticator } from "./tenant-identity.ts";
import { resolvePlatformInitialModel } from "./platform-model-configuration.ts";
import { WebAuthenticationService } from "./web-authentication.ts";
import { createControlPlaneRuntime, type ControlPlaneRuntime } from "./control-plane-runtime.ts";
import { ReplicatedSandboxControlClient } from "@pi-cloud/sandbox-control/client";
import { WorkspaceTerminalGateway } from "./workspace-terminal-gateway.ts";
import { DevelopmentEnvironmentService } from "./development-environment-service.ts";
import { SandboxPreviewGateway } from "./sandbox-preview-gateway.ts";
import { SshAccessTicketService } from "./ssh-access-ticket-service.ts";
import { OperationalMetricsSampler } from "./operational-metrics-sampler.ts";
import { GitHubAppClient } from "./github-app-client.ts";
import { SourceControlService } from "./source-control-service.ts";
import { SourceControlIssueCoordinator } from "./source-control-issue-coordinator.ts";
import { GitLabIssueNoteReconciler } from "./gitlab-issue-note-reconciler.ts";
import {
  configuredImageAttachments,
  ImageAttachmentReaper,
  type ConfiguredImageAttachments,
} from "@pi-cloud/session-attachments";
import { SourceControlCredentialVault } from "./source-control-credential-vault.ts";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

export async function closeControlPlaneResources(
  resources: readonly (() => unknown | Promise<unknown>)[],
): Promise<void> {
  const errors: unknown[] = [];
  // Keep the drain order, but a failed close must not leak unrelated resources.
  for (const close of resources) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Control Plane resource cleanup failed");
}

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
  let ownedObservability: Awaited<ReturnType<typeof startServiceObservability>> | undefined;
  let ownedDatabase: ReturnType<typeof createDatabase> | undefined;
  let unattachedSubagents: SubagentController | undefined;
  const controlPlaneInstanceId = randomUUID();
  let agentEvents: SessionProjector | undefined;
  let sandboxControl: Awaited<ReturnType<typeof createSandboxControl>> | undefined;
  let runtime: ControlPlaneRuntime | undefined;
  let queuedInputs: QueuedInputService | undefined;
  let developmentEnvironmentService: DevelopmentEnvironmentService | undefined;
  let operationalMetrics: OperationalMetricsSampler | undefined;
  let issueCoordinator: SourceControlIssueCoordinator | undefined;
  let issueNoteReconciler: GitLabIssueNoteReconciler | undefined;
  let images: ConfiguredImageAttachments | undefined;
  let imageReaper: ImageAttachmentReaper | undefined;
  let sourceControlDispatcher: EnvHttpProxyAgent | undefined;
  let internalSourceControlDispatcher: Agent | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    return (closePromise ??= closeControlPlaneResources([
      () => imageReaper?.close(),
      () => issueNoteReconciler?.close(),
      () => issueCoordinator?.close(),
      // Relinquish log partitions before potentially long resource drains.
      () => agentEvents?.close(),
      () => runtime?.close(),
      () => developmentEnvironmentService?.close(),
      () => operationalMetrics?.close(),
      () => sandboxControl?.close(),
      () => unattachedSubagents?.close(),
      () => sourceControlDispatcher?.close(),
      () => internalSourceControlDispatcher?.close(),
      () => images?.blobs.close(),
      () => ownedDatabase?.destroy(),
      () => ownedObservability?.close(),
    ]));
  };
  try {
    const observability = await startServiceObservability({
      serviceName: "pi-cloud-control-plane",
      defaultMetricsPort: 9464,
    });
    ownedObservability = observability;
    const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 12 });
    ownedDatabase = database;
    images = await configuredImageAttachments(database);
    if (images) {
      await images.blobs.checkHealth();
      imageReaper = new ImageAttachmentReaper(images.store, () =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "error",
          event: "image.cleanup.failed",
        }),
      );
    }
    const controlChanges = new SessionControlOutbox(database, {
      publishControl: async (change) => {
        if (!agentEvents) throw new Error("Session publication is not ready");
        return agentEvents.publishControl(change);
      },
    });
    sandboxControl = await createSandboxControl({
      database,
      instanceId: controlPlaneInstanceId,
      managementToken: config.supervisorManagementToken,
      metrics: observability.metrics,
      publishBindingChanges: (ids) => controlChanges.flushEntities("sandbox_binding", ids),
      partitionFor: (sessionId) => kafkaProducerLane(sessionId, config.kafkaPartitions),
      ...(images ? { images } : {}),
    });
    const workspaceBrowserClient = new ReplicatedSandboxControlClient({
      baseUrls: config.sandboxControlBaseUrls,
      serviceToken: config.workspaceServiceToken,
      allowInsecureHttp: config.allowInsecureInternalHttp,
    });
    const subagents = new SubagentController({
      database,
      managementToken: config.supervisorManagementToken,
      allowInsecureHttp: config.allowInsecureInternalHttp,
      ownsPartition: (partition) => agentEvents?.ownsPartition(partition) === true,
      treePolicy: config.subagentTreePolicy,
      validateDirectory: async (target) => {
        const machine =
          target.executionMode === "development_environment" && target.computeSessionId === null;
        const root =
          target.executionMode === "development_environment" ? "/home/user" : "/workspace";
        if (!machine && target.cwd !== root && !target.cwd.startsWith(root + "/"))
          throw new Error("Subagent directory is outside the shared Volume");
        if (machine && (!target.developmentEnvironmentId || !target.userId))
          throw new Error("Subagent machine ownership is unavailable");
        await workspaceBrowserClient.listWorkspaceDirectory({
          toolBrokerProtocolVersion: 1,
          type: "workspace.list_directory",
          requestId: randomUUID(),
          tenantId: target.tenantId,
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
          rootPath: "",
          path: machine ? "" : target.cwd.slice(root.length).replace(/^\//, ""),
          ...(machine
            ? {
                machine: {
                  environmentId: target.developmentEnvironmentId!,
                  userId: target.userId!,
                  directory: target.cwd,
                },
              }
            : {}),
        });
      },
      onError: (error) =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "subagent.delivery_retry",
          attributes: { reason: error instanceof Error ? error.message : "unknown" },
        }),
    });
    unattachedSubagents = subagents;
    const inputQueues = new InputQueueView({
      read: (tenant, session) => readInputQueue(database, tenant, session),
      watched: (tenant, session) => agentEvents?.eventHub.hasSubscribers(tenant, session) === true,
      publish: (tenant, queue) => agentEvents?.eventHub.publishInputQueue(tenant, queue),
      unavailable: (tenant, session) => agentEvents?.eventHub.resyncSession(tenant, session),
    });
    const bindingView = sandboxControl.bindingView;
    agentEvents = new SessionProjector({
      publicationToken: config.supervisorManagementToken,
      database,
      notificationConnectionString: config.databaseNotificationUrl,
      brokers: config.kafkaBrokers,
      clientId: controlPlaneInstanceId,
      advertisedBaseUrl: config.projectorAdvertisedBaseUrl,
      subagentCommands: {
        consume: async (record, current) => {
          await subagents.consume(record, current);
          if (current?.() === false) return;
          const fact = record.fact;
          if (
            fact.kind === "execution_seal" ||
            ((fact.kind === "pi_session_append" || fact.kind === "tool_invocation") &&
              fact.piSession.lane === "main" &&
              fact.items.some(
                (item) =>
                  item.kind === "entry" &&
                  item.entry.type === "message" &&
                  item.entry.message.role === "user" &&
                  item.entry.id.startsWith("pc-agent-input-"),
              ))
          )
            queuedInputs?.notifySession(fact.scope.tenantId, fact.scope.sessionId);
        },
        close: () => subagents.close(),
      },
      toolCommands: sandboxControl.dispatcher,
      executionProbes: sandboxControl.probes,
      controlChanges: {
        load: async (partitions, current) => {
          await bindingView.load(partitions, current);
          if (current()) await subagents.recover(partitions, current);
          if (current()) queuedInputs?.recoverPending();
        },
        reset: () => {
          bindingView.reset();
          inputQueues.reset();
          subagents.reset();
        },
        prepare: (change, current) => bindingView.prepare(change, current),
        consume: async (change, current) => {
          await bindingView.consume(change, current);
          await subagents.changed(change, current);
          if (current() && change.entity === "input_queue")
            queuedInputs?.notifySession(change.scope.tenantId, change.entityId);
          try {
            await inputQueues.consume(change, current);
          } catch {
            // Queue presentation is disposable. A failed snapshot must not
            // stop unrelated native projection or durable input reconciliation.
            agentEvents?.eventHub.resyncSession(change.scope.tenantId, change.entityId);
            operationalLog({
              service: "pi-cloud-control-plane",
              level: "warn",
              event: "input_queue.observation_unavailable",
            });
          }
        },
      },
      partitions: config.kafkaPartitions,
      replicas: config.kafkaReplicas,
      capacity: config.producerCapacity,
      retentionMs: config.acceptedFactRetentionMs,
      metrics: observability.metrics,
    });
    // The completed Projector now owns/drains its command consumers.
    unattachedSubagents = undefined;
    const activeAgentEvents = agentEvents;
    const executionProbes = sandboxControl.probes;
    executionProbes.observeWith({
      active: (scope, partition) => activeAgentEvents.observations.isActive(scope, partition),
      targets: (writer, bindings, at) =>
        activeAgentEvents.observations.executionTargets(writer, bindings, at),
      status: (scope, status) => activeAgentEvents.observations.execution(scope, status),
    });
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
    const registrationConfiguration = {
      ...config.publicRegistration,
      initialModel: () => resolvePlatformInitialModel(database, config.platformModelSourceTenantId),
    };
    const webAuthentication = new WebAuthenticationService({
      database,
      ...registrationConfiguration,
      initialModel: () => resolvePlatformInitialModel(database, config.platformModelSourceTenantId),
      secureCookie: config.webSessionCookieSecure,
      sessionTtlMs: config.webSessionTtlMs,
      platformOperatorTenantId: config.platformOperatorTenantId,
    });
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
      // Connections are pooled by the shared HTTP dispatcher; this object owns
      // no transport resources and need not retain every historical Worker URL.
      return new HttpSupervisorManagementClient({
        baseUrl: host.management_base_url,
        managementToken: config.supervisorManagementToken,
        allowInsecureHttp: config.allowInsecureInternalHttp,
      });
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
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: config.supervisorIdPrefix,
      managementBaseUrlTemplates: config.supervisorManagementBaseUrlTemplates,
      maximumCapacity: config.supervisorMaximumCapacity,
      enrollmentToken: config.supervisorEnrollmentToken,
    });
    const provisioningGateway = new SupervisorProvisioningGateway({ provisioner });
    const httpGateway = new ProductionHttpGateway({
      authenticator: new PostgresTenantApiAuthenticator({ database }),
      publicRegistrationEnabled: config.publicRegistration.enabled,
      webSessionAuthenticator: webAuthentication,
      readiness: async () => {
        if (runtime?.state !== "running" || sandboxControl?.ready !== true) return false;
        await Promise.all([activeAgentEvents.checkIngestHealth(), sql`select 1`.execute(database)]);
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
      listenHost: config.host,
      listenPort: config.previewPort,
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
    if (config.githubApp !== undefined || config.gitlabProject !== undefined) {
      sourceControlDispatcher = new EnvHttpProxyAgent();
    }
    if (config.gitlabProject?.internalBaseUrl !== undefined) {
      internalSourceControlDispatcher = new Agent();
    }
    if (config.githubApp !== undefined) {
      const dispatcher = sourceControlDispatcher!;
      githubRuntime = {
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
            fetch: (input: string | URL | Request, init?: RequestInit) =>
              undiciFetch(input as Parameters<typeof undiciFetch>[0], {
                ...(init as Parameters<typeof undiciFetch>[1]),
                dispatcher:
                  config.gitlabProject!.internalBaseUrl === undefined
                    ? sourceControlDispatcher!
                    : internalSourceControlDispatcher!,
              }) as unknown as Promise<Response>,
          };
    const sourceControlService = new SourceControlService({
      database,
      workspaceServiceToken: config.workspaceServiceToken,
      allowInsecureInternalHttp: config.allowInsecureInternalHttp,
      ...(githubRuntime === undefined ? {} : { github: githubRuntime }),
      ...(gitlabRuntime === undefined ? {} : { gitlab: gitlabRuntime }),
    });
    runtime = await createControlPlaneRuntime({
      sessionPublicationService: new SessionPublicationService(
        config.supervisorManagementToken,
        activeAgentEvents,
      ),
      runActivityIngress: new RunActivityIngress(
        config.supervisorManagementToken,
        (partition) => activeAgentEvents.ownerForPartition(partition),
        (delivery) => activeAgentEvents.observations.activity(delivery),
        (delivery) => executionProbes.complete(delivery),
      ),
      toolProgressIngress: new ToolProgressIngress(
        config.supervisorManagementToken,
        (partition) => activeAgentEvents.ownerForPartition(partition),
        ({ tenantId, progress }) => activeAgentEvents.eventHub.publishProgress(tenantId, progress),
      ),
      database,
      controlPlaneInstanceId,
      eventRuntime: {
        eventHub: activeAgentEvents.eventHub,
        eventStore: activeAgentEvents.eventStore,
      },
      developmentEnvironmentService,
      sshAccessTicketService,
      supervisorAuthorizer: new PostgresSupervisorCredentialAuthorizer({ database }),
      supervisorOwnerBoundary: new RoutedHttpSupervisorOwnerBoundary(resolveManagementClient),
      assignmentInventoryFactory: (identity) =>
        new RoutedHttpSandboxAssignmentInventory(resolveManagementClient, identity),
      supervisorProvisioningGateway: provisioningGateway,
      turnSteerBackendFactory: resolveSteerBackend,
      productionHttpGateway: httpGateway,
      publicRegistration: registrationConfiguration,
      webAuthentication,
      platformOperatorTenantId: config.platformOperatorTenantId,
      platformModelSourceTenantId: config.platformModelSourceTenantId,
      cubeEgressConfigToken: config.cubeEgressConfigToken,
      workspaceTerminalGateway,
      sandboxPreviewGateway,
      sourceControlService,
      environmentImageRevision: config.environmentImageRevision,
      metrics: observability.metrics,
      workspaceBrowser: {
        listWorkspaceDirectory: (request, signal) =>
          workspaceBrowserClient.listWorkspaceDirectory(request, signal),
        readWorkspaceFile: (request, signal) =>
          workspaceBrowserClient.readWorkspaceFile(request, signal),
      },
      workspaceUploader: {
        uploadWorkspaceFile: (request, bytes, signal) =>
          workspaceBrowserClient.uploadWorkspaceFile(request, bytes, signal),
      },
      ...(images ? { imageAttachmentStore: images.store } : {}),
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
    const activeQueuedInputs = runtime.application.get<QueuedInputService>(QueuedInputService);
    queuedInputs = activeQueuedInputs;
    // Cover changes committed/consumed before the application's handler was attached.
    activeQueuedInputs.recoverPending();
    await sandboxControl.start();
    const sourceControlFailure = (source: string, error: unknown): void =>
      operationalLog({
        service: "pi-cloud-control-plane",
        level: "warn",
        event: "source-control-coordinator.failed",
        attributes: {
          source,
          name: error instanceof Error ? error.name : "UnknownError",
          code:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : "unknown",
          retryable:
            typeof error === "object" &&
            error !== null &&
            "retryable" in error &&
            typeof error.retryable === "boolean"
              ? error.retryable
              : false,
        },
      });
    if (sourceControlService.configured) {
      issueCoordinator = new SourceControlIssueCoordinator({
        database,
        sourceControl: sourceControlService,
        instanceId: controlPlaneInstanceId,
        environmentImageRevision: config.environmentImageRevision,
        onError: sourceControlFailure,
      });
      issueCoordinator.start();
    }
    if (sourceControlService.gitlabConfigured) {
      issueNoteReconciler = new GitLabIssueNoteReconciler({
        database,
        access: (tenantId, installationId) =>
          sourceControlService.gitlabIssueNoteAccess(tenantId, installationId),
        onError: (error) => sourceControlFailure("issue_note_sync", error),
      });
      issueNoteReconciler.start();
    }
    process.stdout.write(
      `PiCloud production control plane listening on ${config.host}:${String(config.port)}\n`,
    );

    const closeAfterSignal = (): void => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", closeAfterSignal);
    process.once("SIGTERM", closeAfterSignal);
  } catch (error: unknown) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Control Plane startup and cleanup failed", {
        cause: error,
      });
    }
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
import { ToolProgressIngress } from "./tool-progress-ingress.ts";
import { RunActivityIngress } from "./run-activity-ingress.ts";
