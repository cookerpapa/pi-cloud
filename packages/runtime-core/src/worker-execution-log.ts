import { randomUUID } from "node:crypto";
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
import { encodeSessionLogFact } from "./session-log-envelope.ts";
import { DEFAULT_PRODUCER_CAPACITY, type ProducerCapacity } from "@pi-cloud/event-log";
import { AcceptedFactCapacityError } from "./accepted-fact.ts";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import type { AcceptedFact } from "./accepted-fact.ts";
import type { WorkTerminal } from "./accepted-fact.ts";

export type ConversationLogAddress = {
  conversationId: number;
  sessionId: string;
  turnId: string;
  nextEventSeq: number;
};

export type WorkerExecutionProbeTransport = {
  topic: string;
  replies: Pick<ToolReplyMailbox, "waitProbe">;
  partitionFor(id: string): number;
  report(value: ExecutionObservationDelivery): void;
  confirm(value: ExecutionObservationDelivery, signal: AbortSignal): Promise<boolean>;
};

type RuntimeBinding = {
  scope: RuntimeObservationScope;
  bindingId?: string;
  successAt: number;
  pending?: AbortController;
  check?: { controller: AbortController; result: Promise<boolean> };
};
type RequestedProbe = Pick<PathProbe, "factId" | "occurredAt" | "execution">;

