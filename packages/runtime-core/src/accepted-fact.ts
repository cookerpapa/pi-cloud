import type { PiSessionMutationOperation } from "@pi-cloud/pi-session-postgres";
import type { EventPublishMessage, PiCloudEvent, PiCloudEventBody } from "@pi-cloud/protocol";
import type {
  AcceptedToolCommand,
  CandidateToolCommand,
  ToolCommandPublisher,
} from "@pi-cloud/protocol";

export type CandidatePiSessionMutationFact = Readonly<{
  schemaVersion: 1;
  mutationId: string;
  scope: Readonly<{
    tenantId: string;
    sessionId: string;
    piSessionId: string;
    piSessionLane: string;
    turnId: string;
    runId: string;
    executionLease: string;
  }>;
  operation: PiSessionMutationOperation;
  events: readonly PiCloudEvent[];
  occurredAt: string;
}>;

export type CandidateFact =
  | Readonly<{ kind: "tool_command"; command: CandidateToolCommand }>
  | Readonly<{ kind: "agent_event"; publication: EventPublishMessage }>
  | Readonly<{ kind: "pi_session_mutation"; mutation: CandidatePiSessionMutationFact }>;

export type AcceptedFactScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  fencingToken: number;
}>;

export type AcceptedAgentEventFact = Readonly<{
  kind: "agent_event";
  factId: string;
  scope: AcceptedFactScope;
  event: PiCloudEvent;
  occurredAt: string;
}>;

export type AcceptedExecutionSealFact = Readonly<{
  kind: "execution_seal";
  factId: string;
  scope: AcceptedFactScope;
  agentId: string;
  baseSequence: number;
  terminal: Extract<
    PiCloudEventBody,
    { type: "turn.completed" | "turn.failed" | "turn.cancelled" }
  >;
  occurredAt: string;
}>;

/** A canonical transaction's durable notification, never produced by a Worker. */
export type AcceptedExecutionCommitFact = Readonly<{
  kind: "execution_committed";
  factId: string;
  scope: AcceptedFactScope;
  seal: Readonly<{ factId: string; topic: string; partition: number; offset: string }>;
  event: Extract<PiCloudEvent, { type: "turn.completed" | "turn.failed" | "turn.cancelled" }>;
  occurredAt: string;
}>;

export type AcceptedPiSessionMutationFact = Readonly<{
  kind: "pi_session_mutation";
  factId: string;
  scope: AcceptedFactScope;
  piSession: Readonly<{ id: string; lane: string }>;
  operation: PiSessionMutationOperation;
  events: readonly PiCloudEvent[];
  occurredAt: string;
}>;

export type AcceptedFact =
  | AcceptedToolCommand
  | AcceptedAgentEventFact
  | AcceptedExecutionSealFact
  | AcceptedExecutionCommitFact
  | AcceptedPiSessionMutationFact;

export type AcceptedFactReceipt = Readonly<{
  factId: string;
  durable: true;
}>;

export interface AcceptedFactBus {
  append(fact: AcceptedFact): Promise<AcceptedFactReceipt>;
  checkHealth(): Promise<void>;
}

export type AcceptedAgentEventProgress = Readonly<{
  leaseId: string;
  attemptId: string;
  fencingToken: number;
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
  resolve(executionLease: string): AcceptedFactWriter | undefined;
  checkHealth(): Promise<void>;
}

export interface AcceptedFactWriter extends PiSessionMutationFactChannel, ToolCommandPublisher {}
