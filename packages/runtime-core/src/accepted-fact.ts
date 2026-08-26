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

export type AcceptedTerminalEventFact = Readonly<{
  kind: "terminal_event";
  factId: string;
  scope: Readonly<{
    tenantId: string;
    sessionId: string;
    runId: string;
    turnId: string;
  }>;
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

export type AcceptedFact =
  AcceptedAgentEventFact | AcceptedTerminalEventFact | AcceptedPiSessionMutationFact;

export type AcceptedFactReceipt = Readonly<{
  factId: string;
  durable: true;
}>;

export interface AcceptedFactBus {
  append(fact: AcceptedFact): Promise<AcceptedFactReceipt>;
  checkHealth(): Promise<void>;
}

export type AcceptedAgentEventProgress = Readonly<{
  grantId: string;
  executionId: string;
  executionGeneration: number;
  channelConnectionId: string;
  channelInstanceId: string;
  acknowledgedThroughSeq: number;
}>;

export interface AcceptedFactProgressStore {
  recordMany(progress: readonly AcceptedAgentEventProgress[]): Promise<ReadonlySet<string>>;
}

export type PiSessionMutationPublishFrame = Readonly<{
  protocolVersion: 1;
  messageId: string;
  sentAt: string;
  type: "fact.pi_session_mutation.publish";
  payload: CandidatePiSessionMutationFact;
}>;

export type PiSessionMutationAcceptedFrame = Readonly<{
  protocolVersion: 1;
  messageId: string;
  sentAt: string;
  type: "fact.pi_session_mutation.accepted";
  payload: Readonly<{
    acknowledgedMessageId: string;
    mutationId: string;
    accepted: true;
  }>;
}>;

export interface PiSessionMutationFactChannel {
  mutate(
    mutation: CandidatePiSessionMutationFact,
  ): Promise<Readonly<{ mutationId: string; accepted: true }>>;
}

export interface ActiveFactChannelResolver {
  resolve(executionGrant: string): PiSessionMutationFactChannel | undefined;
  checkHealth(): Promise<void>;
}
