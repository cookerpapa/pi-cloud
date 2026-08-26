import type { PiSessionMutationOperation } from "@pi-cloud/pi-session-postgres";
import type { EventPublishMessage, PiCloudEvent } from "@pi-cloud/protocol";

export type CandidatePiSessionMutationFact = Readonly<{
  schemaVersion: 1;
  mutationId: string;
  scope: Readonly<{
    tenantId: string;
    sessionId: string;
    turnId: string;
    runId: string;
    executionGrant: string;
  }>;
  operation: PiSessionMutationOperation;
  occurredAt: string;
}>;

export type CandidateFact =
  | Readonly<{ kind: "agent_event"; publication: EventPublishMessage }>
  | Readonly<{ kind: "pi_session_mutation"; mutation: CandidatePiSessionMutationFact }>;

export type AcceptedFactScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  executionId: string;
  executionGeneration: number;
}>;

export type AcceptedAgentEventFact = Readonly<{
  kind: "agent_event";
  factId: string;
  scope: AcceptedFactScope;
  event: PiCloudEvent;
  occurredAt: string;
}>;

export type AcceptedPiSessionMutationFact = Readonly<{
  kind: "pi_session_mutation";
  factId: string;
  scope: AcceptedFactScope;
  operation: PiSessionMutationOperation;
  occurredAt: string;
}>;

export type AcceptedFact = AcceptedAgentEventFact | AcceptedPiSessionMutationFact;

export type AcceptedFactReceipt = Readonly<{
  factId: string;
  durable: true;
}>;

export interface AcceptedFactBus {
  append(fact: AcceptedFact): Promise<AcceptedFactReceipt>;
  checkHealth(): Promise<void>;
}
