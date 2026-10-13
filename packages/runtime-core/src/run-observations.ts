import { isDeepStrictEqual } from "node:util";
import {
  RUN_OBSERVATION_STALE_MS,
  type RunActivityDelivery,
  type RuntimeObservationScope,
  type ProbeBinding,
  type ExecutionPathStatus,
} from "@pi-cloud/protocol";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";
import type { SessionEventHub } from "./session-event-hub.ts";

const observationKey = (scope: RuntimeObservationScope) =>
  `${scope.writerId}:${scope.runId}:${scope.sessionId}`;

type Active = {
  scope: RuntimeObservationScope;
  partition: number;
  revision: number;
  activityAt: number;
  pathAt: number;
  touched: number;
  executionRevision: number;
  execution?: ExecutionPathStatus;
};

/** Disposable, bounded admission from the Projector's already-checked scopes. */
export class RunObservations {
  readonly #runs = new Map<string, Active>();
  readonly #families = new Map<string, Set<string>>();
  readonly #positions = new Map<number, bigint>();
  constructor(
    readonly hub: SessionEventHub,
    readonly clock: () => number = Date.now,
  ) {}
  reset(): void {
    this.#runs.clear();
    this.#families.clear();
    this.#positions.clear();
  }

  record(record: KafkaAcceptedFactRecord, open: boolean): void {
    const { fact, partition, offset } = record;
    const { scope } = fact;
    if (fact.kind === "execution_seal" || fact.kind === "work_finished") {
      for (const id of [...(this.#families.get(scope.writerId) ?? [])]) this.#remove(id);
      return;
    }
    if (
      !open ||
      (fact.kind === "agent_event" &&
        ["turn.completed", "turn.failed", "turn.cancelled"].includes(fact.event.type))
    ) {
      this.#remove(observationKey(scope));
      return;
    }
    let active = this.#runs.get(observationKey(scope));
    if (!active && fact.kind !== "path_probe") {
      // Tool command scopes contain leaseId in addition to the common identity.
      const { tenantId, sessionId, turnId, runId, writerId, fencingToken, piSessionId } = scope;
      active = {
        scope: { tenantId, sessionId, turnId, runId, writerId, fencingToken, piSessionId },
        partition,
        revision: 0,
        activityAt: 0,
        pathAt: 0,
        touched: this.clock(),
        executionRevision: 0,
      };
      this.#runs.set(observationKey(scope), active);
      let family = this.#families.get(scope.writerId);
      if (!family) this.#families.set(scope.writerId, (family = new Set()));
      family.add(observationKey(scope));
      if (this.#runs.size > 65_536) this.#remove(this.#runs.keys().next().value!);
    }
    if (!active) return;
    active.touched = this.clock();
    const previous = this.#positions.get(partition);
    if (previous !== undefined && offset <= previous) return;
    this.#positions.set(partition, offset);
    const sentAt = Date.parse(fact.occurredAt),
      now = this.clock();
    if (!this.#fresh(sentAt, now)) return;
    // One physical Session probe supplies evidence for all its observed active Lanes.
    for (const runId of this.#families.get(scope.writerId) ?? []) {
      const target = this.#runs.get(runId)!;
      if (target.pathAt >= sentAt) continue;
      // Bound ordinary streaming observations too; no per-token UI wake.
      if (sentAt - target.pathAt < 1_000) continue;
      target.pathAt = sentAt;
      target.touched = now;
      this.hub.publishObservation(target.scope.tenantId, {
        type: "run.path",
        sessionId: target.scope.sessionId,
        turnId: target.scope.turnId,
        runId: target.scope.runId,
        sentAt,
        observedAt: now,
      });
    }
  }

  activity(delivery: RunActivityDelivery): void {
    const active = this.#runs.get(observationKey(delivery.scope)),
      now = this.clock();
    if (
      !active ||
      active.partition !== delivery.partition ||
      !isDeepStrictEqual(active.scope, delivery.scope) ||
      delivery.revision <= active.revision ||
      !this.#fresh(delivery.observedAt, now) ||
      delivery.lastActivityAt > delivery.observedAt ||
      delivery.lastActivityAt < active.activityAt
    )
      return;
    active.revision = delivery.revision;
    active.activityAt = delivery.lastActivityAt;
    active.touched = now;
    this.hub.publishObservation(active.scope.tenantId, {
      type: "run.activity",
      sessionId: active.scope.sessionId,
      turnId: active.scope.turnId,
      runId: active.scope.runId,
      revision: delivery.revision,
      phase: delivery.phase,
      observedAt: delivery.observedAt,
      lastActivityAt: delivery.lastActivityAt,
    });
  }

  isActive(scope: RuntimeObservationScope, partition?: number): boolean {
    const active = this.#runs.get(observationKey(scope));
    return (
      !!active &&
      (partition === undefined || active.partition === partition) &&
      isDeepStrictEqual(active.scope, scope)
    );
  }
  executionTargets(writerId: string, bindings: readonly ProbeBinding[], sentAt: number): void {
    for (const runId of this.#families.get(writerId) ?? []) {
      const active = this.#runs.get(runId)!;
      const binding = bindings.find((b) => isDeepStrictEqual(b.scope, active.scope));
      if (!binding)
        this.execution(active.scope, { status: "not_applicable", stage: "projector", sentAt });
      else if (binding.probe || active.execution?.bindingId !== binding.bindingId)
        this.execution(active.scope, {
          status: "pending",
          stage: "projector",
          bindingId: binding.bindingId,
          sentAt,
        });
    }
  }
  execution(scope: RuntimeObservationScope, value: ExecutionPathStatus): void {
    const active = this.#runs.get(observationKey(scope)),
      now = this.clock();
    if (!active || !isDeepStrictEqual(active.scope, scope) || !this.#fresh(value.sentAt, now))
      return;
    const old = active.execution;
    if (old && value.sentAt < old.sentAt) return;
    if (old && value.sentAt === old.sentAt && old.stage === "worker" && value.stage !== "worker")
      return;
    const same =
      !!value.bindingId &&
      old?.bindingId === value.bindingId &&
      (!value.targetId || !old.targetId || old.targetId === value.targetId);
    const confirmedAt = value.confirmedAt ?? (same ? old?.confirmedAt : undefined);
    const targetId = value.targetId ?? (same ? old?.targetId : undefined);
    active.execution = {
      ...value,
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
      ...(targetId === undefined ? {} : { targetId }),
    };
    active.executionRevision++;
    active.touched = now;
    this.hub.publishObservation(scope.tenantId, {
      type: "run.execution",
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      runId: scope.runId,
      revision: active.executionRevision,
      observedAt: now,
      execution: active.execution,
    });
  }
  sweep(): void {
    for (const [id, active] of this.#runs)
      if (active.touched < this.clock() - 300_000) this.#remove(id);
  }
  #fresh(at: number, now: number): boolean {
    return Number.isFinite(at) && at <= now + 5_000 && at >= now - RUN_OBSERVATION_STALE_MS;
  }
  #remove(id: string): void {
    const active = this.#runs.get(id);
    if (!active) return;
    this.#runs.delete(id);
    const family = this.#families.get(active.scope.writerId);
    family?.delete(id);
    if (!family?.size) this.#families.delete(active.scope.writerId);
  }
}
