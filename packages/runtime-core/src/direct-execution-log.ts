import { randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { parseSupervisorToControlMessage } from "@pi-cloud/protocol";
import type {
  ActiveExecutionLogResolver,
  AcceptedFactBus,
  CandidateFact,
  ExecutionOpenedFact,
} from "./accepted-fact.ts";
import type {
  ExecutionLogWriter,
  ExecutionLogFactory,
  ExecutionLogOpenRequest,
} from "./durable-event-store.ts";
import { openExecutionPublication } from "./execution-publication.ts";
import { prepareExecutionFact } from "./prepare-execution-fact.ts";
import { DEFAULT_PRODUCER_CAPACITY, type ProducerCapacity } from "@pi-cloud/event-log";
import { AcceptedFactCapacityError } from "./accepted-fact.ts";

/** Worker-owned producer port. No remote data gateway or second lease renewer. */
export class DirectExecutionLog implements ExecutionLogFactory, ActiveExecutionLogResolver {
  readonly #writers = new Map<string, ExecutionLogWriter>();
  #queuedBytes = 0;
  #queuedFacts = 0;
  constructor(
    readonly database: Kysely<Database>,
    readonly bus: AcceptedFactBus & { close?(): Promise<void> },
    readonly capacity: ProducerCapacity = DEFAULT_PRODUCER_CAPACITY,
  ) {}
  resolve(lease: string) {
    return this.#writers.get(lease);
  }
  async checkHealth() {
    await this.bus.checkHealth();
  }
  async open(request: ExecutionLogOpenRequest): Promise<ExecutionLogWriter> {
    if (this.#writers.has(request.executionLease)) throw new Error("Execution writer already open");
    const permit = await openExecutionPublication(this.database, request);
    const { leaseId: _leaseId, piSessionLane: _lane, ...scope } = permit.scope;
    const opening: ExecutionOpenedFact = {
      kind: "execution_opened",
      factId: permit.id,
      scope,
      publication: permit,
      occurredAt: new Date().toISOString(),
    };
    await this.bus.append(opening);
    let closing = false,
      failure: unknown,
      tail = Promise.resolve(),
      acknowledgedThroughSeq = request.nextEventSeq - 1;
    const publish = (candidate: CandidateFact): Promise<void> => {
      if (closing || failure)
        return Promise.reject(failure ?? new Error("Execution writer closed"));
      const fact = prepareExecutionFact(
        { ...permit.scope, executionLease: request.executionLease },
        candidate,
      );
      const bytes = Buffer.byteLength(JSON.stringify(fact));
      if (
        this.#queuedFacts >= this.capacity.maximumPendingFacts ||
        this.#queuedBytes + bytes > this.capacity.maximumPendingBytes
      ) {
        failure = new AcceptedFactCapacityError();
        return Promise.reject(failure);
      }
      this.#queuedBytes += bytes;
      this.#queuedFacts++;
      const pending = tail
        .then(async () => {
          if (failure) throw failure;
          const receipt = await this.bus.append(fact);
          if (!receipt.durable || receipt.factId !== fact.factId)
            throw new Error("Kafka acknowledgement did not match the appended record");
        })
        .finally(() => {
          this.#queuedBytes -= bytes;
          this.#queuedFacts--;
        });
      tail = pending.catch((error) => {
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
            executionLease: request.executionLease,
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
        await publish({ kind: "tool_command", command });
        return { operationId: command.request.operationId, accepted: true };
      },
      close: async () => {
        closing = true;
        await tail;
        this.#writers.delete(request.executionLease);
        if (failure) throw failure;
        await this.database
          .updateTable("run_attempts")
          .set({ native_output_drained: true, last_event_seq: acknowledgedThroughSeq })
          .where("id", "=", permit.scope.attemptId)
          .where("output_sealed_at", "is", null)
          .execute();
      },
    };
    this.#writers.set(request.executionLease, writer);
    return writer;
  }
  async close() {
    await Promise.allSettled([...this.#writers.values()].map((w) => w.close()));
    this.#writers.clear();
    await this.bus.close?.();
  }
}
