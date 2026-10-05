import { randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import {
  parseSupervisorToControlMessage,
  RUN_PATH_PROBE_INTERVAL_MS,
  RUN_OBSERVATION_STALE_MS,
  EXECUTION_PROBE_TIMEOUT_MS,
  type RuntimeObservationScope,
  type PathProbe,
  type ExecutionObservationDelivery,
  type ExecutionEvidence,
} from "@pi-cloud/protocol";
import type { ToolReplyMailbox } from "@pi-cloud/event-log";
import type {
  ActiveExecutionLogResolver,
  AcceptedFactBus,
  CandidateFact,
} from "./accepted-fact.ts";
import type {
  ExecutionLogWriter,
  ExecutionLogFactory,
  ExecutionLogOpenRequest,
} from "./execution-log.ts";
import { prepareExecutionFact } from "./prepare-execution-fact.ts";
import { DEFAULT_PRODUCER_CAPACITY, type ProducerCapacity } from "@pi-cloud/event-log";
import { AcceptedFactCapacityError } from "./accepted-fact.ts";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import type { AcceptedFact } from "./accepted-fact.ts";

export type WorkerExecutionProbeTransport = {
  topic: string;
  replies: Pick<ToolReplyMailbox, "waitProbe">;
  partitionFor(id: string): number;
  report(value: ExecutionObservationDelivery): void;
};

/** Worker-local ordering over control-plane publication; no second lease renewer. */
export class WorkerExecutionLog implements ExecutionLogFactory, ActiveExecutionLogResolver {
  #probeTransport: WorkerExecutionProbeTransport | undefined;
  readonly #runtimeBindings = new Map<
    string,
    {
      scope: RuntimeObservationScope;
      bindingId?: string;
      successAt: number;
      pending?: AbortController;
    }
  >();
  readonly #writers = new Map<string, ExecutionLogWriter>();
  readonly #opening = new Set<string>();
  readonly #families = new Map<
    string,
    {
      touched: number;
      pending: boolean;
      writers: Map<string, { ready(): boolean; due(): boolean; send(): Promise<void> }>;
    }
  >();
  readonly #probeTimer: NodeJS.Timeout;
  #queuedBytes = 0;
  #queuedFacts = 0;
  constructor(
    readonly database: Kysely<Database>,
    readonly bus: AcceptedFactBus & { close?(): Promise<void> },
    readonly capacity: ProducerCapacity = DEFAULT_PRODUCER_CAPACITY,
    readonly probeIntervalMs = RUN_PATH_PROBE_INTERVAL_MS,
  ) {
    if (!Number.isSafeInteger(probeIntervalMs) || probeIntervalMs < 1)
      throw new TypeError("Invalid path probe interval");
    this.#probeTimer = setInterval(() => {
      for (const family of this.#families.values()) {
        const executionDue = [...family.writers.values()].some(
          (writer) => writer.ready() && writer.due(),
        );
        if (
          family.pending ||
          (!executionDue && performance.now() - family.touched < this.probeIntervalMs)
        )
          continue;
        const writer = [...family.writers.values()].find((writer) => writer.ready());
        if (!writer) continue;
        family.pending = true;
        family.touched = performance.now();
        void writer
          .send()
          .catch(() => undefined)
          .finally(() => {
            family.pending = false;
          });
      }
    }, probeIntervalMs);
    this.#probeTimer.unref();
  }
  configureExecutionProbes(transport: WorkerExecutionProbeTransport): void {
    this.#probeTransport = transport;
  }
  bindRuntime(executionReference: string, bindingId: string | undefined): void {
    const runtime = this.#runtimeBindings.get(executionReference);
    if (!runtime || runtime.bindingId === bindingId) return;
    runtime.pending?.abort();
    delete runtime.pending;
    if (bindingId) runtime.bindingId = bindingId;
    else delete runtime.bindingId;
    runtime.successAt = 0;
  }
  recordExecutionEvidence(operationId: string, evidence: ExecutionEvidence): void {
    const runtime = [...this.#runtimeBindings.values()].find(
      (r) => r.bindingId === evidence.bindingId,
    );
    if (
      !runtime ||
      !this.#probeTransport ||
      evidence.observedAt < Date.now() - RUN_OBSERVATION_STALE_MS ||
      evidence.observedAt > Date.now() + 5000
    )
      return;
    runtime.successAt = Math.max(runtime.successAt, evidence.observedAt);
    this.#probeTransport.report({
      scope: runtime.scope,
      partition: this.#probeTransport.partitionFor(runtime.scope.piSessionId),
      kind: "tool",
      requestId: operationId,
      sentAt: evidence.observedAt,
      evidence,
    });
  }
  #prepareProbe(writerId: string, probeId: string, sentAt: number): PathProbe["execution"] {
    const transport = this.#probeTransport;
    if (!transport) return undefined;
    const bindings = [];
    for (const [reference, runtime] of this.#runtimeBindings) {
      if (runtime.scope.writerId !== writerId || !runtime.bindingId || bindings.length >= 64)
        continue;
      const bindingId = runtime.bindingId;
      let probe = !runtime.pending && sentAt - runtime.successAt >= this.probeIntervalMs;
      if (probe) {
        const started = performance.now();
        const pending = new AbortController();
        runtime.pending = pending;
        try {
          const reply = transport.replies.waitProbe(
            probeId,
            bindingId,
            AbortSignal.any([pending.signal, AbortSignal.timeout(EXECUTION_PROBE_TIMEOUT_MS)]),
          );
          void reply
            .then((value) => {
              if (
                this.#runtimeBindings.get(reference) !== runtime ||
                runtime.bindingId !== bindingId ||
                value.sentAt !== sentAt ||
                Date.now() - sentAt > EXECUTION_PROBE_TIMEOUT_MS ||
                performance.now() - started > EXECUTION_PROBE_TIMEOUT_MS ||
                value.evidence.observedAt < sentAt - 5000 ||
                value.evidence.observedAt > Date.now() + 5000
              )
                return;
              runtime.successAt = Math.max(runtime.successAt, value.evidence.observedAt);
              transport.report({
                scope: runtime.scope,
                partition: transport.partitionFor(runtime.scope.piSessionId),
                kind: "probe",
                requestId: probeId,
                sentAt,
                roundTripMs: Math.max(0, performance.now() - started),
                evidence: { ...value.evidence, bindingId },
              });
            })
            .catch(() => {})
            .finally(() => {
              if (runtime.pending === pending) delete runtime.pending;
            });
        } catch {
          pending.abort();
          delete runtime.pending;
          probe = false;
        }
      }
      bindings.push({ bindingId, scope: runtime.scope, probe });
    }
    return { replyTopic: transport.topic, bindings };
  }
  resolve(lease: string) {
    return this.#writers.get(lease);
  }
  async publicationAvailability() {
    if (!this.bus.publicationAvailability)
      throw new Error("Execution transport has no publication availability");
    return this.bus.publicationAvailability();
  }
  async checkHealth() {
    await this.bus.checkHealth();
  }
  async open(request: ExecutionLogOpenRequest): Promise<ExecutionLogWriter> {
    if (
      this.#writers.has(request.executionReference) ||
      this.#opening.has(request.executionReference)
    )
      throw new Error("Execution writer already open");
    this.#opening.add(request.executionReference);
    try {
      request.signal?.throwIfAborted();
      await this.bus.open?.(request.publication, request.signal);
      request.signal?.throwIfAborted();
    } catch (error) {
      this.bus.forget?.(request.publication.scope.runId);
      // Opening installs control state only: no native message or external
      // effect could have been submitted by this not-yet-created writer.
      await this.database
        .updateTable("runs")
        .set({ native_output_drained: true })
        .where("id", "=", request.publication.scope.runId)
        .where("output_sealed_at", "is", null)
        .execute();
      throw error;
    } finally {
      this.#opening.delete(request.executionReference);
    }
    const permit = request.publication;
    const { leaseId: _lease, piConversationId: _lane, ...observationScope } = permit.scope;
    const runtimeBinding = { scope: observationScope, successAt: 0 } as {
      scope: RuntimeObservationScope;
      bindingId?: string;
      successAt: number;
      pending?: AbortController;
    };
    this.#runtimeBindings.set(request.executionReference, runtimeBinding);
    let family = this.#families.get(permit.scope.writerId);
    if (!family)
      this.#families.set(
        permit.scope.writerId,
        (family = {
          touched: performance.now(),
          pending: false,
          writers: new Map(),
        }),
      );
    const activeFamily = family;
    // Admission installs soft state only. The first real append establishes
    // the Projector's recovery floor; opening adds no native/Kafka record.
    let closing = false,
      failure: unknown,
      tail = Promise.resolve(),
      published = false,
      acknowledgedThroughSeq = request.nextEventSeq - 1;
    const publish = (candidate: CandidateFact): Promise<void> => {
      if (failure) return Promise.reject(failure);
      if (closing)
        return Promise.reject(
          new PublicationNotSentError("Execution writer closed before enqueue"),
        );
      let fact: AcceptedFact, bytes: number;
      try {
        fact = prepareExecutionFact(
          { ...permit.scope, executionReference: request.executionReference },
          candidate,
        );
        bytes = Buffer.byteLength(JSON.stringify(fact));
      } catch (error) {
        return Promise.reject(
          new PublicationNotSentError("Execution record preparation failed", { cause: error }),
        );
      }
      if (
        this.#queuedFacts >= this.capacity.maximumPendingFacts ||
        this.#queuedBytes + bytes > this.capacity.maximumPendingBytes
      ) {
        return Promise.reject(new AcceptedFactCapacityError());
      }
      this.#queuedBytes += bytes;
      this.#queuedFacts++;
      activeFamily.touched = performance.now();
      const pending = tail
        .then(async () => {
          if (fact.kind === "path_probe" && closing) return;
          if (failure) throw failure;
          const receipt = await this.bus.append(fact);
          if (!receipt.durable || receipt.factId !== fact.factId)
            throw new Error("Kafka acknowledgement did not match the appended record");
          if (fact.kind !== "path_probe") published = true;
        })
        .finally(() => {
          this.#queuedBytes -= bytes;
          this.#queuedFacts--;
        });
      // A probe follows the preceding publication tail, using the same ordered
      // Kafka producer, but its receipt is not another semantic commit barrier.
      // A lost probe ACK must not pin native writes or Run drain indefinitely.
      if (fact.kind !== "path_probe")
        tail = pending.catch((error) => {
          // Cancellation is an idempotent control request, not an uncertain
          // shell invocation/native history append. Its lost ACK cannot poison
          // the canonical cancellation result or sibling Lanes.
          if (fact.kind !== "tool_cancel" && !(error instanceof PublicationNotSentError))
            failure = error;
        });
      return pending;
    };
    const writer: ExecutionLogWriter = {
      get acknowledgedThroughSeq() {
        return acknowledgedThroughSeq;
      },
      ingest: async (value) => {
        const publication = parseSupervisorToControlMessage(value);
        if (publication.type !== "event.publish") throw new Error("Expected an Agent event");
        await publish({ kind: "agent_event", publication });
        acknowledgedThroughSeq = Math.max(acknowledgedThroughSeq, publication.payload.event.seq);
        return {
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          type: "event.ack",
          payload: {
            sessionId: request.sessionId,
            executionReference: request.executionReference,
            acknowledgedThroughSeq,
          },
        };
      },
      publication: permit,
      commitNative: (fact) => publish({ kind: "durable_commit", fact }),
      publishToolCommand: async (command) => {
        if (command.request.operation === "tool.execute")
          throw new Error("Fixed Tool commands require an atomic native intent publication");
        await publish({ kind: "tool_command", command });
        return { operationId: command.request.operationId, accepted: true };
      },
      publishToolCancellation: async (command) => {
        await publish({ kind: "tool_cancel", command });
      },
      publishSubagentCommand: async (command) => {
        await publish({ kind: "subagent_command", command });
      },
      close: async () => {
        closing = true;
        runtimeBinding.pending?.abort();
        this.#runtimeBindings.delete(request.executionReference);
        activeFamily.writers.delete(request.executionReference);
        if (!activeFamily.writers.size) this.#families.delete(permit.scope.writerId);
        await tail;
        this.#writers.delete(request.executionReference);
        this.bus.forget?.(permit.scope.runId);
        if (failure) throw failure;
        await this.database
          .updateTable("runs")
          .set({ native_output_drained: true, last_event_seq: acknowledgedThroughSeq })
          .where("id", "=", permit.scope.runId)
          .where("lease_id", "=", permit.scope.writerId)
          .where("output_sealed_at", "is", null)
          .execute();
      },
    };
    this.#writers.set(request.executionReference, writer);
    activeFamily.writers.set(request.executionReference, {
      ready: () => !closing && !failure && published,
      due: () =>
        !!this.#probeTransport &&
        !!runtimeBinding.bindingId &&
        !runtimeBinding.pending &&
        Date.now() - runtimeBinding.successAt >= this.probeIntervalMs,
      send: async () => {
        // Probes never establish a recovery floor or consume native/display sequence.
        if (closing || failure || !published) return;
        const factId = randomUUID(),
          sentAt = Date.now();
        const execution = this.#prepareProbe(permit.scope.writerId, factId, sentAt);
        await publish({
          kind: "path_probe",
          factId,
          occurredAt: new Date(sentAt).toISOString(),
          ...(execution ? { execution } : {}),
        });
      },
    });
    return writer;
  }
  async close() {
    clearInterval(this.#probeTimer);
    this.#families.clear();
    await Promise.allSettled([...this.#writers.values()].map((w) => w.close()));
    this.#writers.clear();
    await this.bus.close?.();
  }
}
