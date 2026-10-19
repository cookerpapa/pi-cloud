import { ResourceLimitSchema } from "./protocol-primitives.ts";
import { MAX_AGENT_INPUT_CHARACTERS, assertUserInputBudget } from "./agent-input-budget.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createSchemaCheck } from "#schema-check";
import { PiCloudEventSchema, TurnCancellationReasonSchema } from "./event-envelope.ts";
import {
  NonNegativeSafeIntegerSchema,
  OpaqueIdSchema,
  PositiveSafeIntegerSchema,
  ExecutionModeSchema,
  TraceContextSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";
import { EnvironmentRuntimeSnapshotSchema } from "./environment.ts";
import { DevelopmentEnvironmentProfileKeySchema } from "./development-environment-profile.ts";
import { CloudToolCapabilitySnapshotSchema } from "./tool-capabilities.ts";
import { ExecutionReferenceSchema } from "./execution-reference.ts";
import { AgentRevisionSnapshotSchema } from "./agent-runtime.ts";
import { UserUploadsSchema } from "./user-upload.ts";

const WireEnvelopeProperties = {
  protocolVersion: Type.Literal(1),
  messageId: UuidSchema,
  sentAt: UtcTimestampSchema,
};

const CommandIdentityProperties = {
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  tenantId: OpaqueIdSchema,
  projectId: OpaqueIdSchema,
  workspaceId: OpaqueIdSchema,
  sessionId: OpaqueIdSchema,
  runId: UuidSchema,
  turnId: OpaqueIdSchema,
  agentId: OpaqueIdSchema,
  executionReference: ExecutionReferenceSchema,
};

const PiSessionConversationBindingSchema = Type.Object(
  {
    id: OpaqueIdSchema,
    conversationId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    writerId: UuidSchema,
  },
  { additionalProperties: false },
);

const RuntimeVersionSchema = Type.String({
  minLength: 5,
  maxLength: 128,
  pattern: "^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$",
});

const CapabilitySchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
});

const PromptInputSchema = Type.Object(
  {
    kind: Type.Literal("prompt"),
    text: Type.String({ maxLength: MAX_AGENT_INPUT_CHARACTERS }),
    uploads: Type.Optional(UserUploadsSchema),
  },
  { additionalProperties: false },
);

const ModelThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const TurnModelSnapshotSchema = Type.Object(
  {
    profileId: OpaqueIdSchema,
    provider: OpaqueIdSchema,
    modelId: OpaqueIdSchema,
    thinkingLevel: ModelThinkingLevelSchema,
    serviceTier: Type.Union([Type.Literal("fast"), Type.Null()]),
    credentialBindingId: OpaqueIdSchema,
    credentialBindingVersion: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const TurnBudgetSnapshotSchema = Type.Object(
  {
    maximumModelRequests: ResourceLimitSchema,
    consumedModelRequests: Type.Optional(Type.Integer({ minimum: 0 })),
    maximumToolCalls: ResourceLimitSchema,
    remainingToolCalls: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    maximumToolOutputBytes: Type.Integer({ minimum: 1_024, maximum: 1_048_576 }),
    maximumRunDurationMs: Type.Integer({ minimum: 1_000, maximum: 3_600_000 }),
    compactionReserveTokens: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
    compactionKeepRecentTokens: Type.Integer({ minimum: 1_024, maximum: 1_000_000 }),
  },
  { additionalProperties: false },
);
export type TurnBudgetSnapshot = Static<typeof TurnBudgetSnapshotSchema>;

export const SupervisorRegisterMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("supervisor.register"),
    payload: Type.Object(
      {
        supervisorId: OpaqueIdSchema,
        bootId: UuidSchema,
        sandboxId: OpaqueIdSchema,
        supervisorVersion: RuntimeVersionSchema,
        pi: Type.Object(
          {
            packageName: Type.String({ minLength: 1, maxLength: 256 }),
            version: RuntimeVersionSchema,
          },
          { additionalProperties: false },
        ),
        supportedProtocolVersions: Type.Array(PositiveSafeIntegerSchema, {
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
        }),
        capabilities: Type.Array(CapabilitySchema, {
          maxItems: 256,
          uniqueItems: true,
        }),
        acceptingAssignments: Type.Boolean(),
        maxConcurrentSessions: ResourceLimitSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SupervisorRegisteredMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("supervisor.registered"),
    payload: Type.Object(
      {
        supervisorId: OpaqueIdSchema,
        bootId: UuidSchema,
        connectionId: UuidSchema,
        selectedProtocolVersion: Type.Literal(1),
        heartbeatIntervalMs: PositiveSafeIntegerSchema,
        heartbeatTimeoutMs: PositiveSafeIntegerSchema,
        serverTime: UtcTimestampSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

import { ConversationWorkViewSchema } from "./conversation-work.ts";
export const ExecuteTurnCommandMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.turn.execute"),
    payload: Type.Object(
      {
        ...CommandIdentityProperties,
        piSession: PiSessionConversationBindingSchema,
        conversationWork: Type.Optional(ConversationWorkViewSchema),
        nextEventSeq: PositiveSafeIntegerSchema,
        stopOnResume: Type.Optional(Type.Literal(true)),
        agent: AgentRevisionSnapshotSchema,
        input: Type.Union([
          PromptInputSchema,
          Type.Object({ kind: Type.Literal("resume") }, { additionalProperties: false }),
        ]),
        sessionKind: Type.Union([Type.Literal("conversation"), Type.Literal("subagent")]),
        workspaceSeedKind: Type.Union([Type.Literal("empty"), Type.Literal("sample_java")]),
        executionMode: ExecutionModeSchema,
        computeSessionId: Type.Optional(UuidSchema),
        sandboxProfileKey: DevelopmentEnvironmentProfileKeySchema,
        workingDirectory: Type.String({
          minLength: 1,
          maxLength: 4_096,
          pattern: "^/",
        }),
        toolCapabilities: CloudToolCapabilitySnapshotSchema,
        agentSystemPrompt: Type.Optional(
          Type.String({ minLength: 1, maxLength: MAX_AGENT_INPUT_CHARACTERS }),
        ),
        model: TurnModelSnapshotSchema,
        environment: EnvironmentRuntimeSnapshotSchema,
        budgets: Type.Optional(TurnBudgetSnapshotSchema),
        traceContext: Type.Optional(TraceContextSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CancelTurnCommandMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.turn.cancel"),
    payload: Type.Object(
      {
        ...CommandIdentityProperties,
        controlRequestId: UuidSchema,
        targetRunId: UuidSchema,
        reason: TurnCancellationReasonSchema,
        gracePeriodMs: Type.Optional(NonNegativeSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const CommandAckIdentityProperties = {
  requestId: UuidSchema,
  sessionId: OpaqueIdSchema,
  turnId: OpaqueIdSchema,
  executionReference: ExecutionReferenceSchema,
};

const AcceptedCommandAckPayloadSchema = Type.Object(
  {
    ...CommandAckIdentityProperties,
    status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  },
  { additionalProperties: false },
);

const RejectedCommandAckPayloadSchema = Type.Object(
  {
    ...CommandAckIdentityProperties,
    status: Type.Literal("rejected"),
    code: Type.Union([
      Type.Literal("stale_session_lease"),
      Type.Literal("invalid_state"),
      Type.Literal("capacity"),
      Type.Literal("invalid_command"),
      Type.Literal("unsupported"),
    ]),
    message: Type.String({ minLength: 1, maxLength: 4_096 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CommandAckMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("command.ack"),
    payload: Type.Union([AcceptedCommandAckPayloadSchema, RejectedCommandAckPayloadSchema]),
  },
  { additionalProperties: false },
);

export const EventPublishMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("event.publish"),
    payload: Type.Object(
      {
        executionReference: ExecutionReferenceSchema,
        event: PiCloudEventSchema,
        nativeSequence: Type.Optional(PositiveSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EventAckMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("event.ack"),
    payload: Type.Object(
      {
        sessionId: OpaqueIdSchema,
        executionReference: ExecutionReferenceSchema,
        acknowledgedThroughSeq: PositiveSafeIntegerSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EventRejectedMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("event.rejected"),
    payload: Type.Object(
      {
        sessionId: OpaqueIdSchema,
        executionReference: ExecutionReferenceSchema,
        rejectedSeq: PositiveSafeIntegerSchema,
        code: Type.Literal("stale_session_lease"),
        retryable: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const HeartbeatSessionSchema = Type.Object(
  {
    tenantId: OpaqueIdSchema,
    piSessionId: OpaqueIdSchema,
    leaseId: UuidSchema,
    writerId: UuidSchema,
    fencingToken: PositiveSafeIntegerSchema,
  },
  { additionalProperties: false },
);

export const SupervisorHeartbeatMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("supervisor.heartbeat"),
    payload: Type.Object(
      {
        supervisorId: OpaqueIdSchema,
        bootId: UuidSchema,
        connectionId: UuidSchema,
        acceptingAssignments: Type.Boolean(),
        maxConcurrentSessions: ResourceLimitSchema,
        families: Type.Array(HeartbeatSessionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const FamilyLeaseRenewalSchema = Type.Object(
  {
    leaseId: UuidSchema,
    fencingToken: PositiveSafeIntegerSchema,
    validUntil: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const SupervisorHeartbeatAckMessageSchema = Type.Object(
  {
    ...WireEnvelopeProperties,
    type: Type.Literal("supervisor.heartbeat.ack"),
    payload: Type.Object(
      {
        acknowledgedMessageId: UuidSchema,
        connectionId: UuidSchema,
        familyLeaseRenewals: Type.Array(FamilyLeaseRenewalSchema),
        familyLeaseDeferrals: Type.Array(
          Type.Object(
            {
              leaseId: UuidSchema,
              fencingToken: PositiveSafeIntegerSchema,
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SupervisorToControlMessageSchema = Type.Union([
  SupervisorRegisterMessageSchema,
  CommandAckMessageSchema,
  EventPublishMessageSchema,
  SupervisorHeartbeatMessageSchema,
]);

export const ControlToSupervisorMessageSchema = Type.Union([
  SupervisorRegisteredMessageSchema,
  ExecuteTurnCommandMessageSchema,
  CancelTurnCommandMessageSchema,
  EventAckMessageSchema,
  EventRejectedMessageSchema,
  SupervisorHeartbeatAckMessageSchema,
]);

export type SupervisorRegisterMessage = Static<typeof SupervisorRegisterMessageSchema>;
export type SupervisorRegisteredMessage = Static<typeof SupervisorRegisteredMessageSchema>;
export type ExecuteTurnCommandMessage = Static<typeof ExecuteTurnCommandMessageSchema>;
export type CancelTurnCommandMessage = Static<typeof CancelTurnCommandMessageSchema>;
export type CommandAckMessage = Static<typeof CommandAckMessageSchema>;
export type EventPublishMessage = Static<typeof EventPublishMessageSchema>;
export type EventAckMessage = Static<typeof EventAckMessageSchema>;
export type EventRejectedMessage = Static<typeof EventRejectedMessageSchema>;
export type SupervisorHeartbeatMessage = Static<typeof SupervisorHeartbeatMessageSchema>;
export type SupervisorHeartbeatAckMessage = Static<typeof SupervisorHeartbeatAckMessageSchema>;

export type SupervisorToControlMessage =
  SupervisorRegisterMessage | CommandAckMessage | EventPublishMessage | SupervisorHeartbeatMessage;

export type ControlToSupervisorMessage =
  | SupervisorRegisteredMessage
  | ExecuteTurnCommandMessage
  | CancelTurnCommandMessage
  | EventAckMessage
  | EventRejectedMessage
  | SupervisorHeartbeatAckMessage;

export class PiCloudWireProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiCloudWireProtocolError";
  }
}

function schemaErrorMessage(
  direction: "supervisor-to-control" | "control-to-supervisor",
  issue: { instancePath: string; message: string } | undefined,
): string {
  const location = issue?.instancePath.length ? issue.instancePath : "/";
  return `Invalid ${direction} message at ${location}: ${issue?.message ?? "schema validation failed"}`;
}

function assertUniqueSessionIds(
  values: ReadonlyArray<{ sessionId: string }>,
  description: string,
): void {
  const sessionIds = new Set<string>();
  for (const value of values) {
    if (sessionIds.has(value.sessionId)) {
      throw new PiCloudWireProtocolError(
        `${description} contains duplicate sessionId ${value.sessionId}`,
      );
    }
    sessionIds.add(value.sessionId);
  }
}

const checkSupervisorToControl = createSchemaCheck(SupervisorToControlMessageSchema);
const checkControlToSupervisor = createSchemaCheck(ControlToSupervisorMessageSchema);

export function parseSupervisorToControlMessage(value: unknown): SupervisorToControlMessage {
  if (!checkSupervisorToControl(value)) {
    const issue = [...Value.Errors(SupervisorToControlMessageSchema, value)][0];
    throw new PiCloudWireProtocolError(schemaErrorMessage("supervisor-to-control", issue));
  }

  const message = value as SupervisorToControlMessage;
  if (message.type === "supervisor.register") {
    if (!message.payload.supportedProtocolVersions.includes(message.protocolVersion)) {
      throw new PiCloudWireProtocolError(
        "supervisor.register must include its envelope protocolVersion in supportedProtocolVersions",
      );
    }
  }

  if (message.type === "supervisor.heartbeat") {
    if (
      message.payload.maxConcurrentSessions !== null &&
      message.payload.families.length > message.payload.maxConcurrentSessions
    ) {
      throw new PiCloudWireProtocolError(
        "supervisor.heartbeat families exceed maxConcurrentSessions",
      );
    }
    assertUniqueSessionIds(
      message.payload.families.map((f) => ({ sessionId: `${f.tenantId}:${f.piSessionId}` })),
      "supervisor.heartbeat families",
    );
    assertUniqueSessionIds(
      message.payload.families.map((f) => ({ sessionId: f.leaseId })),
      "supervisor.heartbeat lease IDs",
    );
  }

  return message;
}

export function parseControlToSupervisorMessage(value: unknown): ControlToSupervisorMessage {
  if (!checkControlToSupervisor(value)) {
    const issue = [...Value.Errors(ControlToSupervisorMessageSchema, value)][0];
    throw new PiCloudWireProtocolError(schemaErrorMessage("control-to-supervisor", issue));
  }

  const message = value as ControlToSupervisorMessage;
  if (message.type === "command.turn.execute") {
    try {
      if (message.payload.input.kind === "prompt")
        assertUserInputBudget(message.payload.input.text, message.payload.input.uploads);
      else if (
        !message.payload.conversationWork ||
        message.payload.piSession.conversationId === 1 ||
        message.payload.sessionKind !== "subagent"
      )
        throw new Error("Native resume requires an existing child Conversation");
    } catch (error) {
      throw new PiCloudWireProtocolError((error as Error).message);
    }
  }
  if (
    message.type === "supervisor.registered" &&
    message.payload.heartbeatTimeoutMs <= message.payload.heartbeatIntervalMs
  ) {
    throw new PiCloudWireProtocolError(
      "supervisor.registered heartbeatTimeoutMs must be greater than heartbeatIntervalMs",
    );
  }

  if (message.type === "supervisor.heartbeat.ack") {
    assertUniqueSessionIds(
      [...message.payload.familyLeaseRenewals, ...message.payload.familyLeaseDeferrals].map(
        (f) => ({ sessionId: f.leaseId }),
      ),
      "supervisor.heartbeat.ack familyLeaseRenewals",
    );
  }

  return message;
}
