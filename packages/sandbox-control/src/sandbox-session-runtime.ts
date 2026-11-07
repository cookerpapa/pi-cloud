import type { Database } from "@pi-cloud/database";
import { operationalLog, type PiCloudMetrics } from "@pi-cloud/observability";
import { KafkaToolReplyPublisher, ToolProgressPublisher } from "@pi-cloud/event-log";
import {
  encodeSessionImages,
  type ConfiguredImageAttachments,
} from "@pi-cloud/session-attachments";
import { parseExecutionReference, type AcceptedToolCommand } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { loadSandboxControlConfig } from "./sandbox-control-config.ts";
import { createCubeRuntimeTransport } from "./cube-runtime-transport.ts";
import { PostgresSandboxBindings } from "./sandbox-bindings.ts";
import { SandboxBindingView } from "./sandbox-binding-view.ts";
import { SessionBindingExecution } from "./session-binding-execution.ts";
import { SessionResourceAccess } from "./session-resource-access.ts";
import { SandboxControlServer, type SandboxControlBackend } from "./sandbox-control-server.ts";
import { SandboxControlError } from "./sandbox-provider.ts";
import { PostgresSandboxHttpServiceRegistry } from "./sandbox-http-service-registry.ts";
import { WorkflowCommandDispatcher } from "./workflow-command-dispatcher.ts";
import { ToolCommandDispatcher, type ToolLogDelivery } from "./tool-command-dispatcher.ts";
import { ExecutionPathProbes } from "./execution-path-probes.ts";
import { RuntimeRetention } from "./runtime-retention.ts";
import { quarantineExecutionTarget } from "./runtime-quarantine.ts";
import { relayWorkflowAttachment } from "./workflow-attachment-relay.ts";

/** Session execution only. No resource owner, lifecycle controller or second consumer. */
export async function createSandboxSessionRuntime(options: {
  database: Kysely<Database>;
  publicationDatabase: Kysely<Database>;
  instanceId: string;
  managementToken: string;
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
    const { client, provider } = await createCubeRuntimeTransport(config);
    cleanup.push(() => provider.close());
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
    const execution = new SessionBindingExecution({
      bindings: bindingView,
      provider,
      services: new PostgresSandboxHttpServiceRegistry({ database }),
      ...(options.canStart ? { canStart: options.canStart } : {}),
      ...(options.images ? { images: options.images } : {}),
    });
    cleanup.push(() => execution.close());
    const resources = new SessionResourceAccess(database, provider);
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
    const retention = new RuntimeRetention({
      resolve: async (scope, resource, observedAt) => {
        // Bootstrap each admitted writer/resource reference once; pulses use
        // the resolved physical identity until an ordered binding change.
        let query = database
          .selectFrom("workspace_runtimes")
          .select(["workspace_runtime_id", "runtime_capsule"])
          .where("tenant_id", "=", scope.tenantId)
          .where("workspace_id", "=", resource.workspaceId)
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
      routes: bindingView,
      cube: client,
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
      if (!row || row.dispatch_closed || snapshot?.assignment.executionReference !== reference)
        throw new SandboxControlError("tool_binding_closed", "Tool binding is unavailable", false);
      const owner = await options.ownerForPartition(options.partitionFor(row.pi_session_id));
      if (!owner) return;
      const url = new URL(owner);
      url.port = String(config.port);
      return url.toString();
    };
    const waitBinding = async (id: string, reference: string, signal?: AbortSignal) => {
      const until = Date.now() + 5000;
      for (;;) {
        const owner = await routeBinding(id, reference);
        if (owner) return owner;
        if (bindingView.binding(id)) return;
        if (Date.now() >= until) throw new Error("Binding publication is pending");
        await delay(10, undefined, { signal });
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
        if (!started || closing) throw new Error("Session execution is unavailable");
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
        const owner = await waitBinding(id, reference, signal);
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
    const server = new SandboxControlServer({
      host: config.host,
      port: config.port,
      serviceToken: config.serviceToken,
      terminalToken: config.terminalToken,
      ...(config.workspaceServiceToken
        ? { workspaceServiceToken: config.workspaceServiceToken }
        : {}),
      broker: backend,
      metrics,
      routeBinding: waitBinding,
    });
    cleanup.push(() => server.close());
    await server.listen();
    const route = async (scope: AcceptedToolCommand["scope"], id: string) => {
      const binding = await bindingView.get(scope, id);
      if (!binding || binding.dispatchClosed) throw new Error("Tool binding is unavailable");
      return binding;
    };
    return {
      retention,
      dispatcher,
      probes,
      bindingView,
      resources,
      publishReply: (topic: string, reply: import("@pi-cloud/event-log").ToolReply) =>
        replies.publish(topic, reply),
      exportToolPackage: async (
        scope: AcceptedToolCommand["scope"],
        id: string,
        operationId: string,
        path: string,
        signal?: AbortSignal,
      ) => {
        const binding = await route(scope, id);
        return execution.exportPackage(
          {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.export_package",
            requestId: crypto.randomUUID(),
            activationId: id,
            assignment: binding.snapshot.assignment,
            operationId,
            path,
          },
          signal,
        );
      },
      prepareToolPackage: async (
        scope: AcceptedToolCommand["scope"],
        id: string,
        operationId: string,
        content: import("@pi-cloud/protocol").SkillPackageContent,
        digest: string,
        signal?: AbortSignal,
      ) => {
        const binding = await route(scope, id);
        return execution.preparePackage(
          {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.prepare_package",
            requestId: crypto.randomUUID(),
            activationId: id,
            assignment: binding.snapshot.assignment,
            operationId,
            content,
            digest,
          },
          signal,
        );
      },
      toolImageIo: async (
        scope: AcceptedToolCommand["scope"],
        id: string,
        operationId: string,
        action: Extract<
          import("@pi-cloud/protocol").SandboxControlRequest,
          { type: "tool_sandbox.image_io" }
        >["action"],
        signal?: AbortSignal,
      ) => {
        const binding = await route(scope, id);
        return execution.imageIo(
          {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.image_io",
            requestId: crypto.randomUUID(),
            activationId: id,
            assignment: binding.snapshot.assignment,
            operationId,
            action,
          },
          signal,
        );
      },
      refreshToolServices: async (scope: AcceptedToolCommand["scope"], id: string) => {
        const binding = await route(scope, id);
        return execution.refreshServices(id, binding.snapshot.assignment);
      },
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
