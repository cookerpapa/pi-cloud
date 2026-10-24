import { PostgresNotificationWake, type Database } from "@pi-cloud/database";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import { KafkaToolReplyPublisher, ToolProgressPublisher } from "@pi-cloud/event-log";
import {
  encodeSessionImages,
  type ConfiguredImageAttachments,
} from "@pi-cloud/session-attachments";
import type { Kysely } from "kysely";
import { CubeSandboxProvider } from "./cubesandbox-sandbox-provider.ts";
import { OfficialCubeSandboxRuntimeClient } from "./cubesandbox-runtime-client.ts";
import { SandboxControlServer } from "./sandbox-control-server.ts";
import { SandboxController } from "./sandbox-controller.ts";
import { HttpWorkspaceVolumeGateway } from "./workspace-volume-gateway.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "./workspace-runtime-state-repository.ts";
import { PostgresSandboxHttpServiceRegistry } from "./sandbox-http-service-registry.ts";
import { WorkspaceVolumeDeletionReaper } from "./workspace-volume-deletion-reaper.ts";
import { WorkflowCommandDispatcher } from "./workflow-command-dispatcher.ts";
import { PostgresSandboxBindings } from "./sandbox-bindings.ts";
import { SandboxBindingView } from "./sandbox-binding-view.ts";
import { ToolCommandDispatcher, httpToolLogDelivery } from "./tool-command-dispatcher.ts";
import { loadSandboxControlConfig } from "./sandbox-control-config.ts";
import { quarantineExecutionTarget } from "./runtime-quarantine.ts";
import { ExecutionPathProbes } from "./execution-path-probes.ts";
import { executionTargetId } from "./sandbox-execution.ts";
import { RUNTIME_EXECUTION_EVIDENCE_PATH } from "@pi-cloud/protocol";
import { fetch as internalFetch } from "undici";
import { SandboxControlClient } from "./sandbox-control-client.ts";
import { RuntimeRetention } from "./runtime-retention.ts";

