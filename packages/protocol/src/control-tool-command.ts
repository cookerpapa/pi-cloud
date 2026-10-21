import { isControlDispatchToolName } from "./control-tool-catalog.ts";

export type ControlToolRecoverySource = Readonly<{
  sequence: number;
  operationId: string;
}>;
export type ControlToolRecovery = ControlToolRecoverySource & Readonly<{ documentId: number }>;
export type OriginalControlToolIntent = ControlToolRecoverySource &
  Readonly<{
    taskId: number;
    conversationId: number;
    toolName: string;
    nativeCallId: string;
    arguments: Record<string, unknown>;
    contextAnchor: number | null;
  }>;

/** Prepared by the trusted Worker; arguments are removed from the transport
 * descriptor and resolved from the same native execute checkpoint. */
export type CandidateControlToolCommand = Readonly<{
  target: "control";
  executionReference: string;
  operationId: string;
  toolCallId: string;
  nativeCallId: string;
  conversationId: number;
  toolName: string;
  arguments: Record<string, unknown>;
  contextAnchor: number | null;
  bindingId?: string;
  sourceDocumentId?: number;
  recovery?: ControlToolRecoverySource & { documentId?: number };
  replyMode?: "hostcall";
  workflowKey?: string;
  occurredAt: string;
}>;

export type ControlToolDispatch = Readonly<{
  target: "control";
  operationId: string;
  taskId: number;
  conversationId: number;
  toolName: string;
  contextAnchor: number | null;
  bindingId?: string;
  sourceDocumentId?: number;
  recovery?: ControlToolRecovery;
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
    !isControlDispatchToolName(v.toolName) ||
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
  const recovery = v.recovery;
  if (
    recovery !== undefined &&
    (!recovery ||
      v.toolName !== "subagent" ||
      v.sourceDocumentId !== undefined ||
      v.replyMode !== undefined ||
      v.workflowKey !== undefined ||
      v.bindingId !== undefined ||
      !Number.isSafeInteger(recovery.documentId) ||
      recovery.documentId < 1 ||
      !Number.isSafeInteger(recovery.sequence) ||
      recovery.sequence < 1 ||
      typeof recovery.operationId !== "string" ||
      !recovery.operationId ||
      recovery.operationId === v.operationId ||
      Object.keys(recovery).sort().join(",") !== "documentId,operationId,sequence")
  )
    throw new Error("Invalid control Tool recovery reference");
  return v;
}
