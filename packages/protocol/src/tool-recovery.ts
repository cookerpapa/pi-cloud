import type { AcceptedToolCommand } from "./tool-command.ts";

export const TOOL_REPLY_DELIVERY_MARGIN_MS = 120_000;

/** A reference to the existing Kafka reply log, never another Tool command. */
export type ToolReplyRecovery = Readonly<{
  topic: string;
  partition: 0;
  offset: string;
  deadlineAt: number;
  toolCallId: string;
  toolName: string;
}>;

export function parseToolReplyRecovery(value: unknown): ToolReplyRecovery {
  const v = value as ToolReplyRecovery | undefined;
  if (
    !v ||
    !/^pi-cloud\.tool-replies\.v4\.[0-9a-f-]{36}$/i.test(v.topic) ||
    v.partition !== 0 ||
    !/^(0|[1-9][0-9]*)$/.test(v.offset) ||
    !Number.isSafeInteger(v.deadlineAt) ||
    v.deadlineAt < 1 ||
    typeof v.toolCallId !== "string" ||
    !v.toolCallId ||
    v.toolCallId.length > 512 ||
    typeof v.toolName !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(v.toolName)
  )
    throw new Error("Invalid remote Tool replay reference");
  return {
    topic: v.topic,
    partition: 0,
    offset: v.offset,
    deadlineAt: v.deadlineAt,
    toolCallId: v.toolCallId,
    toolName: v.toolName,
  };
}

export type PendingToolReplyRecovery = Readonly<{
  operationId: string;
  reply: ToolReplyRecovery;
}>;

export type OriginalRemoteToolIntent = Readonly<{
  sequence: number;
  taskId: number;
  conversationId: number;
  command: AcceptedToolCommand;
  reply: ToolReplyRecovery;
}>;
