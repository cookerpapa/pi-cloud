import { isControlToolName, type ControlToolName } from "./control-tools.ts";

/** Prepared by the trusted Worker; arguments are removed from the transport
 * descriptor and resolved from the same native execute checkpoint. */
export type CandidateControlToolCommand = Readonly<{
  target: "control";
  executionReference: string;
  operationId: string;
  toolCallId: string;
  nativeCallId: string;
  conversationId: number;
  toolName: ControlToolName;
  arguments: Record<string, unknown>;
  contextAnchor: number | null;
  bindingId?: string;
  sourceDocumentId?: number;
  replyMode?: "hostcall";
  workflowKey?: string;
  occurredAt: string;
}>;

export type ControlToolDispatch = Readonly<{
  target: "control";
  operationId: string;
  taskId: number;
  conversationId: number;
  toolName: ControlToolName;
  contextAnchor: number | null;
  bindingId?: string;
  sourceDocumentId?: number;
  replyMode?: "hostcall";
  workflowKey?: string;
  replyTopic: string;
}>;

export function parseControlToolDispatch(value: unknown): ControlToolDispatch {
  const v = value as ControlToolDispatch;
  if (
    !v ||
    v.target !== "control" ||
    typeof v.operationId !== "string" ||
    !v.operationId ||
    !Number.isSafeInteger(v.taskId) ||
    v.taskId < 1 ||
    !Number.isSafeInteger(v.conversationId) ||
    v.conversationId < 1 ||
    !isControlToolName(v.toolName) ||
    (v.contextAnchor !== null && (!Number.isSafeInteger(v.contextAnchor) || v.contextAnchor < 1)) ||
    (v.bindingId !== undefined && (typeof v.bindingId !== "string" || !v.bindingId)) ||
    (v.sourceDocumentId !== undefined &&
      (!Number.isSafeInteger(v.sourceDocumentId) || v.sourceDocumentId < 1)) ||
    (v.replyMode !== undefined && v.replyMode !== "hostcall") ||
    (v.replyMode === "hostcall" && v.sourceDocumentId === undefined) ||
    (v.workflowKey !== undefined && (typeof v.workflowKey !== "string" || !v.workflowKey)) ||
    typeof v.replyTopic !== "string" ||
    !v.replyTopic ||
    "arguments" in v ||
    "args" in v
  )
    throw new Error("Invalid control Tool dispatch reference");
  return v;
}
