import { isDeepStrictEqual } from "node:util";
import {
  EXECUTION_PROBE_TIMEOUT_MS,
  RUN_OBSERVATION_STALE_MS,
  parseExecutionReference,
  type ExecutionObservationDelivery,
  type ExecutionPathStatus,
  type RuntimeObservationScope,
  type PathProbe,
  type ProbeBinding,
  type AcceptedToolCommand,
} from "@pi-cloud/protocol";
import { TOOL_REPLY_TOPIC_PATTERN } from "@pi-cloud/event-log";
import type { SandboxBinding, SandboxBindingReader } from "./sandbox-bindings.ts";
import type { CubeSandboxRuntimeClient } from "./cubesandbox-runtime-client.ts";
import { CubeExecutionRejected } from "./cubesandbox-runtime-client.ts";
import { executionTargetId } from "./sandbox-execution.ts";
import PQueue from "p-queue";

type Bound = { scope: RuntimeObservationScope; route: SandboxBinding; touched: number };
type Pending = Bound & {
  probeId: string;
  sentAt: number;
  accepted: boolean;
  done: boolean;
  measurement?: { recorded: boolean };
};
export type ExecutionProbeObserver = {
  active(scope: RuntimeObservationScope, partition?: number): boolean;
  targets(writerId: string, bindings: readonly ProbeBinding[], sentAt: number): void;
  status(scope: RuntimeObservationScope, status: ExecutionPathStatus): void;
};

/** Observation routing alongside the Projector. No partition callback awaits
 * these requests and no outcome changes Run or physical-resource authority. */
