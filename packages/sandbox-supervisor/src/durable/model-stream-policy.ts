import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

type ProgressEvent = Extract<AssistantMessageEvent, { partial: AssistantMessage }>;

/** Durable persists every partial it receives. Keep provider Tool drafts on the
 * model side of that boundary, including drafts carried by a later text event.
 * Empty text slots preserve content indexes for text signatures and final output.
 * Detach arrays/blocks: providers append to and mutate the same partial object. */
export function durableModelProgress(event: ProgressEvent): ProgressEvent | undefined {
  if (
    event.type === "toolcall_start" ||
    event.type === "toolcall_delta" ||
    event.type === "toolcall_end"
  )
    return undefined;
  return {
    ...event,
    partial: {
      ...event.partial,
      content: event.partial.content.map((block) =>
        block.type === "toolCall" ? { type: "text", text: "" } : { ...block },
      ),
      usage: { ...event.partial.usage, cost: { ...event.partial.usage.cost } },
    },
  };
}

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
