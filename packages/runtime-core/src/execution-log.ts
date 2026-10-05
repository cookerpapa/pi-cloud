import type { EventAckMessage } from "@pi-cloud/protocol";
import type { AcceptedFactWriter, ExecutionPublication } from "./accepted-fact.ts";

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
  readonly acknowledgedThroughSeq: number;
  ingest(value: unknown): Promise<EventAckMessage>;
  close(): Promise<void>;
}

export interface ExecutionLogFactory {
  open(request: ExecutionLogOpenRequest): Promise<ExecutionLogWriter>;
}
