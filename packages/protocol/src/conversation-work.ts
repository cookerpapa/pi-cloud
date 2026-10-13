import { Type, type Static } from "typebox";
import { CloudToolCapabilitySnapshotSchema } from "./tool-capabilities.ts";

/** Frozen child view/resource choices. The native Tool owns the prompt; this
 * reference never creates a separately claimable cloud job. */
export const ConversationWorkViewSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    sessionId: Type.String({ format: "uuid" }),
    turnId: Type.String({ format: "uuid" }),
    parentConversationId: Type.Integer({ minimum: 1 }),
    ownerTaskId: Type.Integer({ minimum: 1 }),
    contextAnchor: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    workingDirectory: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" }),
    computeSessionId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    toolCapabilities: CloudToolCapabilitySnapshotSchema,
    agentSystemPrompt: Type.String(),
    source: Type.Object(
      {
        sequence: Type.Integer({ minimum: 1 }),
        taskId: Type.Integer({ minimum: 1 }),
        documentId: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ConversationWorkView = Static<typeof ConversationWorkViewSchema>;
export type ConversationStartRequest = {
  executionReference: string;
  view: ConversationWorkView;
  prompt: string;
};
