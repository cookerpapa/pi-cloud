import { createHash, randomUUID } from "node:crypto";
import PQueue from "p-queue";
import { parseExecutionReference, type ToolSandboxAssignment } from "@pi-cloud/protocol";
import type { ConfiguredImageAttachments } from "@pi-cloud/session-attachments";
import type { SandboxController } from "./sandbox-controller.ts";
import type { SandboxBindingView } from "./sandbox-binding-view.ts";
import type { FixedGuestSandboxProvider } from "./fixed-guest-sandbox-provider.ts";
import type { SandboxBinding } from "./sandbox-bindings.ts";
import { SandboxControlError } from "./sandbox-provider.ts";
import { WorkflowChannels } from "./workflow-channels.ts";
import type { SandboxHttpServiceRegistry } from "./sandbox-http-service-registry.ts";
import type { ToolLogFact } from "./workflow-command-dispatcher.ts";

type Provider = Pick<
  FixedGuestSandboxProvider,
  | "attachExecutionData"
  | "clearExecutionData"
  | "openWorkflow"
  | "preparePackage"
  | "exportPackage"
  | "imageIo"
  | "prepareInputImage"
  | "discoverHttpServices"
>;
type Operation = {
  binding: SandboxBinding;
  controller: AbortController;
  result: Promise<unknown>;
  digest: string;
};
const unavailable = () =>
  new SandboxControlError("tool_binding_closed", "Tool binding is unavailable or closing", false);

/** Executes an existing binding. It cannot allocate, resume, adopt or delete a VM. */
export class SessionBindingExecution {
  readonly #channels = new WorkflowChannels();
  readonly #operations = new Map<string, Operation>();
  readonly #images = new PQueue({ concurrency: 1 });
  readonly #steps = new Map<string, { sequence: number; sha256: string }>();
  #closed = false;
  constructor(
    readonly options: {
      bindings: Pick<SandboxBindingView, "binding">;
      provider: Provider;
      images?: ConfiguredImageAttachments;
      services: SandboxHttpServiceRegistry;
      canStart?(): boolean;
    },
  ) {}

