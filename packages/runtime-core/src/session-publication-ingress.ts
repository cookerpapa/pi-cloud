import { isDeepStrictEqual } from "node:util";
import {
  MAX_EXECUTION_FACT_BYTES,
  parseExecutionReference,
  validateImageReferencePayload,
} from "@pi-cloud/protocol";
import { PublicationNotSentError } from "@pi-cloud/protocol/native-session";
import { DEFAULT_PRODUCER_CAPACITY, type ProducerCapacity } from "@pi-cloud/event-log";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import type {
  AcceptedExecutionSealFact,
  AcceptedFact,
  AcceptedFactReceipt,
  ExecutionPublication,
} from "./accepted-fact.ts";
import { isNativeAppendFact, toolCommandForFact } from "./tool-invocation-fact.ts";

export type PublicationRecord = Readonly<{
  factId: string;
  sessionId: string;
  value: string;
}>;

/** The transport must fence its predecessor before this owner is installed. */
export interface PartitionPublicationWriter {
  append(record: PublicationRecord): Promise<AcceptedFactReceipt>;
  close(): Promise<void>;
}

type Run = {
  permit: ExecutionPublication;
  closed: boolean;
  sealed: boolean;
  sealId?: string;
  seal?: Promise<AcceptedFactReceipt>;
};
type Writer = {
  id: string;
  epoch: number;
  closing: boolean;
  failure?: unknown;
  runs: Map<string, Run>;
  tail: Promise<void>;
};
export type PublicationOwnership = Readonly<{ partition: number; generation: symbol }>;
export type PublicationAdmission = Readonly<{
  owner: PublicationOwnership;
  key: string;
  current(): boolean;
  release(): void;
}>;
type Partition = {
  owner: PublicationOwnership;
  transport: PartitionPublicationWriter;
  writers: Map<string, Writer>;
  current: boolean;
  admissions: Map<string, Set<{ current: boolean }>>;
};

export class PublicationIngressRejected extends PublicationNotSentError {
  constructor(
    readonly reason: "not_owner" | "not_open" | "closed" | "scope" | "capacity" | "size",
  ) {
    super(`Publication rejected before Kafka admission: ${reason}`);
    this.name = "PublicationIngressRejected";
  }
}

/** Control-plane-installed soft state. No database, lease renewal or native stamping. */
export class SessionPublicationIngress {
  readonly #closures = new Set<Promise<AcceptedFactReceipt>>();
  readonly #partitions = new Map<number, Partition>();
  #pendingBytes = 0;
  #pendingFacts = 0;
  #writerCount = 0;

  constructor(
    readonly capacity: ProducerCapacity = DEFAULT_PRODUCER_CAPACITY,
    readonly maximumWriters = 65_536,
    readonly metrics?: PiCloudMetrics,
  ) {
    for (const value of [
      capacity.maximumPendingBytes,
      capacity.maximumPendingFacts,
      maximumWriters,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid publication capacity");
    this.#observe();
  }

  installPartition(partition: number, transport: PartitionPublicationWriter): PublicationOwnership {
    if (!Number.isSafeInteger(partition) || partition < 0) throw new Error("Invalid partition");
    const previous = this.#partitions.get(partition);
    if (previous?.current) throw new Error("Retire publication ownership before replacement");
    const owner = { partition, generation: Symbol("publication-owner") };
    this.#partitions.set(partition, {
      owner,
      transport,
      writers: new Map(),
      current: true,
      admissions: new Map(),
    });
    return owner;
  }

  ownership(partition: number): PublicationOwnership | undefined {
    const active = this.#partitions.get(partition);
    return active?.current ? active.owner : undefined;
  }

  /** Synchronous revocation also invalidates slow PG admission continuations. */
  revoke(partition: number): Promise<void> {
    const active = this.#partitions.get(partition);
    if (!active) return Promise.resolve();
    active.current = false;
    active.admissions.clear();
    this.#writerCount -= active.writers.size;
    active.writers.clear();
    return active.transport.close();
  }

