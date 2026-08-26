import type { PiSessionMutationOperation } from "@pi-cloud/pi-session-postgres";
import { parsePiCloudEvent, type EventPublishMessage, type PiCloudEvent } from "@pi-cloud/protocol";

export type AcceptedAgentEventEnvelope = Readonly<{
  schemaVersion: 2;
  tenantId: string;
  events: readonly PiCloudEvent[];
}>;

export function parseAcceptedAgentEventEnvelope(
  value: Uint8Array | Buffer | string,
): AcceptedAgentEventEnvelope {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  const candidate = JSON.parse(text) as unknown;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError("Accepted Agent event envelope is invalid");
  }
  const envelope = candidate as Record<string, unknown>;
  if (
    envelope.schemaVersion !== 2 ||
    typeof envelope.tenantId !== "string" ||
    envelope.tenantId.length < 1 ||
    envelope.tenantId.length > 256 ||
    !Array.isArray(envelope.events) ||
    envelope.events.length < 1 ||
    envelope.events.length > 128
  ) {
    throw new TypeError("Accepted Agent event envelope is invalid");
  }
  const events = envelope.events.map(parsePiCloudEvent);
  const sessionId = events[0]!.sessionId;
  if (events.some((event) => event.sessionId !== sessionId)) {
    throw new TypeError("Accepted Agent event envelope mixes Sessions");
  }
  return { schemaVersion: 2, tenantId: envelope.tenantId, events };
}

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
