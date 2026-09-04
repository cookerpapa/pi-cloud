import type { Entry, LaneRecord, NewRecord, ProvisionedEntry } from "@earendil-works/pi-agent-core";
import type { PiCloudEvent } from "@pi-cloud/protocol";

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
  | Readonly<{ kind: "set_label"; id: string; label?: string }>
  | Readonly<{ kind: "projection_barrier" }>;

export interface PiSessionMutationPublisher {
  mutate(operation: PiSessionMutationOperation, events?: readonly PiCloudEvent[]): Promise<unknown>;
  synchronize(): Promise<void>;
}
