import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Resource/routing state, not a claim that a VM or its directory is alive. */
export const ConversationEnvironmentSchema = Type.Object(
  {
    sessionId: Type.String(),
    workspaceId: Type.String(),
    workingDirectory: Type.String(),
    executionMode: Type.Union([Type.Literal("elastic"), Type.Literal("development_environment")]),
    developmentEnvironmentId: Type.Union([Type.String(), Type.Null()]),
    binding: Type.Union([
      Type.Null(),
      Type.Object(
        {
          bindingId: Type.String(),
          allocationId: Type.String(),
          admission: Type.Union([
            Type.Literal("open"),
            Type.Literal("closing"),
            Type.Literal("closed"),
          ]),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export type ConversationEnvironment = Static<typeof ConversationEnvironmentSchema>;
export function parseConversationEnvironment(value: unknown): ConversationEnvironment {
  if (!Value.Check(ConversationEnvironmentSchema, value))
    throw new Error("Invalid conversation environment");
  return value;
}
