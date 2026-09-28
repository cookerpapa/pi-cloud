import type { Entry, LaneRecord, NewRecord, ProvisionedEntry } from "@earendil-works/pi-agent-core";
import type { PiCloudEvent } from "./event-envelope.ts";
import type { ImagePacked } from "./image-attachment.ts";
import type { CandidateToolCommand } from "./tool-command.ts";

/** Trusted, local proof that this record never entered the transport. Never
 * reconstruct this classification from a remote error or an absent PG row. */
export class PublicationNotSentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicationNotSentError";
  }
}

/** Local publication context; only the command enters the execution log. */
export type PiSessionPublicationOptions = Readonly<{
  toolCommand?: CandidateToolCommand;
  signal?: AbortSignal;
}>;

export type PiSessionAppendOperation =
  | Readonly<{
      kind: "append_entry";
      entry: ProvisionedEntry<Entry>;
      lane: string;
    }>
  | Readonly<{ kind: "append_record"; record: NewRecord<LaneRecord> }>;

export type PiSessionMutationOperation =
  | Readonly<{ kind: "create_lane"; lane: string; at: string | null }>
  | Readonly<{ kind: "move_lane"; lane: string; to: string | null }>
  | PiSessionAppendOperation
  | Readonly<{ kind: "append_items"; items: readonly PiSessionAppendOperation[] }>
  | Readonly<{ kind: "set_name"; name: string }>
  | Readonly<{ kind: "set_label"; id: string; label?: string }>;

export interface PiSessionMutationPublisher {
  mutate(
    operation: PiSessionMutationOperation,
    events?: readonly PiCloudEvent[],
    publication?: PiSessionPublicationOptions,
  ): Promise<unknown>;
}

/** Complete immutable records, assigned by the active Session writer before
 * durable append. The projector applies these stamps without reallocating them. */
export type PiCommittedItem =
  | Readonly<{
      kind: "entry";
      lane: string;
      entry: Entry;
      turnId: string | null;
      recoveryId?: string;
    }>
  | Readonly<{ kind: "record"; record: LaneRecord; turnId: string | null }>
  | Readonly<{ kind: "lane"; seq: number; lane: string; leafId: string | null; create: boolean }>
  | Readonly<{ kind: "fact"; seq: number; fact: "name"; name: string }>
  | Readonly<{
      kind: "fact";
      seq: number;
      fact: "label";
      targetId: string;
      label?: string | undefined;
    }>;

export type StoredPiCommittedItem = ImagePacked<PiCommittedItem>;
export function committedItemSequence(item: PiCommittedItem | StoredPiCommittedItem): number {
  return item.kind === "entry"
    ? item.entry.seq
    : item.kind === "record"
      ? item.record.seq
      : item.seq;
}

export interface PiSessionAppendPublisher {
  publish(
    items: readonly PiCommittedItem[],
    events?: readonly PiCloudEvent[],
    publication?: PiSessionPublicationOptions,
  ): Promise<void>;
}
export const PI_MODEL_RETRY_CUSTOM_TYPE = "pi-cloud.model_retry";