/** A control-plane module. It has no standalone process, database pool or Run lease. */
export async function createSandboxControl(options: {
  database: Kysely<Database>;
  publicationDatabase: Kysely<Database>;
  instanceId: string;
  managementToken: string;
  metrics: PiCloudMetrics;
  images?: ConfiguredImageAttachments;
  publishBindingChanges(ids: readonly string[]): Promise<void>;
  partitionFor(sessionId: string): number;
  partitionCount: number;
}) {
  const config = await loadSandboxControlConfig();
  const { database, instanceId, metrics } = options;
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  let providerOwns = false,
    controllerOwns = false,
    serverOwns = false;
  let closing: Promise<void> | undefined;
  let started = false;
  let starting = false;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      for (const action of cleanup.splice(0).reverse())
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, "Sandbox control cleanup failed", { cause: errors[0] });
    })());
  try {
    const ownership = new PostgresWorkspaceRuntimeStateRepository({
      database,
      sandboxDomainId: config.sandboxDomainId,
      instanceId,
      ownerBaseUrl: config.advertisedBaseUrl,
      leaseMs: config.ownershipLeaseMs,
      heartbeatMs: config.ownershipHeartbeatMs,
    });
    cleanup.push(() => (controllerOwns ? undefined : ownership.close()));
    await ownership.start();
    const cube = config.cubeSandbox;
    const client = new OfficialCubeSandboxRuntimeClient({
      apiUrl: cube.apiUrl,
      apiKey: cube.apiKey,
      executionEndpoints: cube.executionEndpoints,
      proxyNodeIp: cube.proxyNodeIp,
      proxyPort: cube.proxyPort,
      proxyScheme: cube.proxyScheme,
      sandboxDomain: cube.sandboxDomain,
      egressProxyIp: cube.egressProxyHost,
      directPrivateCidrs: [...cube.directPrivateCidrs],
      requestTimeoutMs: cube.requestTimeoutMs,
    });
    cleanup.push(() => (providerOwns ? undefined : client.close()));
    const volume = new HttpWorkspaceVolumeGateway({
      baseUrl: cube.workspaceVolumeGatewayUrl,
      serviceToken: cube.workspaceVolumeGatewayToken,
      requestTimeoutMs: cube.workspaceVolumeGatewayRequestTimeoutMs,
    });
    cleanup.push(() => (providerOwns ? undefined : volume.close()));
    const provider = new CubeSandboxProvider({
      retentionWindowMs: config.elasticRetentionMs,
      templateId: cube.templateId,
      developmentTemplateIds: cube.developmentTemplateIds,
      imageRevision: config.imageRevision,
      persistentStateKey: config.persistentStateKey,
      runtimeClient: client,
      webProxy: {
        host: cube.egressProxyHost,
        port: cube.egressProxyPort,
        directPrivateCidrs: [...cube.directPrivateCidrs],
      },
      workspaceVolumeGateway: volume,
    });
    providerOwns = true;
    cleanup.push(() => (controllerOwns ? undefined : provider.close()));
    const wake = new PostgresNotificationWake(
      config.databaseNotificationUrl,
      "pi_cloud_workspace_cleanup",
    );
    cleanup.push(() => wake.close());
    const bindings = new PostgresSandboxBindings(
      options.publicationDatabase,
      config.sandboxDomainId,
      instanceId,
      config.advertisedBaseUrl,
      options.publishBindingChanges,
    );
    const bindingView = new SandboxBindingView({
      source: bindings,
      partitionFor: options.partitionFor,
      partitionCount: options.partitionCount,
    });
    const controller = new SandboxController({
      elasticRetentionMs: config.elasticRetentionMs,
      bindings,
      controlReady: () => started,
      workspaceCleanupWake: wake,
      ...(options.images ? { inputImages: options.images.store } : {}),
      provider,
      ownerBaseUrl: config.advertisedBaseUrl,
      stateRepository: ownership,
      imageRevision: config.imageRevision,
      maximumActiveSandboxes: config.maximumActiveSandboxes,
      runtimeProbeConcurrency: config.runtimeProbeConcurrency,
      onProbeSample: (stage, ms, outcome) =>
        metrics.sandboxDuration.observe({ operation: `health_${stage}`, outcome }, ms / 1000),
      serviceRegistry: new PostgresSandboxHttpServiceRegistry({ database }),
      onMaintenanceError: () =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "sandbox.maintenance_failed",
        }),
    });
    controllerOwns = true;
    cleanup.push(() => (serverOwns ? undefined : controller.close()));
    const replies = new KafkaToolReplyPublisher(
      config.kafkaBrokers,
      `sandbox-control-${instanceId}`,
    );
    cleanup.push(() => replies.close());
    await replies.start();
    const progress = new ToolProgressPublisher(config.controlPlaneUrl, options.managementToken);
    cleanup.push(() => progress.close());
    const workflows = new WorkflowCommandDispatcher({
      broker: controller,
      publishReply: async (topic, reply, scope) =>
        replies.publish(
          topic,
          reply.kind === "tool_result"
            ? {
                ...reply,
                result: await encodeSessionImages(
                  options.images?.codec,
                  { tenantId: scope.tenantId, runId: scope.runId },
                  reply.result,
                ),
              }
            : reply,
        ),
      maximumActiveCommands: config.maximumActiveCommands,
      metrics,
      progress,
    });
    cleanup.push(() => workflows.close());
    const receive = async (delivery: import("./tool-command-dispatcher.ts").ToolLogDelivery) => {
      ownership.assertLocalOwnership();
      const record = { ...delivery, offset: BigInt(delivery.offset) };
      if (delivery.fact.kind === "execution_seal" || delivery.fact.kind === "binding_close") {
        workflows.consume(record); // Close admission before joining existing hostcalls.
        await controller.stopWorkflowScope(delivery.fact);
      } else workflows.receive(record);
    };
    const server = new SandboxControlServer({
      host: config.host,
      port: config.port,
      serviceToken: config.serviceToken,
      terminalToken: config.terminalToken,
      ...(config.workspaceServiceToken
        ? { workspaceServiceToken: config.workspaceServiceToken }
        : {}),
      broker: controller,
      metrics,
      logDelivery: {
        instanceId,
        token: options.managementToken,
        receive,
        checkHealth: () => {
          if (!started) throw new Error("Sandbox control publication is not ready");
          return workflows.checkHealth();
        },
      },
    });
    serverOwns = true;
    cleanup.push(() => server.close());
    const remoteWorkflow = httpToolLogDelivery(options.managementToken);
    const probes = new ExecutionPathProbes({
      routes: bindingView,
      cube: client,
      sample: (stage, ms, outcome) =>
        metrics.sandboxDuration.observe({ operation: `path_${stage}`, outcome }, ms / 1000),
      diagnostic: (runId, stage, reason) =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "execution.probe_unconfirmed",
          attributes: { runId, stage, reason },
        }),
      runtimeEvidence: async (route, observedAt) => {
        const tenantId = route.snapshot.assignment.tenantId;
        const targetId = executionTargetId(route.descriptor.target);
        if (route.instanceId === instanceId) {
          controller.recordRuntimeEvidence(tenantId, targetId, observedAt);
          return;
        }
        const response = await internalFetch(
          new URL(RUNTIME_EXECUTION_EVIDENCE_PATH, route.baseUrl),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.managementToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ tenantId, targetId, observedAt }),
            signal: AbortSignal.timeout(1000),
          },
        );
        await response.body?.cancel();
      },
    });
    cleanup.push(() => probes.close());
    const retention = new RuntimeRetention({
      resolve: async (scope, resource, observedAt) => {
        // Bootstrap each admitted writer/resource reference once; pulses use
        // the resolved physical identity until an ordered binding change.
        let query = database
          .selectFrom("workspace_runtimes")
          .select(["workspace_runtime_id", "runtime_capsule"])
          .where("tenant_id", "=", scope.tenantId)
          .where("workspace_id", "=", resource.workspaceId)
          .where("sandbox_domain_id", "=", config.sandboxDomainId)
          .where("allocation_closed", "=", false)
          .where("created_at", "<=", new Date(observedAt))
          .where("state", "in", ["allocated"])
          .where("runtime_capsule", "is not", null);
        query = resource.computeSessionId
          ? query.where("compute_session_id", "=", resource.computeSessionId)
          : query.where("compute_session_id", "is", null);
        const row = await query.executeTakeFirst();
        return row?.runtime_capsule
          ? { id: row.workspace_runtime_id, capsule: row.runtime_capsule }
          : undefined;
      },
      renew: async (target, observedAt) => {
        const start = performance.now();
        let outcome = "confirmed";
        try {
          await provider.renewPersistentRetention(target.capsule, observedAt);
        } catch (error) {
          outcome = "unconfirmed";
          throw error;
        } finally {
          metrics.sandboxDuration.observe(
            { operation: "retention_renew", outcome },
            (performance.now() - start) / 1000,
          );
        }
      },
    });
    cleanup.push(() => retention.close());
    const dispatcher = new ToolCommandDispatcher({
      onDispatch: (command, route) => probes.rememberTool(command, route),
      routes: bindingView,
      cube: client,
      metrics,
      workflow: Object.assign(
        (
          route: Pick<import("./sandbox-bindings.ts").SandboxBinding, "instanceId" | "baseUrl">,
          delivery: import("./tool-command-dispatcher.ts").ToolLogDelivery,
        ) =>
          route.instanceId === instanceId ? receive(delivery) : remoteWorkflow(route, delivery),
        { close: () => remoteWorkflow.close() },
      ),
      publishReply: (topic, reply) => replies.publish(topic, reply),
      quarantine: async (target) => {
        // Failed scoped stopping is a control-plane resource decision. Preserve
        // identity/capsule and quota until explicit recovery confirms absence.
        const affectedBindings = await quarantineExecutionTarget(database, target);
        // Both paths run even if one owner cannot confirm publication. PG has
        // already quarantined the target; local admission must close too.
        const outcomes = await Promise.allSettled([
          controller.quarantineExecutionTarget(target),
          options.publishBindingChanges(affectedBindings),
        ]);
        const failures = outcomes.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Runtime quarantine propagation is unconfirmed");
      },
    });
    cleanup.push(() => dispatcher.close());
    const reaper = new WorkspaceVolumeDeletionReaper({
      database,
      sandboxDomainId: config.sandboxDomainId,
      gateway: volume,
      deleteVolumeMetadata: (id) => provider.deleteWorkspaceVolume(id),
      intervalMs: config.workspaceDeletionReaperIntervalMs,
      batchSize: config.workspaceDeletionReaperBatchSize,
    });
    cleanup.push(() => reaper.close());
    await server.listen();
    return {
      controller,
      retention,
      dispatcher,
      publishReply: (topic: string, reply: import("@pi-cloud/event-log").ToolReply) =>
        replies.publish(topic, reply),
      toolImageIo: async (
        scope: import("@pi-cloud/protocol").AcceptedToolCommand["scope"],
        bindingId: string,
        operationId: string,
        action: Extract<
          import("@pi-cloud/protocol").SandboxControlRequest,
          { type: "tool_sandbox.image_io" }
        >["action"],
        signal?: AbortSignal,
      ) => {
        const route = await bindingView.get(scope, bindingId);
        if (!route || route.dispatchClosed) throw new Error("Image Tool binding is unavailable");
        const request = {
          toolBrokerProtocolVersion: 1 as const,
          type: "tool_sandbox.image_io" as const,
          requestId: crypto.randomUUID(),
          activationId: bindingId,
          assignment: route.snapshot.assignment,
          operationId,
          action,
        };
        if (route.instanceId === instanceId) return controller.imageIo(request, signal);
        const remote = new SandboxControlClient({
          baseUrl: route.baseUrl,
          serviceToken: config.serviceToken,
          allowInsecureHttp: true,
          requestTimeoutMs: 120_000,
        });
        return remote.imageIo(request, signal);
      },
      refreshToolServices: async (
        scope: import("@pi-cloud/protocol").AcceptedToolCommand["scope"],
        bindingId: string,
      ) => {
        const route = await bindingView.get(scope, bindingId);
        if (!route || route.dispatchClosed) throw new Error("Preview Tool binding is unavailable");
        if (route.instanceId === instanceId) {
          await controller.refreshServices(bindingId, route.snapshot.assignment);
        } else {
          const remote = new SandboxControlClient({
            baseUrl: route.baseUrl,
            serviceToken: config.serviceToken,
            allowInsecureHttp: true,
          });
          await remote.refreshServices(bindingId, route.snapshot.assignment);
        }
      },
      probes,
      bindingView,
      consumeBindingChange: async (
        change: import("@pi-cloud/protocol").SessionControlChange,
        current: () => boolean,
        position: import("@pi-cloud/protocol").ExecutionLogPosition,
      ) => {
        await bindingView.consume(change, current);
        if (change.entity === "sandbox_binding")
          retention.invalidateSession(change.scope.tenantId, change.scope.piSessionId);
        if (change.entity !== "sandbox_binding" || !change.closed || !current()) return;
        await dispatcher.cancelRetiredBinding(change, position, current);
        const route = bindingView.closure(change, current);
        if (!route) return; // Its controller already retired the local workflow channel.
        await dispatcher.closeWorkflowBinding(change, route, position, current);
      },
      close,
      observeMachine: (
        tenantId: string,
        userId: string,
        environmentId: string,
        allocationId: string,
      ) =>
        controller.developmentEnvironmentObservation(tenantId, userId, environmentId, allocationId),
      get ready() {
        return started && closing === undefined;
      },
      start: async () => {
        if (starting) throw new Error("Sandbox control already started");
        starting = true;
        provider.startUploadMaintenance(() =>
          operationalLog({
            service: "pi-cloud-sandbox-control",
            level: "warn",
            event: "upload.staging.cleanup_deferred",
          }),
        );
        started = true;
        void controller.recoverPersistentDevelopmentEnvironments().catch(() =>
          operationalLog({
            service: "pi-cloud-control-plane",
            level: "warn",
            event: "sandbox.recovery_deferred",
          }),
        );
        reaper.start();
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure],
        "Sandbox control startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