  #owned(owner: PublicationOwnership): Partition {
    const active = this.#partitions.get(owner.partition);
    if (!active?.current || active.owner !== owner)
      throw new PublicationIngressRejected("not_owner");
    return active;
  }

  #key(scope: ExecutionPublication["scope"]): string {
    return `${scope.tenantId}:${scope.piSessionId}`;
  }

  #reserveWriter(): void {
    if (this.#writerCount >= this.maximumWriters) {
      for (const partition of this.#partitions.values()) {
        const cold = [...partition.writers].find(([, writer]) =>
          [...writer.runs.values()].every((run) => run.sealed),
        );
        if (!cold) continue;
        partition.writers.delete(cold[0]);
        this.#invalidateAdmissions(partition, cold[0]);
        this.#writerCount--;
        break;
      }
      if (this.#writerCount >= this.maximumWriters)
        throw new PublicationIngressRejected("capacity");
    }
    this.#writerCount++;
  }

  /** Track only in-flight PG reads. Unrelated Sessions never invalidate them. */
  beginAdmission(
    owner: PublicationOwnership,
    scope: ExecutionPublication["scope"],
  ): PublicationAdmission {
    const partition = this.#owned(owner),
      key = this.#key(scope),
      ticket = { current: true };
    let readers = partition.admissions.get(key);
    if (!readers) partition.admissions.set(key, (readers = new Set()));
    readers.add(ticket);
    const active = readers;
    return {
      owner,
      key,
      current: () => ticket.current && partition.current,
      release: () => {
        ticket.current = false;
        active.delete(ticket);
        if (!active.size && partition.admissions.get(key) === active)
          partition.admissions.delete(key);
      },
    };
  }

  #invalidateAdmissions(partition: Partition, key: string): void {
    for (const ticket of partition.admissions.get(key) ?? []) ticket.current = false;
  }

  /** Called only after control-plane admission verifies the committed PG grant. */
  installRun(
    owner: PublicationOwnership,
    publication: ExecutionPublication,
    admission?: PublicationAdmission,
  ): void {
    const partition = this.#owned(owner),
      permit = structuredClone(publication),
      scope = permit.scope;
    if (
      admission &&
      (admission.owner !== owner || admission.key !== this.#key(scope) || !admission.current())
    )
      throw new PublicationIngressRejected("not_open");
    if (
      scope.writerId !== scope.leaseId ||
      !Number.isSafeInteger(scope.fencingToken) ||
      scope.fencingToken < 1
    )
      throw new PublicationIngressRejected("scope");
    const key = this.#key(scope);
    let writer = partition.writers.get(key);
    if (
      writer &&
      (scope.fencingToken < writer.epoch ||
        (scope.fencingToken === writer.epoch && scope.writerId !== writer.id))
    )
      throw new PublicationIngressRejected("scope");
    if (!writer || scope.fencingToken > writer.epoch) {
      if (writer && [...writer.runs.values()].some((run) => !run.sealed))
        throw new PublicationIngressRejected("not_open");
      // Closed state is recoverable from PG on explicit admission. The budget
      // is process-wide, independent of the assigned partition count.
      if (!writer) this.#reserveWriter();
      writer = {
        id: scope.writerId,
        epoch: scope.fencingToken,
        closing: false,
        runs: new Map(),
        tail: Promise.resolve(),
      };
      partition.writers.set(key, writer);
      this.#invalidateAdmissions(partition, key);
    }
    if (writer.closing) throw new PublicationIngressRejected("closed");
    const existing = writer.runs.get(scope.runId);
    if (existing) {
      if (!isDeepStrictEqual(existing.permit, permit))
        throw new PublicationIngressRejected("scope");
      if (existing.closed || existing.seal) throw new PublicationIngressRejected("closed");
      return;
    }
    if (writer.runs.size >= 4096) {
      const closed = [...writer.runs].find(([, run]) => run.sealed);
      if (!closed) throw new PublicationIngressRejected("capacity");
      writer.runs.delete(closed[0]);
    }
    writer.runs.set(scope.runId, { permit, closed: false, sealed: false });
  }

  append(
    owner: PublicationOwnership,
    fact: Exclude<AcceptedFact, AcceptedExecutionSealFact>,
  ): Promise<AcceptedFactReceipt> {
    try {
      const partition = this.#owned(owner);
      const writer = partition.writers.get(`${fact.scope.tenantId}:${fact.scope.piSessionId}`);
      if (!writer) throw new PublicationIngressRejected("not_open");
      const run = writer.runs.get(fact.scope.runId);
      if (!run) throw new PublicationIngressRejected("not_open");
      if (writer.closing || run.closed || run.seal) throw new PublicationIngressRejected("closed");
      this.#validate(run.permit, fact);
      return this.#enqueue(partition, writer, fact);
    } catch (error) {
      return Promise.reject(
        error instanceof PublicationNotSentError ? error : new PublicationIngressRejected("scope"),
      );
    }
  }

  /** PG has verified this exact immutable Outbox fact before calling here. */
  seal(
    owner: PublicationOwnership,
    fact: AcceptedExecutionSealFact,
    beforePublish?: () => Promise<void>,
  ): Promise<AcceptedFactReceipt> {
    try {
      const partition = this.#owned(owner);
      const key = `${fact.scope.tenantId}:${fact.scope.piSessionId}`;
      this.#invalidateAdmissions(partition, key);
      let writer = partition.writers.get(key);
      if (!writer) {
        this.#reserveWriter();
        // An execution can close before it ever opens a publication channel.
        writer = {
          id: fact.scope.writerId,
          epoch: fact.scope.fencingToken,
          closing: false,
          runs: new Map(),
          tail: Promise.resolve(),
        };
        partition.writers.set(key, writer);
      }
      if (writer.id !== fact.scope.writerId || writer.epoch !== fact.scope.fencingToken)
        throw new PublicationIngressRejected("scope");
      let run = writer.runs.get(fact.scope.runId);
      if (!run) {
        run = {
          permit: { scope: { ...fact.scope, leaseId: fact.scope.writerId, piSessionLane: "" } },
          closed: false,
          sealed: false,
        };
        writer.runs.set(fact.scope.runId, run);
      }
      if (run.sealId && run.sealId !== fact.factId) throw new PublicationIngressRejected("scope");
      if (run.seal) return run.seal;
      // Close BEFORE waiting for prior deliveries, including on capacity failure.
      run.closed = true;
      run.sealId = fact.factId;
      if (fact.closesWriter) writer.closing = true;
      const target = run;
      const closingWriter = writer;
      // External execution closure runs after in-memory admission closes, and
      // outside the Kafka writer queue so unrelated Sessions keep publishing.
      const pending = (
        beforePublish
          ? Promise.resolve()
              .then(beforePublish)
              .then(() => this.#enqueue(partition, closingWriter, fact))
          : this.#enqueue(partition, writer, fact)
      ).then((receipt) => {
        target.sealed = true;
        return receipt;
      });
      run.seal = pending;
      this.#closures.add(pending);
      void pending.then(
        () => this.#closures.delete(pending),
        () => this.#closures.delete(pending),
      );
      void pending.catch(() => {
        if (target.seal === pending) delete target.seal;
      });
      return pending;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** The same partition's Projector has committed this seal to canonical PG. */
  confirmSealed(owner: PublicationOwnership, fact: AcceptedExecutionSealFact): void {
    const partition = this.#owned(owner);
    const key = `${fact.scope.tenantId}:${fact.scope.piSessionId}`;
    this.#invalidateAdmissions(partition, key);
    const writer = partition.writers.get(key);
    if (!writer || writer.id !== fact.scope.writerId) return;
    const run = writer.runs.get(fact.scope.runId);
    if (!run) return;
    if (run.sealId && run.sealId !== fact.factId)
      throw new Error("Projected seal identity changed");
    run.closed = true;
    run.sealed = true;
    run.sealId = fact.factId;
    run.seal = Promise.resolve({ factId: fact.factId, durable: true });
    if (fact.closesWriter) writer.closing = true;
  }

  #validate(permit: ExecutionPublication, fact: AcceptedFact): void {
    const { leaseId, piSessionLane, ...scope } = permit.scope;
    if (
      !isDeepStrictEqual(fact.scope, fact.kind === "tool_command" ? { ...scope, leaseId } : scope)
    )
      throw new PublicationIngressRejected("scope");
    if (
      fact.kind === "agent_event" &&
      (fact.event.sessionId !== scope.sessionId || fact.event.turnId !== scope.turnId)
    )
      throw new PublicationIngressRejected("scope");
    if (fact.kind === "subagent_command") {
      const execution = parseExecutionReference(fact.executionReference);
      if (
        execution.leaseId !== leaseId ||
        execution.runId !== scope.runId ||
        execution.fencingToken !== scope.fencingToken
      )
        throw new PublicationIngressRejected("scope");
    }
    if (isNativeAppendFact(fact)) {
      validateImageReferencePayload(fact.items);
      if (
        fact.piSession.id !== scope.piSessionId ||
        fact.piSession.lane !== piSessionLane ||
        fact.piSession.writerId !== scope.writerId
      )
        throw new PublicationIngressRejected("scope");
      toolCommandForFact(fact);
      if (
        fact.items.some((item) =>
          item.kind === "entry"
            ? item.lane !== piSessionLane
            : item.kind === "record"
              ? item.record.lane !== piSessionLane
              : item.kind === "lane"
                ? !item.create && item.lane !== piSessionLane
                : piSessionLane !== "main",
        )
      )
        throw new PublicationIngressRejected("scope");
      if (
        fact.events.some(
          (event) => event.sessionId !== scope.sessionId || event.turnId !== scope.turnId,
        )
      )
        throw new PublicationIngressRejected("scope");
    }
  }

  #enqueue(partition: Partition, writer: Writer, fact: AcceptedFact): Promise<AcceptedFactReceipt> {
    const record = {
      factId: fact.factId,
      sessionId: fact.scope.piSessionId,
      value: JSON.stringify(fact),
    };
    const semantic = fact.kind !== "path_probe";
    const bytes = Buffer.byteLength(record.value);
    if (bytes > MAX_EXECUTION_FACT_BYTES) throw new PublicationIngressRejected("size");
    if (
      this.#pendingFacts >= this.capacity.maximumPendingFacts ||
      this.#pendingBytes + bytes > this.capacity.maximumPendingBytes
    ) {
      this.metrics?.kafkaProducerRejected.inc();
      throw new PublicationIngressRejected("capacity");
    }
    this.#pendingFacts++;
    this.#pendingBytes += bytes;
    this.#observe();
    const enqueuedAt = performance.now();
    const pending = writer.tail
      .then(async () => {
        this.#owned(partition.owner);
        if (writer.failure && fact.kind !== "execution_seal")
          throw new PublicationNotSentError("Writer stopped before queued publication was sent");
        try {
          const submittedAt = performance.now();
          this.metrics?.observeSessionMutation("producer_queue", submittedAt - enqueuedAt);
          const receipt = await partition.transport.append(record);
          if (!receipt.durable || receipt.factId !== record.factId)
            throw new Error("Publication commit receipt mismatch");
          this.metrics?.observeSessionMutation("producer_ack", performance.now() - submittedAt);
          return receipt;
        } catch (error) {
          if (semantic && !(error instanceof PublicationNotSentError)) {
            writer.closing = true;
            writer.failure = error;
          }
          throw error;
        }
      })
      .finally(() => {
        this.#pendingFacts--;
        this.#pendingBytes -= bytes;
        this.#observe();
      });
    writer.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  statistics() {
    return { pendingFacts: this.#pendingFacts, pendingBytes: this.#pendingBytes };
  }

  #observe(): void {
    this.metrics?.kafkaProducerPendingBytes.set(this.#pendingBytes);
    this.metrics?.kafkaProducerPendingFacts.set(this.#pendingFacts);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#partitions.keys()].map((p) => this.revoke(p)));
    await Promise.allSettled(this.#closures);
    this.#partitions.clear();
  }
}
