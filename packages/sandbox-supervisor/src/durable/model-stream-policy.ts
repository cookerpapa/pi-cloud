import type { AssistantMessage } from "@earendil-works/pi-ai";

/** A terminal error or token limit can still carry partially parsed arguments.
 * Such drafts must not reach history through Durable's terminal-message path.
 * Successful responses retain their calls for native validation and intent. */
export function completeModelResponse(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "stop" || message.stopReason === "toolUse") return message;
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "toolCall" ? { type: "text", text: "" } : block,
    ),
  };
}
