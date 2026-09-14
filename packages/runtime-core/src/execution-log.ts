import type { EventAckMessage } from "@pi-cloud/protocol";
import type { AcceptedFactWriter } from "./accepted-fact.ts";

export type ExecutionLogOpenRequest = Readonly<{
  executionReference: string;
  sessionId: string;
  piSession: Readonly<{ id: string; lane: string; writerId: string }>;
  turnId: string;
  nextEventSeq: number;
}>;

export interface ExecutionLogWriter extends AcceptedFactWriter {
  readonly acknowledgedThroughSeq: number;
  ingest(value: unknown): Promise<EventAckMessage>;
  close(): Promise<void>;
}

export interface ExecutionLogFactory {
  open(request: ExecutionLogOpenRequest): Promise<ExecutionLogWriter>;
}
