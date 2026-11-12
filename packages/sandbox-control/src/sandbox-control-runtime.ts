import { WorkspaceCapacityReconciler } from "./workspace-capacity-reconciler.ts";
import { PostgresNotificationWake, type Database } from "@pi-cloud/database";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import { type ConfiguredImageAttachments } from "@pi-cloud/session-attachments";
import type { Kysely } from "kysely";
import { SandboxControlServer } from "./sandbox-control-server.ts";
import { SandboxController } from "./sandbox-controller.ts";
import { createSandboxRuntimeTransport } from "./sandbox-runtime-transport.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "./workspace-runtime-state-repository.ts";
import { PostgresSandboxHttpServiceRegistry } from "./sandbox-http-service-registry.ts";
import { WorkspaceVolumeDeletionReaper } from "./workspace-volume-deletion-reaper.ts";
import { PostgresSandboxBindings } from "./sandbox-bindings.ts";
import { loadSandboxControlConfig } from "./sandbox-control-config.ts";

/** Management only: owns resource lifecycle; never consumes the Session log. */
export async function createSandboxControl(options: {
  database: Kysely<Database>;
  publicationDatabase: Kysely<Database>;
  instanceId: string;
  managementToken: string;
  metrics: PiCloudMetrics;
  images?: ConfiguredImageAttachments;
  publishBindingChanges(ids: readonly string[]): Promise<void>;
  confirmBindingClosure(ids: readonly string[]): Promise<void>;
  onOwnershipLost(): void;
}) {
  const config = await loadSandboxControlConfig();
  const { database, instanceId, metrics } = options;
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  let controllerOwns = false,
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
      onOwnershipLost: () => {
        started = false;
        try {
          operationalLog({
            service: "pi-cloud-control-plane",
            level: "error",
            event: "sandbox.ownership_lost",
          });
        } finally {
          options.onOwnershipLost();
        }
      },
    });
    cleanup.push(() => (controllerOwns ? undefined : ownership.close()));
    await ownership.start();
    const { volume, provider, persistence, unregisterWorkspaceVolume } =
      await createSandboxRuntimeTransport(config, database, "management");
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
      options.confirmBindingClosure,
    );
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
    const server = new SandboxControlServer({
      retainResources: (uses) => ownership.recordResourceUse(uses),
      host: config.host,
      port: config.port,
      serviceToken: config.serviceToken,
      terminalToken: config.terminalToken,
      ...(config.workspaceServiceToken
        ? { workspaceServiceToken: config.workspaceServiceToken }
        : {}),
      broker: controller,
      metrics,
      executionBaseUrl: new URL(config.sessionExecutionBaseUrl).toString(),
      managementOnly: true,
    });
    serverOwns = true;
    cleanup.push(() => server.close());
    // Session runtime closes admission durably even while management is stopped.
    // Retire the original controller's now-closed logical bindings on its return.
    let bindingCleanup: Promise<void> | undefined;
    const retireBindings = async () => {
      ownership.assertLocalOwnership();
      const rows = await database
        .selectFrom("sandbox_tool_bindings")
        .select(["binding_id", "snapshot", "cancel_outstanding"])
        .where("owner_instance_id", "=", instanceId)
        .where("dispatch_closed", "=", true)
        .orderBy("binding_id")
        .limit(32)
        .execute();
      for (const row of rows) {
        ownership.assertLocalOwnership();
        const snapshot =
          row.snapshot as unknown as import("./sandbox-execution.ts").SandboxBindingSnapshot;
        await controller.release({
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.release",
          requestId: crypto.randomUUID(),
          activationId: row.binding_id,
          assignment: snapshot.assignment,
          disposition: snapshot.developmentEnvironmentId ? "detach" : "keep_warm",
          ...(row.cancel_outstanding ? { cancelOutstanding: true } : {}),
        });
      }
    };
    const bindingTimer = setInterval(() => {
      if (!started || bindingCleanup) return;
      bindingCleanup = retireBindings()
        .catch(() =>
          operationalLog({
            service: "pi-cloud-control-plane",
            level: "warn",
            event: "sandbox.binding_retirement_deferred",
          }),
        )
        .finally(() => {
          bindingCleanup = undefined;
        });
    }, 2000);
    bindingTimer.unref();
    cleanup.push(async () => {
      clearInterval(bindingTimer);
      await bindingCleanup;
    });
    const reaper = new WorkspaceVolumeDeletionReaper({
      database,
      sandboxDomainId: config.sandboxDomainId,
      gateway: persistence,
      deleteVolumeMetadata: unregisterWorkspaceVolume,
      intervalMs: config.workspaceDeletionReaperIntervalMs,
      batchSize: config.workspaceDeletionReaperBatchSize,
    });
    cleanup.push(() => reaper.close());
    const capacityReconciler = new WorkspaceCapacityReconciler(
      database,
      config.sandboxDomainId,
      volume,
    );
    cleanup.push(() => capacityReconciler.close());
    await server.listen();
    return {
      controller,
      close,
      observeMachine: (
        tenantId: string,
        userId: string,
        environmentId: string,
        allocationId: string,
      ) =>
        controller.developmentEnvironmentObservation(tenantId, userId, environmentId, allocationId),
      get ready() {
        if (!started || closing !== undefined) return false;
        try {
          ownership.assertLocalOwnership();
          return true;
        } catch {
          return false;
        }
      },
      start: async () => {
        if (starting) throw new Error("Sandbox control already started");
        starting = true;
        ownership.assertLocalOwnership();
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
        capacityReconciler.start(() =>
          operationalLog({
            service: "pi-cloud-sandbox-control",
            level: "warn",
            event: "workspace.capacity.reconcile_deferred",
          }),
        );
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
