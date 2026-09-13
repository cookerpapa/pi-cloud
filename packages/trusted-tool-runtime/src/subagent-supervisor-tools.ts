import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SubagentControlRequest } from "@pi-cloud/protocol";
import { Type } from "typebox";

type Request = (
  toolCallId: string,
  request: SubagentControlRequest,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;
const contactSchema = Type.Object(
  {
    reason: Type.Union([
      Type.Literal("progress_update"),
      Type.Literal("need_decision"),
      Type.Literal("interview_request"),
    ]),
    message: Type.String({ minLength: 1 }),
    interview: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
const supervisorSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("pending"), Type.Literal("reply"), Type.Literal("wait")]),
    replyTo: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export function createCloudContactSupervisorTool(
  request: Request,
): AgentTool<typeof contactSchema> {
  return {
    name: "contact_supervisor",
    label: "Contact Supervisor",
    description:
      "Send a durable progress update or request a decision from the parent Agent. A decision request waits for its reply.",
    parameters: contactSchema,
    async execute(id, args, signal) {
      const result = await request(id, { action: "contact", ...args }, signal);
      return {
        content: [
          {
            type: "text",
            text:
              typeof result.replyMessage === "string"
                ? result.replyMessage
                : "Supervisor progress update persisted.",
          },
        ],
        details: result,
      };
    },
  };
}
export function createCloudSubagentSupervisorTool(
  request: Request,
): AgentTool<typeof supervisorSchema> {
  return {
    name: "subagent_supervisor",
    label: "Subagent Supervisor",
    description:
      "Inspect pending Child requests, reply, and wait for the Child result. This does not start another Child.",
    parameters: supervisorSchema,
    async execute(id, args, signal) {
      const result = await request(
        id,
        {
          action: "supervisor",
          operation: args.action,
          ...(args.replyTo ? { requestId: args.replyTo } : {}),
          ...(args.message ? { message: args.message } : {}),
        },
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: typeof result.output === "string" ? result.output : JSON.stringify(result),
          },
        ],
        details: result,
      };
    },
  };
}
