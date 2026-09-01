import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  OpaqueIdSchema,
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

export const SessionStateSchema = Type.Union([
  Type.Literal("cold"),
  Type.Literal("starting"),
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("cancelling"),
  Type.Literal("failed"),
  Type.Literal("recovering"),
  Type.Literal("evicting"),
]);
export type SessionState = Static<typeof SessionStateSchema>;

export const TurnCancellationReasonSchema = Type.Union([
  Type.Literal("user_request"),
  Type.Literal("timeout"),
  Type.Literal("session_lease_revoked"),
  Type.Literal("shutdown"),
]);

const CommonEnvelopeProperties = {
  schemaVersion: Type.Literal(1),
  eventId: UuidSchema,
  sessionId: OpaqueIdSchema,
  agentId: OpaqueIdSchema,
  seq: PositiveSafeIntegerSchema,
  occurredAt: UtcTimestampSchema,
};

const TurnEnvelopeProperties = {
  ...CommonEnvelopeProperties,
  turnId: OpaqueIdSchema,
};

const SessionEnvelopeProperties = {
  ...CommonEnvelopeProperties,
  turnId: Type.Union([OpaqueIdSchema, Type.Null()]),
};

const TurnStartedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("turn.started"),
    payload: Type.Object(
      {
        inputKind: Type.Literal("prompt"),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const SessionStateChangedEventSchema = Type.Object(
  {
    ...SessionEnvelopeProperties,
    type: Type.Literal("session.state.changed"),
    payload: Type.Object(
      {
        from: SessionStateSchema,
        to: SessionStateSchema,
        reason: Type.Optional(Type.String({ maxLength: 1_024 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const AssistantTextDeltaEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("assistant.text.delta"),
    payload: Type.Object(
      {
        text: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ModelSamplingIdentityProperties = {
  stepSequence: PositiveSafeIntegerSchema,
  stepSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  samplingAttempt: PositiveSafeIntegerSchema,
};

const ModelSamplingStartedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("model.sampling.started"),
    payload: Type.Object(ModelSamplingIdentityProperties, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

const ModelSamplingCompletedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("model.sampling.completed"),
    payload: Type.Object(
      {
        ...ModelSamplingIdentityProperties,
        outcome: Type.Union([
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("aborted"),
        ]),
        stopReason: Type.Union([
          Type.Literal("stop"),
          Type.Literal("length"),
          Type.Literal("toolUse"),
          Type.Literal("error"),
          Type.Literal("aborted"),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ModelSamplingRetryScheduledEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("model.sampling.retry.scheduled"),
    payload: Type.Object(
      {
        stepSequence: PositiveSafeIntegerSchema,
        stepSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        completedSamplingAttempt: PositiveSafeIntegerSchema,
        nextSamplingAttempt: PositiveSafeIntegerSchema,
        maximumSamplingAttempts: PositiveSafeIntegerSchema,
        delayMs: Type.Integer({ minimum: 0, maximum: 300_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ProviderHostedToolStartedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("provider.hosted_tool.started"),
    payload: Type.Object(
      {
        toolName: Type.Literal("web_search"),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ProviderHostedToolCompletedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("provider.hosted_tool.completed"),
    payload: Type.Object(
      {
        toolName: Type.Literal("web_search"),
        outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ToolStartedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("tool.started"),
    payload: Type.Object(
      {
        toolCallId: OpaqueIdSchema,
        toolName: OpaqueIdSchema,
        input: Type.Unknown(),
        stepSequence: Type.Optional(PositiveSafeIntegerSchema),
        stepSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
        samplingAttempt: Type.Optional(PositiveSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ToolCompletedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("tool.completed"),
    payload: Type.Object(
      {
        toolCallId: OpaqueIdSchema,
        outcome: Type.Union([
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("unknown"),
        ]),
        output: Type.Optional(Type.Unknown()),
        stepSequence: Type.Optional(PositiveSafeIntegerSchema),
        stepSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
        samplingAttempt: Type.Optional(PositiveSafeIntegerSchema),
        outputArtifact: Type.Optional(
          Type.Object(
            {
              artifactId: UuidSchema,
              sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
              sizeBytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
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

const ContextCompactionStartedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("context.compaction.started"),
    payload: Type.Object(
      {
        reason: Type.Union([
          Type.Literal("manual"),
          Type.Literal("threshold"),
          Type.Literal("overflow"),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ContextCompactionCompletedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("context.compaction.completed"),
    payload: Type.Object(
      {
        reason: Type.Union([
          Type.Literal("manual"),
          Type.Literal("threshold"),
          Type.Literal("overflow"),
        ]),
        status: Type.Union([
          Type.Literal("completed"),
          Type.Literal("aborted"),
          Type.Literal("failed"),
        ]),
        willRetry: Type.Boolean(),
        tokensBefore: Type.Optional(Type.Integer({ minimum: 0 })),
        estimatedTokensAfter: Type.Optional(Type.Integer({ minimum: 0 })),
        firstKeptEntryId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        summarySha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
        summaryVersion: Type.Optional(PositiveSafeIntegerSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const UiNotificationEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("ui.notification"),
    payload: Type.Object(
      {
        message: Type.String({ maxLength: 16_384 }),
        level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const TurnCompletedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("turn.completed"),
    payload: Type.Object(
      {
        stopReason: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const TurnFailedEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("turn.failed"),
    payload: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 256 }),
        message: Type.String({ maxLength: 16_384 }),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const TurnCancelledEventSchema = Type.Object(
  {
    ...TurnEnvelopeProperties,
    type: Type.Literal("turn.cancelled"),
    payload: Type.Object(
      {
        reason: TurnCancellationReasonSchema,
        forced: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PiCloudEventSchema = Type.Union([
  TurnStartedEventSchema,
  SessionStateChangedEventSchema,
  ModelSamplingStartedEventSchema,
  ModelSamplingCompletedEventSchema,
  ModelSamplingRetryScheduledEventSchema,
  ProviderHostedToolStartedEventSchema,
  ProviderHostedToolCompletedEventSchema,
  AssistantTextDeltaEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  ContextCompactionStartedEventSchema,
  ContextCompactionCompletedEventSchema,
  UiNotificationEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
  TurnCancelledEventSchema,
]);

export type PiCloudEvent =
  | Static<typeof TurnStartedEventSchema>
  | Static<typeof SessionStateChangedEventSchema>
  | Static<typeof ModelSamplingStartedEventSchema>
  | Static<typeof ModelSamplingCompletedEventSchema>
  | Static<typeof ModelSamplingRetryScheduledEventSchema>
  | Static<typeof ProviderHostedToolStartedEventSchema>
  | Static<typeof ProviderHostedToolCompletedEventSchema>
  | Static<typeof AssistantTextDeltaEventSchema>
  | Static<typeof ToolStartedEventSchema>
  | Static<typeof ToolCompletedEventSchema>
  | Static<typeof ContextCompactionStartedEventSchema>
  | Static<typeof ContextCompactionCompletedEventSchema>
  | Static<typeof UiNotificationEventSchema>
  | Static<typeof TurnCompletedEventSchema>
  | Static<typeof TurnFailedEventSchema>
  | Static<typeof TurnCancelledEventSchema>;
export type PiCloudEventType = PiCloudEvent["type"];

type EventBody<Event> = Event extends PiCloudEvent ? Pick<Event, "type" | "payload"> : never;
export type PiCloudEventBody = EventBody<PiCloudEvent>;

export class PiCloudProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiCloudProtocolError";
  }
}

export function parsePiCloudEvent(value: unknown): PiCloudEvent {
  if (!Value.Check(PiCloudEventSchema, value)) {
    const issue = [...Value.Errors(PiCloudEventSchema, value)][0];
    const location = issue?.instancePath.length ? issue.instancePath : "/";
    throw new PiCloudProtocolError(
      `Invalid PiCloud event at ${location}: ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return value as PiCloudEvent;
}

export type PiCloudEventIdentity = {
  sessionId: string;
  turnId: string | null;
  agentId: string;
};

export type PiCloudEventFactoryOptions = {
  initialSequence?: number;
  clock?: () => Date;
  idGenerator?: () => string;
};

export type PiCloudEventFactory = {
  next: (body: PiCloudEventBody) => PiCloudEvent;
  currentSequence: () => number;
};

export function createPiCloudEventFactory(
  identity: PiCloudEventIdentity,
  options: PiCloudEventFactoryOptions = {},
): PiCloudEventFactory {
  let sequence = options.initialSequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new PiCloudProtocolError("initialSequence must be a non-negative safe integer");
  }

  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());

  return {
    next(body) {
      const nextSequence = sequence + 1;
      const event = parsePiCloudEvent({
        schemaVersion: 1,
        eventId: idGenerator(),
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        agentId: identity.agentId,
        seq: nextSequence,
        occurredAt: clock().toISOString(),
        type: body.type,
        payload: body.payload,
      });
      sequence = nextSequence;
      return event;
    },
    currentSequence() {
      return sequence;
    },
  };
}
