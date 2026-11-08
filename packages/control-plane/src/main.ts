import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { createDatabase } from "@pi-cloud/database";
import { operationalLog, startServiceObservability } from "@pi-cloud/observability";
import { createSandboxControl } from "@pi-cloud/sandbox-control/runtime";
import { HttpPublicationClient } from "@pi-cloud/runtime-core/http-publication-client";
import { SessionControlOutbox } from "@pi-cloud/runtime-core/session-control-outbox";
import { configuredImageAttachments, AttachmentReaper } from "@pi-cloud/session-attachments";
import { reapUnreferencedEntryBodies } from "@pi-cloud/pi-session-postgres/durable";
import { reconcileUploadPins } from "./upload-input-pins.ts";
import { loadProductionControlPlaneConfig } from "./production-config.ts";
import { closeControlPlaneResources } from "./close-resources.ts";
import { runtimeModelCatalog } from "./runtime-model-catalog.ts";
import { ownershipRetirement } from "./ownership-retirement.ts";
import { DevelopmentEnvironmentService } from "./development-environment-service.ts";
import { SessionScheduleService } from "./session-schedule-service.ts";
import { SessionScheduleController } from "./session-schedule-controller.ts";
import { createSourceControlServices } from "./source-control-services.ts";
import { SourceControlIssueCoordinator } from "./source-control-issue-coordinator.ts";
import { GitLabIssueNoteReconciler } from "./gitlab-issue-note-reconciler.ts";
export { closeControlPlaneResources } from "./close-resources.ts";

/** Resource management has no Projector, public API or Worker execution transport. */
export async function startControlPlane(): Promise<void> {
  const config = await loadProductionControlPlaneConfig();
  runtimeModelCatalog();
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= closeControlPlaneResources(cleanup.splice(0).reverse()));
  const startup = Promise.withResolvers<void>();
  const retire = ownershipRetirement({
    startupSettled: startup.promise,
    close,
    fail: () => {
      process.exitCode = 1;
    },
    exit: () => process.exit(1),
    cleanupFailed: () =>
      operationalLog({
        service: "pi-cloud-control-plane",
        level: "error",
        event: "sandbox.owner_retirement_failed",
      }),
  });
  try {
    const observability = await startServiceObservability({
      serviceName: "pi-cloud-control-plane",
      defaultMetricsPort: 9464,
    });
    cleanup.push(() => observability.close());
    const database = createDatabase({ connectionString: config.databaseUrl, maxConnections: 8 });
    cleanup.push(() => database.destroy());
    const publicationDatabase = createDatabase({
      connectionString: config.databaseNotificationUrl,
      maxConnections: 4,
      checkoutTimeoutMs: 5000,
    });
    cleanup.push(() => publicationDatabase.destroy());
    const images = await configuredImageAttachments(database);
    if (images) cleanup.push(() => images.blobs.close());
    const publication = new HttpPublicationClient({
      baseUrl: process.env.PI_CLOUD_CONTROL_PLANE_URL ?? "http://session-runtime:3000",
      token: config.supervisorManagementToken,
    });
    cleanup.push(() => publication.close());
    const changes = new SessionControlOutbox(publicationDatabase, publication);
    const sandbox = await createSandboxControl({
      database,
      publicationDatabase,
      instanceId: randomUUID(),
      managementToken: config.supervisorManagementToken,
      metrics: observability.metrics,
      publishBindingChanges: (ids) => changes.flushEntities("sandbox_binding", ids),
      confirmBindingClosure: (ids) => changes.confirmBindingClosures(ids),
      onOwnershipLost: retire,
      ...(images ? { images } : {}),
    });
    cleanup.push(() => sandbox.close());
    const server = Fastify({ logger: false });
    server.get("/health/live", async () => ({ live: true }));
    server.get("/health/ready", async (_request, reply) =>
      reply.code(sandbox.ready ? 200 : 503).send({ ready: sandbox.ready }),
    );
    cleanup.push(() => server.close());
    await server.listen({ port: config.port, host: config.host });
    await sandbox.start();
    const environments = new DevelopmentEnvironmentService({
      database,
      terminalToken: config.workspaceTerminalToken,
      allowInsecureInternalHttp: config.allowInsecureInternalHttp,
      environmentImageRevision: config.environmentImageRevision,
      observeMachine: sandbox.observeMachine,
    });
    cleanup.push(() => environments.close());
    environments.start();
    const reaper = new AttachmentReaper(
      {
        async reap(grace, signal) {
          await reconcileUploadPins(publicationDatabase, signal);
          await reapUnreferencedEntryBodies(publicationDatabase);
          return images ? images.store.reap(grace, signal) : 0;
        },
      },
      () =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "error",
          event: "image.cleanup.failed",
        }),
    );
    cleanup.push(() => reaper.close());
    const schedules = new SessionScheduleController({
      service: new SessionScheduleService({
        database,
        admissionDatabase: publicationDatabase,
        environmentImageRevision: config.environmentImageRevision,
      }),
      notificationConnectionString: config.databaseNotificationUrl,
      canDispatch: () => sandbox.ready,
      onError: () =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "schedule.admission.unavailable",
        }),
    });
    cleanup.push(() => schedules.close());
    schedules.start();
    const source = createSourceControlServices(database, config);
    cleanup.push(() => source.close());
    const sourceFailure = (source: string, error: unknown) =>
      operationalLog({
        service: "pi-cloud-control-plane",
        level: "warn",
        event: "source-control-coordinator.failed",
        attributes: { source, name: error instanceof Error ? error.name : "UnknownError" },
      });
    if (source.sourceControlService.configured) {
      const issues = new SourceControlIssueCoordinator({
        database,
        sourceControl: source.sourceControlService,
        instanceId: randomUUID(),
        environmentImageRevision: config.environmentImageRevision,
        onError: sourceFailure,
      });
      cleanup.push(() => issues.close());
      issues.start();
    }
    if (source.sourceControlService.gitlabConfigured) {
      const notes = new GitLabIssueNoteReconciler({
        database,
        access: (tenant, installation) =>
          source.sourceControlService.gitlabIssueNoteAccess(tenant, installation),
        onError: (error) => sourceFailure("issue_note_sync", error),
      });
      cleanup.push(() => notes.close());
      notes.start();
    }
    process.stdout.write(
      `PiCloud resource management listening on ${config.host}:${config.port}\n`,
    );
    const stop = () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Management startup failed");
    }
    throw error;
  } finally {
    startup.resolve();
  }
}
const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href)
  startControlPlane().catch((error) => {
    process.stderr.write(
      `PiCloud management failed to start: ${error instanceof Error ? error.message : "unknown startup failure"}\n`,
    );
    process.exitCode = 1;
  });
