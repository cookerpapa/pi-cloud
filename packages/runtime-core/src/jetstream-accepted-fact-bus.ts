import type { AcceptedFact, AcceptedFactBus, AcceptedFactReceipt } from "./accepted-fact.ts";
import { JetStreamAcceptedAgentEventPublisher } from "./jetstream-agent-event-log.ts";
import { JetStreamAcceptedPiSessionMutationPublisher } from "./jetstream-pi-session-mutations.ts";
import type { PiCloudJetStream } from "./jetstream-runtime.ts";

export class JetStreamAcceptedFactBus implements AcceptedFactBus {
  readonly #events: JetStreamAcceptedAgentEventPublisher;
  readonly #mutations: JetStreamAcceptedPiSessionMutationPublisher;

  constructor(runtime: PiCloudJetStream) {
    this.#events = new JetStreamAcceptedAgentEventPublisher(runtime);
    this.#mutations = new JetStreamAcceptedPiSessionMutationPublisher(runtime);
  }

  async append(fact: AcceptedFact): Promise<AcceptedFactReceipt> {
    if (fact.kind === "agent_event") {
      await this.#events.append({
        schemaVersion: 2,
        tenantId: fact.scope.tenantId,
        events: [fact.event],
      });
    } else {
      await this.#mutations.append({
        schemaVersion: 2,
        mutationId: fact.factId,
        scope: {
          tenantId: fact.scope.tenantId,
          sessionId: fact.scope.sessionId,
          turnId: fact.scope.turnId,
          runId: fact.scope.runId,
          executionId: fact.scope.executionId,
        },
        operation: fact.operation,
        occurredAt: fact.occurredAt,
      });
    }
    return { factId: fact.factId, durable: true };
  }

  async checkHealth(): Promise<void> {
    await Promise.all([this.#events.checkHealth(), this.#mutations.checkHealth()]);
  }
}
