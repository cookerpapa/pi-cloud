import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkspaceSeed, encodeWorkspaceBlob } from "@pi-cloud/workspace-runtime";
import {
  parseToolEnvironmentRequest,
  parseExecutionReference,
  type ToolEnvironmentRequest,
  type AcceptedToolCommand,
} from "@pi-cloud/protocol";
import type { SandboxControlClient } from "./sandbox-control-client.ts";
import type { SandboxBinding, SandboxBindingReader } from "./sandbox-bindings.ts";

type Preparation = {
  request: ToolEnvironmentRequest;
  controller: AbortController;
  result: Promise<SandboxBinding>;
};

/** Coordinates a logical binding at its Session partition owner. Lifecycle is
 * still admitted and performed by management. No new durable queue or lease. */
export class ToolEnvironmentCoordinator {
  readonly #preparing = new Map<string, Preparation>();
  #generation = 0;
  constructor(
    readonly options: {
      bindings: Pick<SandboxBindingReader, "get">;
      management: Pick<SandboxControlClient, "create">;
    },
  ) {}

  async ensure(
    scope: AcceptedToolCommand["scope"],
    input: ToolEnvironmentRequest,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<SandboxBinding> {
    const request = parseToolEnvironmentRequest(input);
    if (
      request.assignment.tenantId !== scope.tenantId ||
      request.assignment.runId !== scope.runId ||
      request.assignment.sessionId !== scope.sessionId ||
      request.assignment.turnId !== scope.turnId ||
      request.piSessionId !== scope.piSessionId ||
      parseExecutionReference(request.assignment.executionReference).leaseId !== scope.writerId ||
      parseExecutionReference(request.assignment.executionReference).fencingToken !==
        scope.fencingToken
    )
      throw new Error("Logical environment belongs to another execution");
    signal?.throwIfAborted();
    if (!current()) throw new Error("Environment partition owner changed");
    const existing = await this.options.bindings.get(scope, request.requestId);
    if (existing) {
      if (existing.dispatchClosed) throw new Error("Tool environment binding is closed");
      return existing;
    }
    let pending = this.#preparing.get(request.requestId);
    if (pending && !isDeepStrictEqual(pending.request, request))
      throw new Error("Logical binding changed its frozen environment");
    if (!pending) {
      const generation = this.#generation;
      const controller = new AbortController();
      const valid = () =>
        generation === this.#generation && current() && !controller.signal.aborted;
      const result = (async () => {
        const {
          workspaceSeedKind,
          type: _type,
          piSessionId: _session,
          conversationId: _conversation,
          ...metadata
        } = request;
        const workspaceSeed =
          workspaceSeedKind === "sample_java"
            ? { kind: "sample_java" as const }
            : {
                kind: "bundle" as const,
                bundle: encodeWorkspaceBlob(await createWorkspaceSeed([])),
              };
        if (!valid()) throw new Error("Environment owner retired before preparation");
        let failure: unknown;
        try {
          await this.options.management.create(
            { ...metadata, type: "tool_sandbox.create", workspaceSeed },
            controller.signal,
          );
        } catch (error) {
          failure = error;
        }
        // Publication ACK is not view application. The Kafka loop remains free
        // to consume that binding while this independently awaited preparation runs.
        const until = Date.now() + 5000;
        while (valid() && Date.now() < until) {
          const route = await this.options.bindings.get(scope, request.requestId);
          if (route) {
            if (route.dispatchClosed) throw new Error("Prepared Tool binding was closed");
            return route;
          }
          await delay(20, undefined, { signal: controller.signal });
        }
        throw new Error("Tool environment preparation was not confirmed", { cause: failure });
      })();
      pending = { request: structuredClone(request), controller, result };
      this.#preparing.set(request.requestId, pending);
      const selected = pending;
      void result
        .finally(() => {
          if (this.#preparing.get(request.requestId) === selected)
            this.#preparing.delete(request.requestId);
        })
        .catch(() => {});
    }
    if (!signal) return pending.result;
    let onAbort!: () => void;
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([pending.result, abort]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  reset(): void {
    this.#generation++;
    for (const pending of this.#preparing.values())
      pending.controller.abort(new Error("Environment owner retired"));
    this.#preparing.clear();
  }
  retireWriter(writerId: string): void {
    for (const pending of this.#preparing.values())
      if (
        parseExecutionReference(pending.request.assignment.executionReference).leaseId === writerId
      )
        pending.controller.abort(new Error("Environment writer closed"));
  }
}