  #binding(id: string, reference: string, assignment?: ToolSandboxAssignment): SandboxBinding {
    const route = this.options.bindings.binding(id);
    if (this.options.canStart?.() === false)
      throw new SandboxControlError(
        "session_execution_held",
        "Session execution is temporarily held for replacement",
        true,
      );
    if (
      this.#closed ||
      !route ||
      route.dispatchClosed ||
      route.snapshot.assignment.executionReference !== reference ||
      (assignment &&
        Object.keys(route.snapshot.assignment).some(
          (key) =>
            route.snapshot.assignment[key as keyof ToolSandboxAssignment] !==
            assignment[key as keyof ToolSandboxAssignment],
        ))
    )
      throw unavailable();
    return route;
  }
  #handle(route: SandboxBinding) {
    const handle = this.options.provider.attachExecutionData(route.descriptor);
    if (
      handle.activationId !== route.snapshot.physicalActivationId ||
      handle.assignment.tenantId !== route.snapshot.assignment.tenantId ||
      handle.assignment.workspaceId !== route.snapshot.assignment.workspaceId
    )
      throw new Error("Binding physical data scope changed");
    return handle;
  }
  ownsToolBinding(id: string): boolean {
    if (this.#closed) return false;
    try {
      const route = this.options.bindings.binding(id);
      return !!route && !route.dispatchClosed;
    } catch {
      // Reset/rebalance withdraws authority before asynchronous replies settle.
      return false;
    }
  }
  #run<T>(
    route: SandboxBinding,
    key: string,
    request: unknown,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const old = this.#operations.get(key);
    if (old) {
      if (old.digest !== digest || old.binding.bindingId !== route.bindingId)
        throw new Error("Tool operation identity conflict");
      return old.result as Promise<T>;
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const result = Promise.resolve().then(() => {
      combined.throwIfAborted();
      this.#binding(route.bindingId, route.snapshot.assignment.executionReference);
      return run(combined);
    });
    const entry = { binding: route, controller, result, digest };
    this.#operations.set(key, entry);
    const forget = () => {
      if (this.#operations.get(key) === entry) this.#operations.delete(key);
    };
    void result.then(forget, forget);
    return result;
  }
  executeWorkflow: SandboxController["executeWorkflow"] = async (
    reference,
    request,
    signal,
    update,
  ) => {
    const route = this.#binding(request.activationId, reference);
    const snapshot = route.snapshot;
    if (
      !snapshot.allowedTools.includes(request.toolName) ||
      request.toolName !== "bash" ||
      request.turnContextSha256 !== snapshot.turnContextSha256 ||
      request.executionContextSha256 !== snapshot.executionContextSha256
    )
      throw new SandboxControlError(
        "tool_context_mismatch",
        "Workflow does not match its granted context",
        false,
      );
    const step = this.#steps.get(route.bindingId);
    if (
      step &&
      (request.stepContextSequence < step.sequence ||
        (request.stepContextSequence === step.sequence &&
          request.stepContextSha256 !== step.sha256))
    )
      throw new SandboxControlError(
        "step_context_mismatch",
        "Workflow used a stale or conflicting Step",
        false,
      );
    this.#steps.set(route.bindingId, {
      sequence: request.stepContextSequence,
      sha256: request.stepContextSha256,
    });
    return this.#run(route, request.operationId, request, signal, async (current) => {
      this.#binding(route.bindingId, route.snapshot.assignment.executionReference);
      const handle = this.#handle(route);
      const stream = await this.options.provider.openWorkflow(handle, {
        script: request.script,
        operationId: request.operationId,
        cwd: route.descriptor.attachment.toolRoot,
      });
      return this.#channels.run(request, stream, current, async (value) =>
        update?.({
          type: "tool_execution_update",
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          args: { script: request.script },
          partialResult: {
            content: [
              { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
            ],
            details: {},
          },
        }),
      );
    });
  };
  attachWorkflow: SandboxController["attachWorkflow"] = async (
    id,
    operation,
    reference,
    send,
    signal,
  ) => {
    this.#binding(id, reference);
    return this.#channels.attach(id, operation, send, signal);
  };
  exportPackage: SandboxController["exportPackage"] = async (request, signal) => {
    const route = this.#binding(
      request.activationId,
      request.assignment.executionReference,
      request.assignment,
    );
    return this.#run<Awaited<ReturnType<SandboxController["exportPackage"]>>>(
      route,
      `export:${request.requestId}`,
      request,
      signal,
      async (current) => {
        this.#binding(route.bindingId, route.snapshot.assignment.executionReference);
        const handle = this.#handle(route);
        const result = await this.options.provider.exportPackage(
          handle,
          {
            cwd: route.descriptor.attachment.toolRoot,
            path: request.path,
          },
          current,
        );
        current.throwIfAborted();
        return {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.package_exported",
          requestId: request.requestId,
          activationId: request.activationId,
          files: result.files,
        };
      },
    );
  };
  preparePackage: SandboxController["preparePackage"] = async (request, signal) => {
    const route = this.#binding(
      request.activationId,
      request.assignment.executionReference,
      request.assignment,
    );
    return this.#run<Awaited<ReturnType<SandboxController["preparePackage"]>>>(
      route,
      `prepare:${request.requestId}`,
      request,
      signal,
      async (current) => {
        this.#binding(route.bindingId, route.snapshot.assignment.executionReference);
        const handle = this.#handle(route);
        const result = await this.options.provider.preparePackage(
          handle,
          {
            cwd: route.descriptor.attachment.toolRoot,
            content: request.content,
            digest: request.digest,
          },
          current,
        );
        current.throwIfAborted();
        return {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.package_prepared",
          requestId: request.requestId,
          activationId: request.activationId,
          path: result.path,
        };
      },
    );
  };
  #image<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (this.#images.size >= 8)
      throw new SandboxControlError(
        "input_image_capacity_exhausted",
        "Image preparation is busy",
        true,
      );
    // Cancellation removes queued work; an admitted job retains its slot until physical I/O returns.
    const waiting = new AbortController();
    const abort = () => waiting.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => waiting.abort(new Error("Image preparation queue timed out")),
      30_000,
    );
    timer.unref();
    if (signal.aborted) abort();
    return this.#images
      .add(
        async () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          signal.throwIfAborted();
          return run();
        },
        { signal: waiting.signal },
      )
      .then((value) => {
        if (value === undefined) throw new Error("Image preparation did not complete");
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      });
  }
  imageIo: SandboxController["imageIo"] = async (request, signal) => {
    const route = this.#binding(
      request.activationId,
      request.assignment.executionReference,
      request.assignment,
    );
    const images = this.options.images?.store;
    if (!images) throw new Error("Image storage is unavailable");
    return this.#run<Awaited<ReturnType<SandboxController["imageIo"]>>>(
      route,
      `image:${request.requestId}`,
      request,
      signal,
      (current) =>
        this.#image(current, async () => {
          this.#binding(route.bindingId, route.snapshot.assignment.executionReference);
          const handle = this.#handle(route);
          const base = {
            cwd: route.descriptor.attachment.toolRoot,
            operationId: request.operationId,
          };
          const prepared =
            request.action.kind === "read"
              ? await this.options.provider.imageIo(
                  handle,
                  { ...base, kind: "read", path: request.action.path },
                  current,
                )
              : await images.withStream(
                  request.assignment.tenantId,
                  request.action.source,
                  (chunks, streamSignal) =>
                    this.options.provider.imageIo(
                      handle,
                      {
                        ...base,
                        kind: "save",
                        chunks,
                        byteLength:
                          request.action.kind === "save" ? request.action.source.byteLength : 0,
                      },
                      streamSignal,
                    ),
                  current,
                );
          current.throwIfAborted();
          const bytes = Buffer.from(prepared.data, "base64");
          if (!bytes.length || bytes.toString("base64") !== prepared.data)
            throw new Error("Invalid prepared image");
          const image = await images.put(
            { tenantId: request.assignment.tenantId, runId: request.assignment.runId },
            bytes,
            "image/png",
            current,
          );
          return {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.image_io_result",
            requestId: request.requestId,
            activationId: request.activationId,
            image,
            ...(prepared.path ? { path: prepared.path } : {}),
            ...(prepared.placementError ? { placementError: prepared.placementError } : {}),
          };
        }),
    );
  };
  prepareInputImages: SandboxController["prepareInputImages"] = async (request, signal) => {
    const route = this.#binding(
      request.activationId,
      request.assignment.executionReference,
      request.assignment,
    );
    const store = this.options.images?.store;
    if (!store) throw new Error("Image storage is unavailable");
    return this.#run<Awaited<ReturnType<SandboxController["prepareInputImages"]>>>(
      route,
      `input:${request.requestId}`,
      request,
      signal,
      (current) =>
        this.#image(current, async () => {
          this.#binding(route.bindingId, route.snapshot.assignment.executionReference);
          const handle = this.#handle(route);
          const images = [];
          for (const source of request.images) {
            current.throwIfAborted();
            const prepared = await store.withStream(
              request.assignment.tenantId,
              source,
              (chunks, sourceSignal) =>
                this.options.provider.prepareInputImage(
                  handle,
                  {
                    chunks,
                    byteLength: source.byteLength,
                    mimeType: source.mimeType,
                  },
                  sourceSignal,
                ),
              current,
            );
            const bytes = Buffer.from(prepared.data, "base64");
            if (!bytes.length || bytes.toString("base64") !== prepared.data)
              throw new Error("Invalid prepared image");
            const image =
              prepared.mimeType === source.mimeType &&
              bytes.length === source.byteLength &&
              createHash("sha256").update(bytes).digest("hex") === source.sha256
                ? source
                : await store.put(
                    { tenantId: request.assignment.tenantId, runId: request.assignment.runId },
                    bytes,
                    prepared.mimeType,
                    current,
                  );
            images.push({ sourceId: source.id, image, hints: [...prepared.hints] });
          }
          current.throwIfAborted();
          return {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.input_images_prepared",
            requestId: request.requestId,
            activationId: request.activationId,
            images,
          };
        }),
    );
  };
  refreshServices: SandboxController["refreshServices"] = async (id, assignment) => {
    const route = this.#binding(id, assignment.executionReference, assignment);
    const handle = this.#handle(route);
    const discovery = await this.options.provider.discoverHttpServices(handle);
    const environment = route.snapshot.developmentEnvironmentId;
    const target = environment
      ? {
          kind: "development_environment" as const,
          targetId: environment,
          developmentEnvironmentId: environment,
          tenantId: assignment.tenantId,
          workspaceId: assignment.workspaceId,
          sessionId: assignment.sessionId,
        }
      : {
          kind: "conversation" as const,
          targetId: assignment.sessionId,
          tenantId: assignment.tenantId,
          workspaceId: assignment.workspaceId,
          sessionId: assignment.sessionId,
        };
    await this.options.services.observe({
      target,
      runtimeId: handle.runtimeId,
      activationId: id,
      operationId: randomUUID(),
      ...discovery,
    });
  };
  async stopWorkflowScope(fact: ToolLogFact): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const operation of this.#operations.values()) {
      if (
        parseExecutionReference(operation.binding.snapshot.assignment.executionReference)
          .leaseId !== fact.scope.writerId ||
        (fact.kind === "binding_close" && operation.binding.bindingId !== fact.bindingId)
      )
        continue;
      operation.controller.abort();
      pending.push(operation.result);
    }
    await Promise.allSettled(pending);
  }
  get activeCount(): number {
    return this.#operations.size;
  }
  async closeBinding(id: string): Promise<void> {
    const pending = [];
    for (const operation of this.#operations.values())
      if (operation.binding.bindingId === id) {
        operation.controller.abort();
        pending.push(operation.result);
      }
    this.#steps.delete(id);
    await Promise.allSettled(pending);
  }
  reset(): void {
    for (const operation of this.#operations.values()) operation.controller.abort();
    this.#steps.clear();
    this.options.provider.clearExecutionData();
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.reset();
    await Promise.allSettled([...this.#operations.values()].map((operation) => operation.result));
  }
}
