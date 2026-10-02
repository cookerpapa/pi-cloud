import { PostgresNotificationWake, type Database } from "@pi-cloud/database";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import { KafkaToolReplyPublisher, ToolProgressPublisher } from "@pi-cloud/event-log";
import {
  encodeSessionImages,
  type ConfiguredImageAttachments,
} from "@pi-cloud/session-attachments";
import { sql, type Kysely } from "kysely";
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
import { ToolCommandDispatcher, httpToolLogDelivery } from "./tool-command-dispatcher.ts";
import { loadSandboxControlConfig } from "./sandbox-control-config.ts";
import { ExecutionPathProbes } from "./execution-path-probes.ts";
import { executionTargetId } from "./sandbox-execution.ts";
import { RUNTIME_EXECUTION_EVIDENCE_PATH } from "@pi-cloud/protocol";
import { fetch as internalFetch } from "undici";

/** A control-plane module. It has no standalone process, database pool or Run lease. */
export async function createSandboxControl(options: {
  database: Kysely<Database>;
  instanceId: string;
  managementToken: string;
  metrics: PiCloudMetrics;
  images?: ConfiguredImageAttachments;
}) {
  const config = await loadSandboxControlConfig();
  const { database, instanceId, metrics } = options;
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  let providerOwns = false,
    controllerOwns = false,
    serverOwns = false;
  let closing: Promise<void> | undefined;
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
      database,
      config.sandboxDomainId,
      instanceId,
      config.advertisedBaseUrl,
    );
    const controller = new SandboxController({
      bindings,
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
      warmTtlMs: config.warmTtlMs,
      maximumWarmWorkspaceRuntimes: config.maximumWarmWorkspaceRuntimes,
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
        replies.publish(topic, {
          ...reply,
          event: await encodeSessionImages(
            options.images?.codec,
            { tenantId: scope.tenantId, runId: scope.runId },
            reply.event,
          ),
        }),
      maximumActiveCommands: config.maximumActiveCommands,
      metrics,
      progress,
    });
    cleanup.push(() => workflows.close());
    const receive = async (delivery: import("./tool-command-dispatcher.ts").ToolLogDelivery) => {
      ownership.assertLocalOwnership();
      const record = { ...delivery, offset: BigInt(delivery.offset) };
      if (delivery.fact.kind === "execution_seal") {
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
        checkHealth: () => workflows.checkHealth(),
      },
    });
    serverOwns = true;
    cleanup.push(() => server.close());
    const remoteWorkflow = httpToolLogDelivery(options.managementToken);
    const probes = new ExecutionPathProbes({
      routes: bindings,
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
    const dispatcher = new ToolCommandDispatcher({
      onDispatch: (command, route) => probes.rememberTool(command, route),
      routes: bindings,
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
      publishReply: async (topic, reply, scope) =>
        replies.publish(topic, {
          ...reply,
          event: await encodeSessionImages(undefined, { tenantId: scope.tenantId }, reply.event),
        }),
      quarantine: async (target) => {
        // Failed scoped stopping is a control-plane resource decision. Preserve
        // identity/capsule and quota until explicit recovery confirms absence.
        await database.transaction().execute(async (trx) => {
          const affected = await trx
            .updateTable("sandbox_tool_bindings")
            .set({ dispatch_closed: true })
            .returning("snapshot")
            .where(sql<string>`descriptor->'target'->>'sandboxId'`, "=", target.sandboxId)
            .where(sql<string>`descriptor->'target'->>'apiUrl'`, "=", target.apiUrl)
            .where(sql<string>`descriptor->'target'->>'bootId'`, "=", target.bootId)
            .execute();
          const ids = [
            ...new Set(
              affected
                .map((row) => row.snapshot.physicalActivationId)
                .filter((id): id is string => typeof id === "string"),
            ),
          ];
          if (!ids.length) return;
          await trx
            .updateTable("workspace_runtimes")
            .set({
              state: "unknown",
              failure_code: "execution_stop_unconfirmed",
              updated_at: sql<Date>`clock_timestamp()`,
            })
            .where("workspace_runtime_id", "in", ids)
            .where("state", "not in", ["released", "cleaning"])
            .execute();
          await trx
            .updateTable("development_environments")
            .set({
              state: "unknown",
              failure_code: "execution_stop_unconfirmed",
              updated_at: sql<Date>`clock_timestamp()`,
            })
            .where("id", "in", ids)
            .where("state", "not in", ["released", "releasing", "failed"])
            .execute();
        });
        await controller.quarantineExecutionTarget(target);
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
    await controller.recoverPersistentDevelopmentEnvironments();
    await server.listen();
    reaper.start();
    return { controller, dispatcher, probes, close };
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
