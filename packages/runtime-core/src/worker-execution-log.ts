import { randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { parseSupervisorToControlMessage, RUN_PATH_PROBE_INTERVAL_MS } from "@pi-cloud/protocol";
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
import { PublicationNotSentError } from "@pi-cloud/protocol/native-session";
import type { AcceptedFact } from "./accepted-fact.ts";

/** Worker-local ordering over control-plane publication; no second lease renewer. */
export class WorkerExecutionLog implements ExecutionLogFactory, ActiveExecutionLogResolver {
  readonly #writers = new Map<string, ExecutionLogWriter>();
  readonly #opening = new Set<string>();
  readonly #families = new Map<
    string,
    {
      touched: number;
      pending: boolean;
      writers: Map<string, { ready(): boolean; send(): Promise<void> }>;
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
        if (family.pending || performance.now() - family.touched < this.probeIntervalMs) continue;
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
  resolve(lease: string) {
    return this.#writers.get(lease);
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
          if (!(error instanceof PublicationNotSentError)) failure = error;
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
      mutate: async (mutation) => {
        await publish({ kind: "pi_session_append", mutation });
        for (const event of mutation.events)
          acknowledgedThroughSeq = Math.max(acknowledgedThroughSeq, event.seq);
        return { mutationId: mutation.mutationId, accepted: true };
      },
      publishToolCommand: async (command) => {
        if (command.request.operation === "tool.execute")
          throw new Error("Fixed Tool commands require an atomic native intent publication");
        await publish({ kind: "tool_command", command });
        return { operationId: command.request.operationId, accepted: true };
      },
      publishSubagentCommand: async (command) => {
        await publish({ kind: "subagent_command", command });
      },
      close: async () => {
        closing = true;
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
          .where("output_sealed_at", "is", null)
          .execute();
      },
    };
    this.#writers.set(request.executionReference, writer);
    activeFamily.writers.set(request.executionReference, {
      ready: () => !closing && !failure && published,
      send: async () => {
        // Probes never establish a recovery floor or consume native/display sequence.
        if (closing || failure || !published) return;
        await publish({
          kind: "path_probe",
          factId: randomUUID(),
          occurredAt: new Date().toISOString(),
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