/** Worker-local ordering over its physical Session producer; no second lease renewer. */
export class WorkerExecutionLog implements ExecutionLogFactory, ActiveExecutionLogResolver {
  readonly #retentionResources = new Map<
    string,
    Map<number, import("@pi-cloud/protocol").RuntimeKeepaliveResource>
  >();
  readonly #retentionPending = new Set<string>();
  readonly #lastRetentionAt = new Map<string, number>();
  #probeTransport: WorkerExecutionProbeTransport | undefined;
  readonly #runtimeBindings = new Map<string, RuntimeBinding>();
  readonly #writers = new Map<string, ExecutionLogWriter>();
  readonly #conversationWriters = new Map<string, Map<number, ExecutionLogWriter>>();
  readonly #conversationFactories = new Map<
    string,
    (address: ConversationLogAddress) => ExecutionLogWriter
  >();
  readonly #opening = new Set<string>();
  readonly #families = new Map<
    string,
    {
      touched: number;
      probeAt: number;
      pending: boolean;
      writers: Map<
        string,
        {
          runId: string;
          acknowledge(seq: number): void;
          ready(): boolean;
          due(): boolean;
          send(probe?: RequestedProbe): Promise<void>;
          retain(resources: import("@pi-cloud/protocol").RuntimeKeepaliveResource[]): Promise<void>;
        }
      >;
    }
  >();
  readonly #probeTimer: NodeJS.Timeout;
  #queuedBytes = 0;
  #queuedFacts = 0;
  constructor(
    readonly bus: AcceptedFactBus & { close?(): Promise<void> },
    readonly capacity: ProducerCapacity = DEFAULT_PRODUCER_CAPACITY,
    readonly probeIntervalMs = RUN_PATH_PROBE_INTERVAL_MS,
  ) {
    if (!Number.isSafeInteger(probeIntervalMs) || probeIntervalMs < 1)
      throw new TypeError("Invalid path probe interval");
    this.#probeTimer = setInterval(() => {
      for (const family of this.#families.values()) {
        const source = [...family.writers.entries()].find(([, writer]) => writer.ready());
        if (source) this.#requestRetention(source[0]);
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
  bindRetention(
    reference: string,
    conversationId: number,
    resource?: import("@pi-cloud/protocol").RuntimeKeepaliveResource,
  ): void {
    let values = this.#retentionResources.get(reference);
    if (!resource) {
      values?.delete(conversationId);
      if (!values?.size) this.#retentionResources.delete(reference);
      return;
    }
    if (!values) this.#retentionResources.set(reference, (values = new Map()));
    values.set(conversationId, resource);
    this.#requestRetention(reference);
  }
  #requestRetention(reference: string): void {
    const owner = this.#writers.get(reference)?.publication.scope.writerId;
    const family = owner ? this.#families.get(owner) : undefined;
    const source = family?.writers.get(reference);
    if (!family || !source?.ready() || this.#retentionPending.has(reference)) return;
    const now = performance.now(),
      last = this.#lastRetentionAt.get(reference);
    if (last !== undefined && now - last < this.probeIntervalMs) return;
    const resources = [
      ...new Map(
        [...family.writers.keys()]
          .flatMap((key) => [...(this.#retentionResources.get(key)?.values() ?? [])])
          .map((value) => [JSON.stringify(value), value]),
      ).values(),
    ];
    if (!resources.length) return;
    this.#lastRetentionAt.set(reference, now);
    this.#retentionPending.add(reference);
    void source
      .retain(resources)
      .catch(() => undefined)
      .finally(() => this.#retentionPending.delete(reference));
  }
  bindRuntime(
    executionReference: string,
    bindingId: string | undefined,
    conversationId?: number,
  ): void {
    const key =
      conversationId === undefined ||
      this.#writers.get(executionReference)?.publication.scope.piConversationId === conversationId
        ? executionReference
        : `${executionReference}:${conversationId}`;
    const runtime = this.#runtimeBindings.get(key);
    if (!runtime || runtime.bindingId === bindingId) return;
    runtime.pending?.abort();
    runtime.check?.controller.abort();
    delete runtime.pending;
    if (bindingId) runtime.bindingId = bindingId;
    else delete runtime.bindingId;
    runtime.successAt = 0;
  }
  /** A fresh round trip and current binding confirmation, never an execution grant. */
  async confirmExecution(
    reference: string,
    bindingId: string,
    conversationId: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const writer = this.#writers.get(reference);
    const key =
      writer?.publication.scope.piConversationId === conversationId
        ? reference
        : `${reference}:${conversationId}`;
    const runtime = this.#runtimeBindings.get(key),
      transport = this.#probeTransport;
    const family = writer && this.#families.get(writer.publication.scope.writerId);
    const publisher = family?.writers.get(reference);
    if (
      signal.aborted ||
      !runtime ||
      runtime.bindingId !== bindingId ||
      !transport ||
      !publisher?.ready()
    )
      return false;
    if (!runtime.check) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EXECUTION_PROBE_TIMEOUT_MS);
      timeout.unref();
      const active = AbortSignal.any([signal, controller.signal]);
      const id = randomUUID(),
        sentAt = Math.max(Date.now(), family!.probeAt + 1);
      family!.probeAt = sentAt;
      const current = () =>
        this.#runtimeBindings.get(key) === runtime &&
        runtime.bindingId === bindingId &&
        publisher.ready() &&
        !active.aborted;
      const work = (async () => {
        writer?.assertHealthy?.();
        const reply = transport.replies.waitProbe(id, bindingId, active);
        const [value] = await Promise.all([
          reply,
          publisher.send({
            factId: id,
            occurredAt: new Date(sentAt).toISOString(),
            execution: {
              replyTopic: transport.topic,
              bindings: [{ bindingId, scope: runtime.scope, probe: true }],
            },
          }),
        ]);
        if (
          !current() ||
          value.sentAt !== sentAt ||
          value.probeId !== id ||
          value.evidence.observedAt < sentAt - 5000 ||
          value.evidence.observedAt > Date.now() + 5000
        )
          return false;
        const confirmed = await transport.confirm(
          {
            scope: runtime.scope,
            partition: transport.partitionFor(runtime.scope.piSessionId),
            kind: "probe",
            requestId: id,
            sentAt,
            roundTripMs: Math.max(0, Date.now() - sentAt),
            evidence: { ...value.evidence, bindingId },
          },
          active,
        );
        writer?.assertHealthy?.();
        if (!confirmed || !current()) return false;
        runtime.successAt = Math.max(runtime.successAt, value.evidence.observedAt);
        return true;
      })().catch(() => false);
      let cancel = () => {};
      const stopped = new Promise<boolean>((resolve) => {
        cancel = () => resolve(false);
        active.addEventListener("abort", cancel, { once: true });
        if (active.aborted) cancel();
      });
      const result = Promise.race([work, stopped]).finally(() => {
        clearTimeout(timeout);
        active.removeEventListener("abort", cancel);
        controller.abort();
        if (runtime.check?.controller === controller) delete runtime.check;
      });
      runtime.check = { controller, result };
    }
    const check = runtime.check;
    return new Promise<boolean>((resolve) => {
      const abort = () => resolve(false);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void check.result.then((ready) => {
        signal.removeEventListener("abort", abort);
        resolve(ready && !signal.aborted);
      });
    });
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
  resolve(lease: string, conversationId?: number) {
    const root = this.#writers.get(lease);
    return conversationId === undefined ||
      root?.publication.scope.piConversationId === conversationId
      ? root
      : this.#conversationWriters.get(lease)?.get(conversationId);
  }
  openConversation(reference: string, address: ConversationLogAddress): ExecutionLogWriter {
    const create = this.#conversationFactories.get(reference);
    if (!create) throw new Error("Root Session writer is unavailable");
    return create(address);
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
      await this.bus.forget?.(request.publication.scope);
      throw error;
    } finally {
      this.#opening.delete(request.executionReference);
    }
    const permit = request.publication;
    const { leaseId: _lease, piConversationId: _lane, ...observationScope } = permit.scope;
    const runtimeBinding: RuntimeBinding = { scope: observationScope, successAt: 0 };
    this.#runtimeBindings.set(request.executionReference, runtimeBinding);
    let family = this.#families.get(permit.scope.writerId);
    if (!family)
      this.#families.set(
        permit.scope.writerId,
        (family = {
          touched: performance.now(),
          probeAt: 0,
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
      nativeSequence = 0,
      acknowledgedThroughSeq = request.nextEventSeq - 1;
    let finishing: { terminal: string; promise: Promise<void> } | undefined;
    const publish = (candidate: CandidateFact, view = permit.scope): Promise<void> => {
      if (failure) return Promise.reject(failure);
      if (closing)
        return Promise.reject(
          new PublicationNotSentError("Execution writer closed before enqueue"),
        );
      let fact: AcceptedFact, bytes: number;
      try {
        fact = prepareExecutionFact(
          { ...view, executionReference: request.executionReference },
          candidate,
        );
        bytes = Buffer.byteLength(encodeSessionLogFact(fact));
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
      if (fact.kind !== "runtime_keepalive") activeFamily.touched = performance.now();
      const pending = tail
        .then(async () => {
          if ((fact.kind === "path_probe" || fact.kind === "runtime_keepalive") && closing) return;
          if (failure) throw failure;
          const receipt = await this.bus.append(fact);
          if (!receipt.durable || receipt.factId !== fact.factId)
            throw new Error("Kafka acknowledgement did not match the appended record");
          if (fact.kind !== "path_probe" && fact.kind !== "runtime_keepalive") published = true;
        })
        .finally(() => {
          this.#queuedBytes -= bytes;
          this.#queuedFacts--;
        });
      // A probe follows the preceding publication tail, using the same ordered
      // Kafka producer, but its receipt is not another semantic commit barrier.
      // A lost probe ACK must not pin native writes or Run drain indefinitely.
      if (fact.kind !== "path_probe" && fact.kind !== "runtime_keepalive")
        tail = pending.catch((error) => {
          if (!(error instanceof PublicationNotSentError)) failure = error;
        });
      return pending;
    };
    const writer: ExecutionLogWriter = {
      assertHealthy: () => {
        if (closing) throw new PublicationNotSentError("Execution writer is closing");
        const cause = failure ?? this.bus.publicationFailure?.(permit.scope);
        if (cause)
          throw Object.assign(new Error("Session producer stopped"), {
            code: "writer_publication_failed",
            cause,
          });
      },
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
      commitNative: async (fact) => {
        await publish({ kind: "durable_commit", fact });
        nativeSequence = fact.commit.seq;
        this.#requestRetention(request.executionReference);
        for (const display of fact.display) {
          const through = Math.max(
            display.coveredThrough ?? 0,
            ...display.events.map(({ event }) => event.seq),
          );
          if (display.scope.sessionId === permit.scope.sessionId)
            acknowledgedThroughSeq = Math.max(acknowledgedThroughSeq, through);
          const acknowledge = conversationAcknowledgements.get(display.scope.sessionId);
          acknowledge?.(through);
        }
      },
      drain: async () => {
        closing = true;
        await tail;
        if (failure)
          throw Object.assign(new Error("Session writer publication failed", { cause: failure }), {
            code: "writer_publication_failed",
            retryable: true,
          });
      },
      finish: (terminal: WorkTerminal) => {
        const encoded = JSON.stringify(terminal);
        if (finishing) {
          if (finishing.terminal !== encoded)
            return Promise.reject(new Error("Root completion outcome changed"));
          return finishing.promise;
        }
        const promise = (async () => {
          await writer.drain();
          if (conversations.size)
            throw new Error("Root work still has attached Conversation publications");
          const { leaseId: _lease, piConversationId: _conversation, ...scope } = permit.scope;
          const fact = {
            kind: "work_finished" as const,
            factId: randomUUID(),
            scope,
            agentId: "root",
            baseSequence: acknowledgedThroughSeq,
            nativeSequence,
            terminal,
            occurredAt: new Date().toISOString(),
          };
          try {
            const receipt = await this.bus.append(fact);
            if (!receipt.durable || receipt.factId !== fact.factId)
              throw new Error("Work completion ACK changed");
          } catch (cause) {
            failure = cause;
            throw Object.assign(
              new Error("Work completion publication is unconfirmed", { cause }),
              { code: "writer_publication_failed", retryable: true },
            );
          }
        })();
        finishing = { terminal: encoded, promise };
        return promise;
      },
      close: async () => {
        closing = true;
        runtimeBinding.pending?.abort();
        runtimeBinding.check?.controller.abort();
        this.#runtimeBindings.delete(request.executionReference);
        activeFamily.writers.delete(request.executionReference);
        if (!activeFamily.writers.size) this.#families.delete(permit.scope.writerId);
        await tail;
        this.#writers.delete(request.executionReference);
        this.#retentionResources.delete(request.executionReference);
        this.#lastRetentionAt.delete(request.executionReference);
        this.#conversationFactories.delete(request.executionReference);
        this.#conversationWriters.delete(request.executionReference);
        await this.bus.forget?.(permit.scope);
        if (failure) throw failure;
      },
    };
    const conversationAcknowledgements = new Map<string, (seq: number) => void>();
    const conversations = new Map<number, ExecutionLogWriter>();
    this.#conversationWriters.set(request.executionReference, conversations);
    this.#conversationFactories.set(request.executionReference, (address) => {
      if (closing || failure) throw new Error("Root Session writer is closing");
      if (conversations.has(address.conversationId))
        throw new Error("Conversation writer already open");
      const scope = {
        ...permit.scope,
        sessionId: address.sessionId,
        turnId: address.turnId,
        piConversationId: address.conversationId,
      };
      const { leaseId: _lease, piConversationId: _conversation, ...observationScope } = scope;
      const bindingKey = `${request.executionReference}:${address.conversationId}`;
      this.#runtimeBindings.set(bindingKey, { scope: observationScope, successAt: 0 });
      let closed = false,
        through = address.nextEventSeq - 1;
      const view: ExecutionLogWriter = {
        ...writer,
        publication: { scope },
        drain: async () => {
          await tail;
        },
        finish: async () => {
          throw new Error("Only root work can finish the Session writer");
        },
        get acknowledgedThroughSeq() {
          return through;
        },
        ingest: async (value) => {
          if (closed) throw new PublicationNotSentError("Conversation view is closed");
          const publication = parseSupervisorToControlMessage(value);
          if (publication.type !== "event.publish") throw new Error("Expected an Agent event");
          await publish({ kind: "agent_event", publication }, scope);
          through = Math.max(through, publication.payload.event.seq);
          return {
            protocolVersion: 1,
            messageId: randomUUID(),
            sentAt: new Date().toISOString(),
            type: "event.ack",
            payload: {
              sessionId: address.sessionId,
              executionReference: request.executionReference,
              acknowledgedThroughSeq: through,
            },
          };
        },
        close: async () => {
          if (closed) return;
          closed = true;
          await tail;
          conversations.delete(address.conversationId);
          this.#retentionResources.get(request.executionReference)?.delete(address.conversationId);
          conversationAcknowledgements.delete(address.sessionId);
          this.#runtimeBindings.get(bindingKey)?.pending?.abort();
          this.#runtimeBindings.get(bindingKey)?.check?.controller.abort();
          this.#runtimeBindings.delete(bindingKey);
          if (failure) throw failure;
        },
      };
      conversations.set(address.conversationId, view);
      conversationAcknowledgements.set(address.sessionId, (seq) => {
        through = Math.max(through, seq);
      });
      return view;
    });
    this.#writers.set(request.executionReference, writer);
    activeFamily.writers.set(request.executionReference, {
      runId: permit.scope.runId,
      acknowledge: (seq) => {
        acknowledgedThroughSeq = Math.max(acknowledgedThroughSeq, seq);
      },
      retain: async (resources) => {
        if (closing || failure || !published) return;
        for (let offset = 0; offset < resources.length; offset += 64)
          await publish({
            kind: "runtime_keepalive",
            factId: randomUUID(),
            occurredAt: new Date().toISOString(),
            resources: resources.slice(offset, offset + 64),
          });
      },
      ready: () => !closing && !failure && published,
      due: () =>
        !!this.#probeTransport &&
        !!runtimeBinding.bindingId &&
        !runtimeBinding.pending &&
        Date.now() - runtimeBinding.successAt >= this.probeIntervalMs,
      send: async (requested) => {
        // Probes never establish a recovery floor or consume native/display sequence.
        if (closing || failure || !published) return;
        if (requested) {
          await publish({ kind: "path_probe", ...requested });
          return;
        }
        const factId = randomUUID(),
          sentAt = Math.max(Date.now(), activeFamily.probeAt + 1);
        activeFamily.probeAt = sentAt;
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
    this.#retentionResources.clear();
    this.#lastRetentionAt.clear();
    await Promise.allSettled([...this.#writers.values()].map((w) => w.close()));
    this.#writers.clear();
    await this.bus.close?.();
  }
}
