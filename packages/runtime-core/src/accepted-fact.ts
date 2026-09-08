import type { PiCommittedItem } from "@pi-cloud/pi-session-postgres";
import type { EventPublishMessage, PiCloudEvent, PiCloudEventBody } from "@pi-cloud/protocol";
import type {
  AcceptedToolCommand,
  CandidateToolCommand,
  ToolCommandPublisher,
} from "@pi-cloud/protocol";

export type CandidatePiSessionAppendFact = Readonly<{
  schemaVersion: 1;
  mutationId: string;
  scope: Readonly<{
    tenantId: string;
    sessionId: string;
    piSessionId: string;
    piSessionLane: string;
    writerId: string;
    turnId: string;
    runId: string;
    executionLease: string;
  }>;
  items: readonly PiCommittedItem[];
  events: readonly PiCloudEvent[];
  occurredAt: string;
}>;

export type CandidateFact =
  | Readonly<{ kind: "tool_command"; command: CandidateToolCommand }>
  | Readonly<{ kind: "agent_event"; publication: EventPublishMessage }>
  | Readonly<{ kind: "pi_session_append"; mutation: CandidatePiSessionAppendFact }>;

export type AcceptedFactScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  fencingToken: number;
  piSessionId: string;
  writerId: string;
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
  closesWriter: boolean;
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

export type AcceptedPiSessionAppendFact = Readonly<{
  kind: "pi_session_append";
  factId: string;
  scope: AcceptedFactScope;
  piSession: Readonly<{ id: string; lane: string; writerId: string }>;
  items: readonly PiCommittedItem[];
  events: readonly PiCloudEvent[];
  occurredAt: string;
}>;

export type AcceptedFact =
  | AcceptedToolCommand
  | AcceptedAgentEventFact
  | AcceptedExecutionSealFact
  | AcceptedExecutionCommitFact
  | AcceptedPiSessionAppendFact;

export type AcceptedFactReceipt = Readonly<{
  factId: string;
  durable: true;
}>;

export class AcceptedFactCapacityError extends Error {
  readonly code = "event_capacity_exhausted";
  readonly retryable = true;
  constructor() {
    super("AcceptedFact transport is at capacity; the Fact was not enqueued");
  }
}

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

export type PiSessionAppendPublishFrame = Readonly<{
  protocolVersion: 1;
  messageId: string;
  sentAt: string;
  type: "fact.pi_session_append.publish";
  payload: CandidatePiSessionAppendFact;
}>;

export type PiSessionAppendAcceptedFrame = Readonly<{
  protocolVersion: 1;
  messageId: string;
  sentAt: string;
  type: "fact.pi_session_append.accepted";
  payload: Readonly<{
    acknowledgedMessageId: string;
    mutationId: string;
    accepted: true;
  }>;
}>;

export interface PiSessionAppendFactChannel {
  mutate(
    mutation: CandidatePiSessionAppendFact,
  ): Promise<Readonly<{ mutationId: string; accepted: true }>>;
}

export interface ActiveFactChannelResolver {
  resolve(executionLease: string): AcceptedFactWriter | undefined;
  checkHealth(): Promise<void>;
}

export interface AcceptedFactWriter extends PiSessionAppendFactChannel, ToolCommandPublisher {}
