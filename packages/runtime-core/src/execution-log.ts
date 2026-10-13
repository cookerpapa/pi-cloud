import type { EventAckMessage } from "@pi-cloud/protocol";
import type { AcceptedFactWriter, ExecutionPublication, WorkTerminal } from "./accepted-fact.ts";

export type ExecutionLogOpenRequest = Readonly<{
  executionReference: string;
  sessionId: string;
  piSession: Readonly<{ id: string; conversationId: number; writerId: string }>;
  turnId: string;
  nextEventSeq: number;
  publication: ExecutionPublication;
  signal?: AbortSignal;
}>;

export interface ExecutionLogWriter extends AcceptedFactWriter {
  /** Local transport evidence only; no lease or network query. */
  assertHealthy?(): void;
  readonly acknowledgedThroughSeq: number;
  ingest(value: unknown): Promise<EventAckMessage>;
  drain(): Promise<void>;
  finish(terminal: WorkTerminal): Promise<void>;
  close(): Promise<void>;
}

export interface ExecutionLogFactory {
  open(request: ExecutionLogOpenRequest): Promise<ExecutionLogWriter>;
  openConversation?(
    reference: string,
    address: { conversationId: number; sessionId: string; turnId: string; nextEventSeq: number },
  ): ExecutionLogWriter;
}