export class ExecutionPathProbes {
  #observer: ExecutionProbeObserver | undefined;
  readonly #bindings = new Map<string, Bound>();
  readonly #pending = new Map<string, Pending>();
  readonly #families = new Map<string, number>();
  readonly #physical = new Map<string, number>();
  readonly #active = new Set<Promise<unknown>>();
  readonly #handoffs = new PQueue({ concurrency: 4 });
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  #generation = 0;
  constructor(
    readonly options: {
      routes: SandboxBindingReader;
      cube: Pick<CubeSandboxRuntimeClient, "submitProbe">;
      runtimeEvidence(route: SandboxBinding, observedAt: number): Promise<void>;
      sample?(stage: "handoff" | "round_trip", durationMs: number, outcome: string): void;
      diagnostic?(runId: string, stage: "projector" | "cube", reason: string): void;
      clock?: () => number;
    },
  ) {
    this.#timer = setInterval(() => this.sweep(), 1000);
    this.#timer.unref();
  }
  observeWith(observer: ExecutionProbeObserver): void {
    this.#observer = observer;
  }
  reset(): void {
    this.#generation++;
    this.#pending.clear();
    this.#bindings.clear();
    this.#families.clear();
    this.#physical.clear();
  }
  #now(): number {
    return (this.options.clock ?? Date.now)();
  }
  #key(id: string, binding: string): string {
    return `${id}:${binding}`;
  }
  #valid(scope: RuntimeObservationScope, partition?: number): boolean {
    return !this.#closed && this.#observer?.active(scope, partition) === true;
  }
  rememberTool(command: AcceptedToolCommand, route: SandboxBinding): void {
    const scope = command.scope;
    if (this.#closed || this.#bindings.size >= 65_536) return;
    this.#bindings.set(route.bindingId, { scope, route, touched: this.#now() });
    if (this.#valid(scope))
      this.#observer!.status(scope, {
        status: "pending",
        stage: "projector",
        bindingId: route.bindingId,
        targetId: executionTargetId(route.descriptor.target),
        sentAt: Date.parse(command.occurredAt),
      });
  }
  consume(fact: PathProbe, current: () => boolean = () => true): void {
    const generation = this.#generation;
    const owns = () => current() && generation === this.#generation;
    const at = Date.parse(fact.occurredAt),
      now = this.#now();
    if (
      !this.#valid(fact.scope) ||
      !current() ||
      at < now - RUN_OBSERVATION_STALE_MS ||
      at > now + 5000 ||
      at <= (this.#families.get(fact.scope.writerId) ?? -1)
    )
      return;
    this.#families.set(fact.scope.writerId, at);
    const bindings = fact.execution?.bindings ?? [];
    if (
      bindings.some(
        ({ scope }) =>
          scope.writerId !== fact.scope.writerId ||
          scope.tenantId !== fact.scope.tenantId ||
          scope.piSessionId !== fact.scope.piSessionId ||
          scope.fencingToken !== fact.scope.fencingToken,
      )
    )
      return;
    this.#observer!.targets(fact.scope.writerId, bindings, at);
    const requested = bindings.filter((binding) => binding.probe && this.#valid(binding.scope));
    if (
      !requested.length ||
      !fact.execution ||
      !TOOL_REPLY_TOPIC_PATTERN.test(fact.execution.replyTopic)
    )
      return;
    if (this.#active.size >= 8 || at < now - EXECUTION_PROBE_TIMEOUT_MS) {
      for (const binding of requested)
        this.#observer!.status(binding.scope, {
          status: "unavailable",
          stage: "projector",
          bindingId: binding.bindingId,
          sentAt: at,
        });
      return;
    }
    const work = this.#dispatch(fact, requested, owns)
      .catch(() => {
        for (const binding of requested)
          if (owns() && this.#valid(binding.scope))
            this.#observer!.status(binding.scope, {
              status: "unavailable",
              stage: "projector",
              bindingId: binding.bindingId,
              sentAt: at,
            });
      })
      .finally(() => this.#active.delete(work));
    this.#active.add(work);
  }
  async #dispatch(
    fact: PathProbe,
    bindings: ProbeBinding[],
    current: () => boolean,
  ): Promise<void> {
    const routes = await Promise.all(
      bindings.map((binding) => this.options.routes.get(binding.scope, binding.bindingId)),
    );
    const sentAt = Date.parse(fact.occurredAt);
    if (!current() || !this.#valid(fact.scope) || this.#now() - sentAt > EXECUTION_PROBE_TIMEOUT_MS)
      return;
    const groups = new Map<string, Pending[]>();
    for (const [index, binding] of bindings.entries()) {
      if (!this.#valid(binding.scope)) continue;
      const found = routes[index];
      const route = found?.dispatchClosed ? undefined : found;
      const identity =
        route && parseExecutionReference(route.snapshot.assignment.executionReference);
      if (
        !route ||
        identity?.runId !== binding.scope.runId ||
        identity.leaseId !== binding.scope.writerId ||
        identity.fencingToken !== binding.scope.fencingToken
      ) {
        this.#observer!.status(binding.scope, {
          status: "unavailable",
          stage: "projector",
          bindingId: binding.bindingId,
          sentAt,
        });
        continue;
      }
      const pending: Pending = {
        scope: binding.scope,
        route,
        touched: this.#now(),
        probeId: fact.factId,
        sentAt,
        accepted: false,
        done: false,
      };
      if (this.#pending.size >= 4096) continue;
      this.#bindings.set(binding.bindingId, pending);
      this.#pending.set(this.#key(fact.factId, binding.bindingId), pending);
      const id = executionTargetId(route.descriptor.target),
        group = groups.get(id) ?? [];
      group.push(pending);
      groups.set(id, group);
      this.#observer!.status(binding.scope, {
        status: "pending",
        stage: "projector",
        bindingId: binding.bindingId,
        targetId: id,
        sentAt,
      });
    }
    // A physical Session may use several compute scopes; bindings sharing a VM
    // share one guest echo and one mailbox packet. No per-Lane guest amplification.
    await Promise.allSettled(
      [...groups].map(async ([targetId, group]) => {
        if (
          !current() ||
          this.#closed ||
          this.#now() - sentAt > EXECUTION_PROBE_TIMEOUT_MS ||
          this.#handoffs.size >= 64
        )
          return;
        const first = group[0]!,
          target = first.route.descriptor.target;
        const measurement = { recorded: false };
        for (const pending of group) pending.measurement = measurement;
        const started = performance.now();
        try {
          const admitted = await this.#handoffs.add(async () => {
            if (!current() || this.#closed || this.#now() - sentAt > EXECUTION_PROBE_TIMEOUT_MS)
              return false;
            await this.options.cube.submitProbe(target, {
              probeId: fact.factId,
              executionScopeId: first.route.bindingId,
              writerId: first.scope.writerId,
              completionContext: {
                kind: "execution_probe",
                replyTopic: fact.execution!.replyTopic,
                sentAt,
                bindingIds: group.map((p) => p.route.bindingId),
                execution: { bindingId: first.route.bindingId, targetId, bootId: target.bootId },
              },
            });
            return true;
          });
          if (!admitted) return;
          this.options.sample?.("handoff", performance.now() - started, "confirmed");
          for (const pending of group) {
            pending.accepted = true;
            if (
              current() &&
              this.#pending.get(this.#key(pending.probeId, pending.route.bindingId)) === pending &&
              !pending.done &&
              this.#valid(pending.scope)
            )
              this.#observer!.status(pending.scope, {
                status: "pending",
                stage: "cube",
                bindingId: pending.route.bindingId,
                targetId,
                sentAt,
              });
          }
        } catch (error) {
          this.options.sample?.("handoff", performance.now() - started, "unconfirmed");
          const codes = [
            "node_unavailable",
            "executor_replaced",
            "runtime_quarantined",
            "scope_closed",
            "probe_capacity",
            "probe_duplicate",
            "execution_unavailable",
            "invalid_probe",
          ];
          const reason =
            error instanceof CubeExecutionRejected && codes.includes(error.code)
              ? error.code
              : "handoff_unconfirmed";
          const unconfirmed = group.find((pending) => !pending.done && this.#valid(pending.scope));
          if (unconfirmed) this.options.diagnostic?.(unconfirmed.scope.runId, "projector", reason);
          for (const pending of group)
            if (
              current() &&
              this.#pending.get(this.#key(pending.probeId, pending.route.bindingId)) === pending &&
              !pending.done &&
              this.#valid(pending.scope)
            )
              this.#observer!.status(pending.scope, {
                status: "unavailable",
                stage: "projector",
                bindingId: pending.route.bindingId,
                targetId,
                sentAt,
              });
        }
      }),
    );
  }
  complete(value: ExecutionObservationDelivery): void {
    const { evidence, scope } = value,
      now = this.#now();
    if (
      !this.#valid(scope, value.partition) ||
      evidence.observedAt < now - RUN_OBSERVATION_STALE_MS ||
      evidence.observedAt > now + 5000
    )
      return;
    const bound = this.#bindings.get(evidence.bindingId);
    if (
      !bound ||
      !isDeepStrictEqual(bound.scope, scope) ||
      evidence.targetId !== executionTargetId(bound.route.descriptor.target) ||
      evidence.bootId !== bound.route.descriptor.target.bootId
    )
      return;
    if (value.kind === "probe") {
      const pending = this.#pending.get(this.#key(value.requestId, evidence.bindingId));
      if (
        !pending ||
        pending.done ||
        pending.sentAt !== value.sentAt ||
        now - value.sentAt > EXECUTION_PROBE_TIMEOUT_MS ||
        evidence.observedAt < value.sentAt - 5000 ||
        !isDeepStrictEqual(pending.scope, scope)
      )
        return;
      pending.done = true;
      if (value.roundTripMs !== undefined && pending.measurement && !pending.measurement.recorded) {
        pending.measurement.recorded = true;
        this.options.sample?.("round_trip", value.roundTripMs, "confirmed");
      }
    }
    bound.touched = now;
    this.#observer!.status(scope, {
      status: "confirmed",
      stage: "worker",
      bindingId: evidence.bindingId,
      targetId: evidence.targetId,
      sentAt: value.sentAt,
      confirmedAt: evidence.observedAt,
    });
    if (
      evidence.observedAt <= (this.#physical.get(evidence.targetId) ?? -1) ||
      this.#active.size >= 16
    )
      return;
    this.#physical.set(evidence.targetId, evidence.observedAt);
    const work = this.options
      .runtimeEvidence(bound.route, evidence.observedAt)
      .catch(() => {})
      .finally(() => this.#active.delete(work));
    this.#active.add(work);
  }
  sweep(): void {
    const now = this.#now();
    for (const [key, pending] of this.#pending)
      if (now - pending.sentAt > EXECUTION_PROBE_TIMEOUT_MS) {
        this.#pending.delete(key);
        if (!pending.done && this.#valid(pending.scope))
          this.options.diagnostic?.(
            pending.scope.runId,
            pending.accepted ? "cube" : "projector",
            "reply_unconfirmed",
          );
        if (!pending.done && this.#valid(pending.scope))
          this.#observer!.status(pending.scope, {
            status: "unavailable",
            stage: pending.accepted ? "cube" : "projector",
            bindingId: pending.route.bindingId,
            targetId: executionTargetId(pending.route.descriptor.target),
            sentAt: pending.sentAt,
          });
      }
    for (const [key, bound] of this.#bindings)
      if (now - bound.touched > 300_000 || !this.#valid(bound.scope)) this.#bindings.delete(key);
    for (const [key, at] of this.#families) if (now - at > 300_000) this.#families.delete(key);
    for (const [key, at] of this.#physical) if (now - at > 300_000) this.#physical.delete(key);
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await Promise.allSettled([...this.#active]);
    this.#pending.clear();
    this.#bindings.clear();
    this.#families.clear();
    this.#physical.clear();
  }
}
