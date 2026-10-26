import { SessionScheduleService } from "./session-schedule-service.ts";
import { SessionScheduleController } from "./session-schedule-controller.ts";
import { runtimeModelCatalog } from "./runtime-model-catalog.ts";
import { SessionPublicationService } from "./session-publication-service.ts";
import { reconcileUploadPins } from "./upload-input-pins.ts";
import { SubagentController } from "./subagent-controller.ts";
import { PlatformRuntimeSettingsService } from "./platform-runtime-settings.ts";
import { ControlToolDispatcher } from "./control-tool-dispatcher.ts";
import { createOrdinaryToolRegistry } from "./ordinary-tools/registry.ts";
import { ExecutionTargetService, ExecutionBindingView } from "./execution-target-service.ts";
import { ExecutionTargetIngress } from "./execution-target-ingress.ts";
import { ExecutorDispatcher } from "./executor-dispatcher.ts";
import { executionToolCatalog } from "./execution-tool-catalog.ts";
import { HttpExecutorTransport } from "@pi-cloud/sandbox-control";
import { ImageGenerationClient } from "./ordinary-tools/image-generation-client.ts";
import { isControlToolName } from "@pi-cloud/protocol";
import { createDatabase } from "@pi-cloud/database";
import { operationalLog, startServiceObservability } from "@pi-cloud/observability";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import {
  HttpSupervisorManagementClient,
  RoutedHttpSandboxAssignmentInventory,
  RoutedHttpSupervisorOwnerBoundary,
} from "./http-supervisor-management.ts";
import { SessionProjector } from "@pi-cloud/runtime-core/session-projector";
import { kafkaProducerLane } from "@pi-cloud/runtime-core/kafka-accepted-fact";
import { SessionControlOutbox } from "@pi-cloud/runtime-core/session-control-outbox";
import { InputQueueView } from "./input-queue-view.ts";
import { readInputQueue } from "./input-queue-snapshot.ts";
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
import { ControlPlaneQuiescence } from "./control-plane-quiescence.ts";

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
  runtimeModelCatalog();
  let ownedObservability: Awaited<ReturnType<typeof startServiceObservability>> | undefined;
  let ownedDatabase: ReturnType<typeof createDatabase> | undefined;
  let ownedMaintenanceDatabase: ReturnType<typeof createDatabase> | undefined;
  let ownedPublicationDatabase: ReturnType<typeof createDatabase> | undefined;
  let ownedProjectionDatabase: ReturnType<typeof createDatabase> | undefined;
  let unattachedSubagents: SubagentController | undefined;
  let unattachedControlTools: ControlToolDispatcher | undefined;
  let controlToolsForQuiescence: ControlToolDispatcher | undefined;
  const controlPlaneInstanceId = randomUUID();
  const quiescence = new ControlPlaneQuiescence(
    controlPlaneInstanceId,
    () => controlToolsForQuiescence?.quiescence() ?? { active: 0, unsettled: 0 },
  );
  let agentEvents: SessionProjector | undefined;
  let sandboxControl: Awaited<ReturnType<typeof createSandboxControl>> | undefined;
  let runtime: ControlPlaneRuntime | undefined;
  let developmentEnvironmentService: DevelopmentEnvironmentService | undefined;
  let operationalMetrics: OperationalMetricsSampler | undefined;
  let issueCoordinator: SourceControlIssueCoordinator | undefined;
  let scheduleController: SessionScheduleController | undefined;
  let issueNoteReconciler: GitLabIssueNoteReconciler | undefined;
  let images: ConfiguredImageAttachments | undefined;
  let imageGeneration: ImageGenerationClient | undefined;
  let imageReaper: ImageAttachmentReaper | undefined;
  let queueDatabase: ReturnType<typeof createDatabase> | undefined;
  let conversationDatabase: ReturnType<typeof createDatabase> | undefined;
  let executorTransport: HttpExecutorTransport | undefined;
  let executorCleanupTimer: ReturnType<typeof setInterval> | undefined;
  let executorCleanup: Promise<void> | undefined;
  let queueViews: InputQueueView | undefined;
  let sourceControlDispatcher: EnvHttpProxyAgent | undefined;
  let internalSourceControlDispatcher: Agent | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    return (closePromise ??= closeControlPlaneResources([
      () => quiescence.close(),
      () => scheduleController?.close(),
      () => imageReaper?.close(),
      () => issueNoteReconciler?.close(),
      () => issueCoordinator?.close(),
      // Relinquish log partitions before potentially long resource drains.
      () => agentEvents?.close(),
      () => queueViews?.close(),
      () => queueDatabase?.destroy(),
      () => runtime?.close(),
      async () => {
        clearInterval(executorCleanupTimer);
        await executorCleanup;
        await executorTransport?.close();
      },
      () => conversationDatabase?.destroy(),
      () => developmentEnvironmentService?.close(),
      () => operationalMetrics?.close(),
      () => sandboxControl?.close(),
      () => unattachedSubagents?.close(),
      () => unattachedControlTools?.close(),
      () => imageGeneration?.close(),
      () => sourceControlDispatcher?.close(),
      () => internalSourceControlDispatcher?.close(),
      () => images?.blobs.close(),
      () => ownedProjectionDatabase?.destroy(),
      () => ownedPublicationDatabase?.destroy(),
      () => ownedMaintenanceDatabase?.destroy(),
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
    const maintenanceDatabase = createDatabase({
      connectionString: config.databaseNotificationUrl,
      maxConnections: 3,
      checkoutTimeoutMs: 5_000,
    });
    ownedMaintenanceDatabase = maintenanceDatabase;
    const publicationDatabase = createDatabase({
      connectionString: config.databaseNotificationUrl,
      maxConnections: 4,
      checkoutTimeoutMs: 5_000,
    });
    ownedPublicationDatabase = publicationDatabase;
    // Projection includes multi-statement handoff checkpoints. Keep its I/O
    // bounded independently of API traffic and the shorter publication budget.
    const projectionDatabase = createDatabase({
      connectionString: config.databaseNotificationUrl,
      maxConnections: 12,
      checkoutTimeoutMs: 30_000,
    });
    ownedProjectionDatabase = projectionDatabase;
    images = await configuredImageAttachments(database);
    if (images) {
      await images.blobs.checkHealth();
      const store = images.store;
      imageReaper = new ImageAttachmentReaper(
        {
          async reap(grace, signal) {
            await reconcileUploadPins(maintenanceDatabase, signal);
            return store.reap(grace, signal);
          },
        },
        () =>
          operationalLog({
            service: "pi-cloud-control-plane",
            level: "error",
            event: "image.cleanup.failed",
          }),
      );
    }
    const controlChanges = new SessionControlOutbox(publicationDatabase, {
      publishControl: async (change) => {
        if (!agentEvents) throw new Error("Session publication is not ready");
        return agentEvents.publishControl(change);
      },
    });
    sandboxControl = await createSandboxControl({
      database,
      publicationDatabase,
      instanceId: controlPlaneInstanceId,
      managementToken: config.supervisorManagementToken,
      metrics: observability.metrics,
      publishBindingChanges: (ids) => controlChanges.flushEntities("sandbox_binding", ids),
      partitionFor: (sessionId) => kafkaProducerLane(sessionId, config.kafkaPartitions),
      partitionCount: config.kafkaPartitions,
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
    });
    unattachedSubagents = subagents;
    if (config.imageGeneration) {
      if (!images) throw new Error("Image generation requires Session attachment storage");
      imageGeneration = new ImageGenerationClient(config.imageGeneration);
    }
    const schedules = new SessionScheduleService({
      database,
      admissionDatabase: maintenanceDatabase,
      environmentImageRevision: config.environmentImageRevision,
    });
    const ordinaryTools = createOrdinaryToolRegistry({
      database,
      schedules,
      ...(config.enabledControlTools ? { enabled: config.enabledControlTools } : {}),
      ...(images ? { images } : {}),
      ...(imageGeneration ? { imageGeneration } : {}),
      imageIo: (call, action, signal) =>
        sandboxControl!.toolImageIo(call.scope, call.bindingId!, call.operationId, action, signal),
      refreshServices: (call) => sandboxControl!.refreshToolServices(call.scope, call.bindingId!),
    });
    const controlTools = new ControlToolDispatcher({
      database,
      partitions: config.kafkaPartitions,
      ...(images ? { images: images.codec } : {}),
      ownsPartition: (partition) => agentEvents?.ownsPartition(partition) === true,
      publish: (topic, reply) => sandboxControl!.publishReply(topic, reply),
      replayable: (name) => isControlToolName(name) || ordinaryTools.replayable(name),
      canStart: () => !quiescence.held,
      execute: async (call, current, signal) => {
        return isControlToolName(call.toolName)
          ? subagents.executeTool(call, current)
          : ordinaryTools.execute(call, current, signal);
      },
      onError: () =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "tool.control_retry",
        }),
    });
    unattachedControlTools = controlTools;
    controlToolsForQuiescence = controlTools;
    const queueReads = createDatabase({
      connectionString: config.databaseUrl,
      maxConnections: 2,
      readTimeoutMs: 5000,
    });
    queueDatabase = queueReads;
    const inputQueues = new InputQueueView({
      read: (tenant, session) => readInputQueue(queueReads, tenant, session),
      watched: (tenant, session) => agentEvents?.eventHub.hasSubscribers(tenant, session) === true,
      publish: (tenant, queue) => agentEvents?.eventHub.publishInputQueue(tenant, queue),
      unavailable: (tenant, session) => agentEvents?.eventHub.resyncSession(tenant, session),
      onError: () =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "input_queue.observation_unavailable",
        }),
    });
    queueViews = inputQueues;
    const { bindingView, consumeBindingChange } = sandboxControl;
    executorTransport = new HttpExecutorTransport(config.supervisorManagementToken);
    const executionTargets = new ExecutionTargetService({
      database,
      transport: executorTransport,
      publish: (ids) => controlChanges.flushEntities("execution_binding", ids),
    });
    const executionBindings = new ExecutionBindingView(executionTargets, config.kafkaPartitions);
    const executorDispatcher = new ExecutorDispatcher({
      cube: sandboxControl.dispatcher,
      routes: executionBindings,
      transport: executorTransport,
      publish: (topic, reply) => sandboxControl!.publishReply(topic, reply),
    });
    executorCleanupTimer = setInterval(() => {
      executorCleanup ??= executionTargets
        .cleanup()
        .catch(() =>
          operationalLog({
            service: "pi-cloud-control-plane",
            level: "warn",
            event: "executor.cleanup_unavailable",
          }),
        )
        .finally(() => {
          executorCleanup = undefined;
        });
    }, 2000);
    executorCleanupTimer.unref();
    agentEvents = new SessionProjector({
      publicationToken: config.supervisorManagementToken,
      projectionGate: quiescence,
      database: projectionDatabase,
      publicationDatabase,
      notificationConnectionString: config.databaseNotificationUrl,
      brokers: config.kafkaBrokers,
      clientId: controlPlaneInstanceId,
      advertisedBaseUrl: config.projectorAdvertisedBaseUrl,
      nativeChanges: {
        consume: async (record, current) => {
          if (current?.() === false) return;
          const fact = record.fact;
          if (fact.kind === "execution_seal" || fact.kind === "work_finished")
            inputQueues.notify(
              fact.scope.tenantId,
              fact.scope.sessionId,
              () => current?.() !== false,
            );
          if (fact.kind === "durable_commit")
            for (const sessionId of fact.inputQueueSessions ?? [])
              inputQueues.notify(fact.scope.tenantId, sessionId, () => current?.() !== false);
        },
        close: () => subagents.close(),
      },
      toolCommands: executorDispatcher,
      controlTools,
      executionProbes: sandboxControl.probes,
      runtimeRetention: sandboxControl.retention,
      controlChanges: {
        load: async (partitions, current) => {
          await bindingView.load(partitions, current);
          if (current()) await executionBindings.load(partitions, current);
          if (current()) await controlTools.recover(partitions, current);
        },
        reset: () => {
          bindingView.reset();
          executionBindings.reset();
          inputQueues.reset();
          subagents.reset();
          controlTools.reset();
        },
        prepare: async (change, current) => {
          await bindingView.prepare(change, current);
          await executionBindings.prepare(change, current);
        },
        consume: async (change, current, position) => {
          await consumeBindingChange(change, current, position);
          await executionBindings.consume(change, current);
          if (current()) controlTools.wake(change.scope.tenantId, change.scope.piSessionId);
          inputQueues.consume(change, current);
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
    unattachedControlTools = undefined;
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
        .innerJoin("workers as sandbox", "sandbox.supervisor_id", "host.supervisor_id")
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
    const resolveNativeInputBackend = async (
      sandboxId: string,
    ): Promise<HttpSupervisorManagementClient> => {
      const identity = await database
        .selectFrom("workers")
        .select(["supervisor_id", "boot_id"])
        .where("id", "=", sandboxId)
        .executeTakeFirst();
      if (identity === undefined) throw new Error("Active Pi Worker identity is unavailable");
      return resolveManagementClient({
        supervisorId: identity.supervisor_id,
        bootId: identity.boot_id,
        sandboxId,
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
      observeMachine: sandboxControl.observeMachine,
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
    const platformRuntimeSettings = new PlatformRuntimeSettingsService({
      database,
      platformOperatorTenantId: config.platformOperatorTenantId,
      internalServiceToken: config.cubeEgressConfigToken,
      onPublicEgress: (publicEgress) =>
        runtime?.gateway.publishRuntimeConfiguration({ publicEgress }),
    });
    conversationDatabase = createDatabase({
      connectionString: config.databaseUrl,
      maxConnections: 4,
      readTimeoutMs: 5000,
    });
    runtime = await createControlPlaneRuntime({
      executionTargets,
      executionTargetIngress: new ExecutionTargetIngress(
        executionTargets,
        config.supervisorManagementToken,
      ),
      conversationReadDatabase: conversationDatabase,
      platformRuntimeSettings,
      gateway: {
        toolCatalog: executionToolCatalog(ordinaryTools),
        runtimeConfiguration: async () => ({
          publicEgress: await platformRuntimeSettings.publicEgress(),
        }),
      },
      sessionPublicationService: new SessionPublicationService(
        config.supervisorManagementToken,
        activeAgentEvents,
        quiescence,
      ),
      runActivityIngress: new RunActivityIngress(
        config.supervisorManagementToken,
        (partition) => activeAgentEvents.ownerForPartition(partition),
        (delivery) => activeAgentEvents.observations.activity(delivery),
        (delivery) => executionProbes.complete(delivery),
        (delivery) => executionProbes.ready(delivery),
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
      connectionManager: { maintenanceDatabase },
      supervisorOwnerBoundary: new RoutedHttpSupervisorOwnerBoundary(resolveManagementClient),
      assignmentInventoryFactory: (identity) =>
        new RoutedHttpSandboxAssignmentInventory(resolveManagementClient, identity),
      supervisorProvisioningGateway: provisioningGateway,
      nativeInputBackendFactory: resolveNativeInputBackend,
      productionHttpGateway: httpGateway,
      publicRegistration: registrationConfiguration,
      webAuthentication,
      platformOperatorTenantId: config.platformOperatorTenantId,
      platformModelSourceTenantId: config.platformModelSourceTenantId,
      cubeEgressConfigToken: config.cubeEgressConfigToken,
      workspaceTerminalGateway,
      sandboxPreviewGateway,
      sourceControlService,
      schedules,
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
    await sandboxControl.start();
    scheduleController = new SessionScheduleController({
      service: schedules,
      notificationConnectionString: config.databaseNotificationUrl,
      canDispatch: () => !quiescence.held,
      guard: (work) => quiescence.run(work),
      onBatch: (value) =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "info",
          event: "schedule.admission.batch",
          attributes: value,
        }),
      onError: () =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "schedule.admission.unavailable",
        }),
    });
    scheduleController.start();

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
      void quiescence
        .beforeShutdown()
        .then(close)
        .catch(() => {
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
