import type { Database } from "@pi-cloud/database";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import {
  KafkaToolReplyPublisher,
  ToolProgressPublisher,
  toolReplyTopic,
} from "@pi-cloud/event-log";
import {
  encodeSessionImages,
  type ConfiguredImageAttachments,
} from "@pi-cloud/session-attachments";
import { parseExecutionReference } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { loadSandboxControlConfig } from "./sandbox-control-config.ts";
import { createCubeRuntimeTransport } from "./cube-runtime-transport.ts";
import { PostgresSandboxBindings } from "./sandbox-bindings.ts";
import { SandboxBindingView } from "./sandbox-binding-view.ts";
import { SessionBindingExecution } from "./session-binding-execution.ts";
import { SessionResourceAccess } from "./session-resource-access.ts";
import { executionTargetId } from "./sandbox-execution.ts";
import { SandboxControlServer, type SandboxControlBackend } from "./sandbox-control-server.ts";
import { SandboxControlError } from "./sandbox-provider.ts";
import { PostgresSandboxHttpServiceRegistry } from "./sandbox-http-service-registry.ts";
import { WorkflowCommandDispatcher } from "./workflow-command-dispatcher.ts";
import { ToolCommandDispatcher, type ToolLogDelivery } from "./tool-command-dispatcher.ts";
import { CubeSandboxToolExecutor } from "./cubesandbox-tool-executor.ts";
import { ToolEnvironmentCoordinator } from "./tool-environment-coordinator.ts";
import { EnvironmentRecovery } from "./environment-recovery.ts";
import { SandboxControlClient } from "./sandbox-control-client.ts";
import { ExecutionPathProbes } from "./execution-path-probes.ts";
import { RuntimeRetention } from "./runtime-retention.ts";
import { SessionActivityRetention } from "./session-activity-retention.ts";
import { ToolCompletionIssuer } from "./tool-completion-issuer.ts";
import { readFile } from "node:fs/promises";
import { quarantineExecutionTarget } from "./runtime-quarantine.ts";
import { relayWorkflowAttachment } from "./workflow-attachment-relay.ts";

