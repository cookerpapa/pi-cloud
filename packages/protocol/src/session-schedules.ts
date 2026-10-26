import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema, UtcTimestampSchema } from "./protocol-primitives.ts";
import { MAX_AGENT_INPUT_CHARACTERS, assertUserInputBudget } from "./agent-input-budget.ts";

function validatePrompt(text: string): void {
  try {
    assertUserInputBudget(text, []);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "Invalid schedule instruction");
  }
}

const revision = Type.String({ pattern: "^[1-9][0-9]{0,18}$" });
const name = Type.String({ minLength: 1, maxLength: 128 });
const prompt = Type.String({ minLength: 1, maxLength: MAX_AGENT_INPUT_CHARACTERS });
export const ScheduleTimingSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("once"), at: Type.String({ minLength: 20, maxLength: 40 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("cron"),
      expression: Type.String({ minLength: 5, maxLength: 200 }),
      timezone: Type.String({ minLength: 1, maxLength: 100 }),
    },
    { additionalProperties: false },
  ),
]);
export type ScheduleTiming = Static<typeof ScheduleTimingSchema>;
export const ScheduleTimingInputSchema = Type.Union([
  ...ScheduleTimingSchema.anyOf,
  Type.Object(
    {
      kind: Type.Literal("after"),
      seconds: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
]);
export type ScheduleTimingInput = Static<typeof ScheduleTimingInputSchema>;

const missed = Type.Union([Type.Literal("latest"), Type.Literal("skip")]);
export const CreateScheduleSchema = Type.Object(
  { name, prompt, timing: ScheduleTimingInputSchema, missed: Type.Optional(missed) },
  { additionalProperties: false },
);
export type CreateSchedule = Static<typeof CreateScheduleSchema>;
const updateProperties = {
  action: Type.Literal("update"),
  revision,
  patch: Type.Object(
    {
      name: Type.Optional(name),
      prompt: Type.Optional(prompt),
      timing: Type.Optional(ScheduleTimingInputSchema),
      missed: Type.Optional(missed),
    },
    { additionalProperties: false, minProperties: 1 },
  ),
};
const toggleProperties = {
  action: Type.Union([Type.Literal("pause"), Type.Literal("resume")]),
  revision,
};
export const ScheduleChangeSchema = Type.Union([
  Type.Object(updateProperties, { additionalProperties: false }),
  Type.Object(toggleProperties, { additionalProperties: false }),
]);
export type ScheduleChange = Static<typeof ScheduleChangeSchema>;
export const DeleteScheduleSchema = Type.Object({ revision }, { additionalProperties: false });
export {
  ScheduledOriginSchema,
  parseScheduledOrigin,
  type ScheduledOrigin,
} from "./scheduled-origin.ts";
export const SessionScheduleSchema = Type.Object(
  {
    id: UuidSchema,
    sessionId: UuidSchema,
    name,
    prompt,
    timing: ScheduleTimingSchema,
    missed,
    revision,
    state: Type.Union([
      Type.Literal("scheduled"),
      Type.Literal("paused"),
      Type.Literal("finished"),
      Type.Literal("blocked"),
      Type.Literal("waiting"),
    ]),
    nextFireAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    lastRun: Type.Union([
      Type.Object(
        {
          runId: UuidSchema,
          turnId: UuidSchema,
          state: Type.String(),
          scheduledAt: UtcTimestampSchema,
          admittedAt: UtcTimestampSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    lastSkippedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    error: Type.Union([
      Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false }),
      Type.Null(),
    ]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);
export type SessionSchedule = Static<typeof SessionScheduleSchema>;
export type SessionScheduleSummary = Omit<SessionSchedule, "prompt">;
const list = Type.Object(
  {
    schedules: Type.Array(Type.Omit(SessionScheduleSchema, ["prompt"])),
    nextCursor: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type SessionScheduleList = Static<typeof list>;
export const ScheduleToolSchema = Type.Union([
  Type.Object(
    { action: Type.Literal("create"), ...CreateScheduleSchema.properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("list"), cursor: Type.Optional(UuidSchema) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("get"),
      id: UuidSchema,
      promptOffset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: MAX_AGENT_INPUT_CHARACTERS }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object({ ...updateProperties, id: UuidSchema }, { additionalProperties: false }),
  Type.Object({ ...toggleProperties, id: UuidSchema }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("delete"), id: UuidSchema, revision },
    { additionalProperties: false },
  ),
]);
/** One object schema for provider compatibility; action-specific validation follows below. */
export const ScheduleToolParametersSchema = Type.Object(
  {
    action: Type.Union(
      ["create", "list", "get", "update", "pause", "resume", "delete"].map((value) =>
        Type.Literal(value),
      ),
    ),
    name: Type.Optional(name),
    prompt: Type.Optional(prompt),
    timing: Type.Optional(ScheduleTimingInputSchema),
    missed: Type.Optional(missed),
    id: Type.Optional(UuidSchema),
    revision: Type.Optional(revision),
    patch: Type.Optional(updateProperties.patch),
    cursor: Type.Optional(UuidSchema),
    promptOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_AGENT_INPUT_CHARACTERS })),
  },
  { additionalProperties: false },
);
export type ScheduleToolInput = Static<typeof ScheduleToolSchema>;
export function parseScheduleToolInput(value: unknown): ScheduleToolInput {
  if (!Value.Check(ScheduleToolSchema, value)) throw new TypeError("Invalid schedule arguments");
  if (value.action === "create") validatePrompt(value.prompt);
  if (value.action === "update" && value.patch.prompt !== undefined)
    validatePrompt(value.patch.prompt);
  return value;
}
export function parseCreateSchedule(value: unknown): CreateSchedule {
  if (!Value.Check(CreateScheduleSchema, value))
    throw new TypeError("Invalid schedule configuration");
  validatePrompt(value.prompt);
  return value;
}
export function parseScheduleChange(value: unknown): ScheduleChange {
  if (!Value.Check(ScheduleChangeSchema, value)) throw new TypeError("Invalid schedule change");
  if (value.action === "update" && value.patch.prompt !== undefined)
    validatePrompt(value.patch.prompt);
  return value;
}
export function parseDeleteSchedule(value: unknown): Static<typeof DeleteScheduleSchema> {
  if (!Value.Check(DeleteScheduleSchema, value)) throw new TypeError("Invalid schedule deletion");
  return value;
}
export function parseSessionSchedule(value: unknown): SessionSchedule {
  if (!Value.Check(SessionScheduleSchema, value)) throw new TypeError("Invalid schedule resource");
  return value;
}
export function parseSessionScheduleList(value: unknown): SessionScheduleList {
  if (!Value.Check(list, value)) throw new TypeError("Invalid schedule list");
  return value;
}

export const ScheduleDeletionSchema = Type.Object(
  {
    id: UuidSchema,
    deleted: Type.Literal(true),
    lastRunId: Type.Union([UuidSchema, Type.Null()]),
    activeRun: Type.Union([
      Type.Object(
        { runId: UuidSchema, turnId: UuidSchema, state: Type.String() },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type ScheduleDeletion = Static<typeof ScheduleDeletionSchema>;
export function parseScheduleDeletion(value: unknown): ScheduleDeletion {
  if (!Value.Check(ScheduleDeletionSchema, value))
    throw new TypeError("Invalid schedule deletion response");
  return value;
}
