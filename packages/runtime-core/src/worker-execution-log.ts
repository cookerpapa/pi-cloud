import { randomUUID } from "node:crypto";
import {
  parseSupervisorToControlMessage,
  RUN_OBSERVATION_STALE_MS,
  SESSION_ACTIVITY_INTERVAL_MS,
  type SessionResourceUse,
  EXECUTION_PROBE_TIMEOUT_MS,
  type RuntimeObservationScope,
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
  resourceUse?: SessionResourceUse;
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
  resourceUse?: SessionResourceUse;
  check?: { controller: AbortController; result: Promise<boolean> };
};
/** Worker-local ordering over its physical Session producer; no second lease renewer. */
export class WorkerExecutionLog implements ExecutionLogFactory, ActiveExecutionLogResolver {
  #probeTransport: WorkerExecutionProbeTransport | undefined;
  readonly #runtimeBindings = new Map<string, RuntimeBinding>();
  readonly #writers = new Map<string, ExecutionLogWriter>();
  readonly #publishers = new Map<string, (fact: CandidateFact) => Promise<void>>();
  readonly #conversationWriters = new Map<string, Map<number, ExecutionLogWriter>>();
  readonly #conversationFactories = new Map<
    string,
    (address: ConversationLogAddress) => ExecutionLogWriter
  >();
  readonly #opening = new Set<string>();
  #queuedBytes = 0;
  #queuedFacts = 0;
  constructor(
    readonly bus: AcceptedFactBus & { close?(): Promise<void> },
    readonly capacity: ProducerCapacity = DEFAULT_PRODUCER_CAPACITY,
  ) {}
  configureExecutionProbes(transport: WorkerExecutionProbeTransport): void {
    this.#probeTransport = transport;
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
    runtime.check?.controller.abort();
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
    const rootScope = this.#runtimeBindings.get(reference)?.scope;
    const key =
      writer?.publication.scope.piConversationId === conversationId
        ? reference
        : `${reference}:${conversationId}`;
    const runtime = this.#runtimeBindings.get(key),
      transport = this.#probeTransport,
      publish = this.#publishers.get(reference);
    if (
      signal.aborted ||
      !runtime ||
      runtime.bindingId !== bindingId ||
      !transport ||
      !publish ||
      !writer ||
      !rootScope ||
      writer.failureSignal?.aborted
    )
      return false;
    if (!runtime.check) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EXECUTION_PROBE_TIMEOUT_MS);
      timeout.unref();
      const active = AbortSignal.any([signal, controller.signal]);
      const id = randomUUID(),
        sentAt = Date.now();
      const current = () =>
        this.#runtimeBindings.get(key) === runtime &&
        runtime.bindingId === bindingId &&
        this.#writers.get(reference) === writer &&
        !writer.failureSignal?.aborted &&
        !active.aborted;
      const work = (async () => {
        writer?.assertHealthy?.();
        const reply = transport.replies.waitProbe(id, bindingId, active);
        const [value] = await Promise.all([
          reply,
          publish({
            kind: "path_probe",
            fact: {
              kind: "path_probe",
              scope: rootScope,
              factId: id,
              occurredAt: new Date(sentAt).toISOString(),
              execution: {
                replyTopic: transport.topic,
                bindings: [{ bindingId, scope: runtime.scope, probe: true }],
              },
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
    const runtimeBinding: RuntimeBinding = {
      scope: observationScope,
      successAt: 0,
      ...(request.resourceUse ? { resourceUse: request.resourceUse } : {}),
    };
    this.#runtimeBindings.set(request.executionReference, runtimeBinding);
    const failed = new AbortController();
    const producerFailure = this.bus.publicationFailureSignal?.(permit.scope);
    const failureSignal = producerFailure
      ? AbortSignal.any([failed.signal, producerFailure])
      : failed.signal;
    // Activity is transport-only; the first native append establishes its
    // own recovery floor without consuming native sequence for a heartbeat.
    let closing = false,
      tail = Promise.resolve(),
      nativeSequence = 0,
      acknowledgedThroughSeq = request.nextEventSeq - 1;
    let finishing: { terminal: string; promise: Promise<void> } | undefined;
    const fail = (cause: unknown): void => {
      failed.abort(cause);
    };
    const publish = (candidate: CandidateFact, view = permit.scope): Promise<void> => {
      if (failureSignal.aborted) return Promise.reject(failureSignal.reason);
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
      const pending = tail
        .then(async () => {
          failureSignal.throwIfAborted();
          const receipt = await this.bus.append(fact);
          if (!receipt.durable || receipt.factId !== fact.factId)
            throw new Error("Kafka acknowledgement did not match the appended record");
        })
        .catch((error) => {
          // A known uncertain send stops all native siblings.
          if (!(error instanceof PublicationNotSentError)) fail(error);
          throw error;
        })
        .finally(() => {
          this.#queuedBytes -= bytes;
          this.#queuedFacts--;
        });
      tail = pending.catch(() => {});
      return pending;
    };
    let activityPending = false;
    const pulse = async () => {
      if (closing || finishing || activityPending || failureSignal.aborted) return;
      const resources = [
        ...new Map(
          [...this.#runtimeBindings.values()]
            .filter((b) => b.scope.writerId === permit.scope.writerId && b.resourceUse)
            .map((b) => [JSON.stringify(b.resourceUse), b.resourceUse!]),
        ).values(),
      ];
      if (!resources.length) return;
      activityPending = true;
      try {
        const occurredAt = new Date().toISOString();
        for (let at = 0; at < resources.length; at += 256) {
          if (closing || finishing || failureSignal.aborted) break;
          await publish({
            kind: "session_activity",
            fact: {
              kind: "session_activity",
              factId: randomUUID(),
              scope: observationScope,
              occurredAt,
              resources: resources.slice(at, at + 256),
            },
          });
        }
      } catch {
        /* The publication port already latches uncertain/fenced writes. */
      } finally {
        activityPending = false;
      }
    };
    const activityTimer = setInterval(() => void pulse(), SESSION_ACTIVITY_INTERVAL_MS);
    activityTimer.unref();
    const writer: ExecutionLogWriter = {
      failureSignal,
      assertHealthy: () => {
        if (closing) throw new PublicationNotSentError("Execution writer is closing");
        const cause = failureSignal.reason ?? this.bus.publicationFailure?.(permit.scope);
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
        clearInterval(activityTimer);
        closing = true;
        await tail;
        const cause = failureSignal.reason;
        if (cause)
          throw Object.assign(new Error("Session writer publication failed", { cause }), {
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
            fail(cause);
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
        clearInterval(activityTimer);
        closing = true;
        this.#publishers.delete(request.executionReference);
        for (const [key, binding] of this.#runtimeBindings) {
          if (binding.scope.writerId !== permit.scope.writerId) continue;
          binding.check?.controller.abort();
          this.#runtimeBindings.delete(key);
        }
        await tail;
        this.#writers.delete(request.executionReference);
        this.#conversationFactories.delete(request.executionReference);
        this.#conversationWriters.delete(request.executionReference);
        await this.bus.forget?.(permit.scope);
        failureSignal.throwIfAborted();
      },
    };
    const conversationAcknowledgements = new Map<string, (seq: number) => void>();
    const conversations = new Map<number, ExecutionLogWriter>();
    this.#conversationWriters.set(request.executionReference, conversations);
    this.#conversationFactories.set(request.executionReference, (address) => {
      if (closing || failureSignal.aborted) throw new Error("Root Session writer is closing");
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
      this.#runtimeBindings.set(bindingKey, {
        scope: observationScope,
        successAt: 0,
        ...(address.resourceUse ? { resourceUse: address.resourceUse } : {}),
      });
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
          conversationAcknowledgements.delete(address.sessionId);
          this.#runtimeBindings.get(bindingKey)?.check?.controller.abort();
          this.#runtimeBindings.delete(bindingKey);
          failureSignal.throwIfAborted();
        },
      };
      conversations.set(address.conversationId, view);
      conversationAcknowledgements.set(address.sessionId, (seq) => {
        through = Math.max(through, seq);
      });
      return view;
    });
    this.#writers.set(request.executionReference, writer);
    this.#publishers.set(request.executionReference, publish);
    void pulse();
    return writer;
  }
  async close() {
    await Promise.allSettled([...this.#writers.values()].map((w) => w.close()));
    this.#writers.clear();
    await this.bus.close?.();
  }
}