/** Session execution only. No resource owner, lifecycle controller or second consumer. */
export async function createSandboxSessionRuntime(options: {
  database: Kysely<Database>;
  publicationDatabase: Kysely<Database>;
  instanceId: string;
  managementToken: string;
  managementBaseUrls?: readonly string[];
  metrics: PiCloudMetrics;
  images?: ConfiguredImageAttachments;
  publishBindingChanges(ids: readonly string[]): Promise<void>;
  partitionFor(id: string): number;
  partitionCount: number;
  ownerForPartition(partition: number): Promise<string | undefined>;
  canStart?(): boolean;
}) {
  const config = await loadSandboxControlConfig();
  const { database, instanceId, metrics } = options;
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  let closing: Promise<void> | undefined;
  let started = false;
  const close = () =>
    (closing ??= (async () => {
      started = false;
      const errors: unknown[] = [];
      for (const action of cleanup.splice(0).reverse()) {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Session execution cleanup failed");
    })());
  try {
    const { client, provider } = await createCubeRuntimeTransport(config, database);
    cleanup.push(() => provider.close());
    const completion = new ToolCompletionIssuer({
      url:
        process.env.PI_CLOUD_TOOL_COMPLETION_URL ?? "https://tool-completion:4320/v1/completions",
      ca: await readFile(
        process.env.PI_CLOUD_COMPLETION_CA_FILE ?? "/run/pi-cloud-completion/ca.crt",
        "utf8",
      ),
      secret: options.managementToken,
    });
    const bindings = new PostgresSandboxBindings(
      options.publicationDatabase,
      config.sandboxDomainId,
      instanceId,
      config.advertisedBaseUrl,
      options.publishBindingChanges,
      async () => {
        throw new Error("Physical closure belongs to resource management");
      },
    );
    let activity: SessionActivityRetention | undefined;
    const bindingView = new SandboxBindingView({
      onBinding: (binding) => activity?.remember(binding),
      source: bindings,
      partitionFor: options.partitionFor,
      partitionCount: options.partitionCount,
    });
    const execution = new SessionBindingExecution({
      bindings: bindingView,
      provider,
      services: new PostgresSandboxHttpServiceRegistry({ database }),
      ...(options.canStart ? { canStart: options.canStart } : {}),
      ...(options.images ? { images: options.images } : {}),
    });
    cleanup.push(() => execution.close());
    let nextManagement = 0;
    const environments = new ToolEnvironmentCoordinator({
      bindings: bindingView,
      management: {
        create: (request, signal) => {
          const urls = options.managementBaseUrls ?? [];
          if (!urls.length) throw new Error("Sandbox management endpoint is unavailable");
          const client = new SandboxControlClient({
            baseUrl: urls[nextManagement++ % urls.length]!,
            serviceToken: config.serviceToken,
            allowInsecureHttp: true,
            requestTimeoutMs: 360_000,
          });
          return client.create(request, signal);
        },
      },
    });
    cleanup.push(() => environments.reset());

    const replies = new KafkaToolReplyPublisher(
      config.kafkaBrokers,
      `session-runtime-${instanceId}`,
    );
    cleanup.push(() => replies.close());
    await replies.start();
    const progress = new ToolProgressPublisher(config.controlPlaneUrl, options.managementToken);
    cleanup.push(() => progress.close());
    const workflows = new WorkflowCommandDispatcher({
      broker: execution,
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
    const receive = async (delivery: ToolLogDelivery) => {
      const record = { ...delivery, offset: BigInt(delivery.offset) };
      if (delivery.fact.kind === "execution_seal" || delivery.fact.kind === "binding_close") {
        workflows.consume(record);
        await execution.stopWorkflowScope(delivery.fact);
      } else workflows.receive(record);
    };
    const probes = new ExecutionPathProbes({
      routes: bindingView,
      cube: client,
      completion,
      sample: (stage, ms, outcome) =>
        metrics.sandboxDuration.observe({ operation: `path_${stage}`, outcome }, ms / 1000),
      diagnostic: (runId, stage, reason) =>
        operationalLog({
          service: "pi-cloud-session-runtime",
          level: "warn",
          event: "execution.probe_unconfirmed",
          attributes: { runId, stage, reason },
        }),
      // Disposable runtime evidence must never require a lifecycle-owner round trip.
      runtimeEvidence: async () => {},
    });
    cleanup.push(() => probes.close());
    let nextRetentionManager = 0;
    const retentionManagers = (options.managementBaseUrls ?? []).map(
      (baseUrl) =>
        new SandboxControlClient({
          baseUrl,
          serviceToken: config.serviceToken,
          allowInsecureHttp: true,
          requestTimeoutMs: 5000,
        }),
    );
    const retention = new RuntimeRetention({
      renew: async (uses) => {
        const startedAt = performance.now();
        let outcome = "recorded";
        const manager = retentionManagers[nextRetentionManager++ % retentionManagers.length];
        try {
          if (!manager) throw new Error("Resource management endpoint is unavailable");
          await manager.retainResources(uses);
        } catch (error) {
          outcome = "unconfirmed";
          throw error;
        } finally {
          metrics.sandboxDuration.observe(
            { operation: "retention_delivery", outcome },
            (performance.now() - startedAt) / 1000,
          );
        }
      },
    });
    const resources = new SessionResourceAccess(database, provider, retention);
    cleanup.push(() => retention.close());
    activity = new SessionActivityRetention({
      retention,
      read: async (tenantId, use) => {
        const row = await database
          .selectFrom("workspace_runtimes")
          .select(["workspace_runtime_id"])
          .where("tenant_id", "=", tenantId)
          .where("workspace_id", "=", use.workspaceId)
          .where(
            "compute_session_id",
            use.computeSessionId ? "=" : "is",
            use.computeSessionId ?? null,
          )
          .where("state", "=", "allocated")
          .where("allocation_closed", "=", false)
          .where("runtime_capsule", "is not", null)
          .executeTakeFirst();
        return row
          ? { id: row.workspace_runtime_id, tenantId, kind: "workspace" as const }
          : undefined;
      },
    });
    const sessionActivity = activity;
    cleanup.push(() => sessionActivity.close());
    const dispatcher = new ToolCommandDispatcher({
      routes: bindingView,
      executor: new CubeSandboxToolExecutor(client, completion),
      environments,
      metrics,
      onDispatch: (command, route) => probes.rememberTool(command, route),
      workflow: (_route, delivery) => receive(delivery),
      publishReply: (topic, reply) => replies.publish(topic, reply),
      quarantine: async (target) => {
        const ids = await quarantineExecutionTarget(database, target);
        await options.publishBindingChanges(ids);
      },
    });
    cleanup.push(() => dispatcher.close());
    const routeBinding = async (id: string, reference: string) => {
      const local = bindingView.binding(id);
      if (local) {
        if (local.dispatchClosed || local.snapshot.assignment.executionReference !== reference)
          throw new SandboxControlError(
            "tool_binding_closed",
            "Tool binding is unavailable",
            false,
          );
        return;
      }
      // Only routing/bootstrap consults PG. The partition owner authorizes
      // admitted execution through its prepared binding view.
      const identity = parseExecutionReference(reference);
      const row = await database
        .selectFrom("sandbox_tool_bindings")
        .select(["pi_session_id", "snapshot", "dispatch_closed"])
        .where("binding_id", "=", id)
        .where("writer_id", "=", identity.leaseId)
        .where("run_id", "=", identity.runId)
        .executeTakeFirst();
      const snapshot = row?.snapshot as unknown as
        import("./sandbox-execution.ts").SandboxBindingSnapshot | undefined;
      if (!row)
        throw new SandboxControlError(
          "tool_binding_pending",
          "Logical environment is not prepared yet",
          true,
        );
      if (row.dispatch_closed || snapshot?.assignment.executionReference !== reference)
        throw new SandboxControlError("tool_binding_closed", "Tool binding is unavailable", false);
      const owner = await options.ownerForPartition(options.partitionFor(row.pi_session_id));
      if (!owner) return;
      const url = new URL(owner);
      url.port = String(config.port);
      return url.toString();
    };
    const waitBinding = async (
      id: string,
      reference: string,
      signal?: AbortSignal,
      timeoutMs = 5000,
    ) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        try {
          const owner = await routeBinding(id, reference);
          if (owner) return owner;
          if (bindingView.binding(id)) return;
        } catch (error) {
          if (!(error instanceof SandboxControlError) || error.code !== "tool_binding_pending")
            throw error;
        }
        if (Date.now() >= until) throw new Error("Binding publication is pending");
        await delay(100, undefined, { signal });
      }
    };
    const managementRequired = async (): Promise<never> => {
      throw new SandboxControlError(
        "management_required",
        "Resource lifecycle requires management",
        true,
      );
    };
    const backend: SandboxControlBackend = {
      providerId: provider.providerId,
      activeCount: 0,
      admittedCount: 0,
      admissionWaitingCount: 0,
      maximumActiveSandboxes: null,
      cleanPrewarmCount: 0,
      checkHealth: async () => {
        if (closing) throw new Error("Session execution is unavailable");
      },
      close: () => execution.close(),
      create: managementRequired,
      listAssignments: managementRequired,
      terminateAndConfirmAbsent: managementRequired,
      confirmAbsent: managementRequired,
      listWorkspaceDirectory: resources.listWorkspaceDirectory,
      readWorkspaceFile: resources.readWorkspaceFile,
      openPreviewConnection: resources.openPreviewConnection,
      refreshServices: execution.refreshServices,
      imageIo: execution.imageIo,
      prepareInputImages: execution.prepareInputImages,
      preparePackage: execution.preparePackage,
      exportPackage: execution.exportPackage,
      release: async (request) => {
        if (request.disposition === "destroy") return managementRequired();
        // Ordinary retirement closes routing only; lifecycle cleanup remains with management.
        await bindings.closeBinding(
          request.activationId,
          request.assignment,
          request.cancelOutstanding === true,
        );
        return {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.released",
          requestId: request.requestId,
          activationId: request.activationId,
          retained: true,
        };
      },
      attachWorkflow: async (id, operation, reference, send, signal) => {
        const owner = await waitBinding(id, reference, signal, 360_000);
        return owner
          ? relayWorkflowAttachment({
              baseUrl: owner,
              activationId: id,
              operationId: operation,
              executionReference: reference,
              send,
              signal,
            })
          : execution.attachWorkflow(id, operation, reference, send, signal);
      },
    };
    const environmentOwner = async (id: string) => {
      if (bindingView.owner(id)) return;
      const owner = await options.ownerForPartition(options.partitionFor(id));
      if (!owner)
        throw new SandboxControlError(
          "environment_owner_pending",
          "Session partition is unavailable",
          true,
        );
      const url = new URL(owner);
      url.port = String(config.port);
      return url.toString();
    };
    const recovery = new EnvironmentRecovery({
      database,
      environments,
      owner: (id) => bindingView.owner(id),
      probe: async (binding) => {
        await client.probeExecution(binding.descriptor.target, crypto.randomUUID());
      },
    });
    const server = new SandboxControlServer({
      host: config.host,
      port: config.port,
      serviceToken: config.serviceToken,
      terminalToken: config.terminalToken,
      ...(config.workspaceServiceToken
        ? { workspaceServiceToken: config.workspaceServiceToken }
        : {}),
      broker: backend,
      readiness: () => started && !closing,
      metrics,
      routeBinding: waitBinding,
      environmentRecovery: {
        route: environmentOwner,
        recover: (environment, signal) => recovery.recover(environment, signal),
      },
      environmentImages: {
        route: environmentOwner,
        prepare: async ({ environment, images }, signal) => {
          const current = bindingView.owner(environment.piSessionId);
          if (!current) throw new Error("Session partition owner changed");
          const assignment = environment.assignment;
          const identity = parseExecutionReference(assignment.executionReference);
          const scope = {
            tenantId: assignment.tenantId,
            sessionId: assignment.sessionId,
            turnId: assignment.turnId,
            runId: identity.runId,
            writerId: identity.leaseId,
            fencingToken: identity.fencingToken,
            piSessionId: environment.piSessionId,
          };
          const binding = await environments.ensure(scope, environment, current, signal);
          signal.throwIfAborted();
          if (!current()) throw new Error("Input preparation owner changed");
          const prepared = await execution.prepareInputImages(
            {
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.prepare_input_images",
              requestId: crypto.randomUUID(),
              activationId: binding.bindingId,
              assignment,
              images,
            },
            signal,
          );
          return {
            images: prepared.images,
            execution: {
              bindingId: binding.bindingId,
              targetId: executionTargetId(binding.descriptor.target),
              bootId: binding.descriptor.target.bootId,
              continuityId: binding.snapshot.physicalActivationId,
              ...(binding.snapshot.continuity ? { continuity: binding.snapshot.continuity } : {}),
              observedAt: Date.now(),
            },
          };
        },
      },
    });
    cleanup.push(() => server.close());
    await server.listen();
    return {
      retention,
      sessionActivity,
      dispatcher,
      probes,
      bindingView,
      resources,
      environments,
      publishReply: (topic: string, reply: import("@pi-cloud/event-log").ToolReply) =>
        replies.publish(topic, reply),
      consumeBindingChange: async (
        change: import("@pi-cloud/protocol").SessionControlChange,
        current: () => boolean,
        position: import("@pi-cloud/protocol").ExecutionLogPosition,
      ) => {
        await bindingView.consume(change, current);
        if (change.entity !== "sandbox_binding" || !change.closed || !current()) return;
        await dispatcher.cancelRetiredBinding(change, position, current);
        // Interactive channels belong to this Projector, independent of resource-owner liveness.
        workflows.consume({
          fact: {
            kind: "binding_close",
            bindingId: change.entityId,
            scope: {
              runId: change.runId,
              writerId:
                change.cancelTarget?.writerId ??
                bindingView.binding(change.entityId)?.writerId ??
                "",
            },
          },
          topic: position.topic,
          partition: position.partition,
          offset: BigInt(position.offset),
        });
        await execution.closeBinding(change.entityId);
        // Routing withdrawal is authoritative; a missing probe is not. Deliver
        // this rare control observation through the existing Worker mailbox.
        const owner = await database
          .selectFrom("active_execution_scopes as e")
          .innerJoin("workers as w", "w.id", "e.worker_id")
          .select([
            "e.tenant_id",
            "e.pi_session_id",
            "e.session_id",
            "e.turn_id",
            "e.run_id",
            "e.writer_id",
            "e.fencing_token",
            "w.boot_id",
          ])
          .where("e.tenant_id", "=", change.scope.tenantId)
          .where("e.pi_session_id", "=", change.scope.piSessionId)
          .where("e.run_id", "=", change.runId)
          .where("e.accepting_effects", "=", true)
          .where("e.valid_until", ">", sql<Date>`clock_timestamp()`)
          .executeTakeFirst();
        if (owner && current())
          await replies.publish(toolReplyTopic(owner.boot_id), {
            kind: "environment_changed",
            changeId: change.factId,
            bindingId: change.entityId,
            scope: {
              tenantId: owner.tenant_id,
              piSessionId: owner.pi_session_id,
              sessionId: owner.session_id,
              turnId: owner.turn_id,
              runId: owner.run_id,
              writerId: owner.writer_id,
              fencingToken: Number(owner.fencing_token),
            },
          });
      },
      quiescence: () => ({
        active: execution.activeCount + workflows.statistics().activeCommands,
        unsettled: 0,
      }),
      reset: () => execution.reset(),
      get ready() {
        return started && !closing;
      },
      start: async () => {
        if (closing) throw new Error("Session execution is closing");
        started = true;
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Session execution startup failed");
    }
    throw error;
  }
}
