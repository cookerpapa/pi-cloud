import type { CurrentStateRow, CurrentStateSource } from "./current-state.ts";

export type NativeReplayPosition = Readonly<{ topic: string; partition: number; offset: bigint }>;

/** Disposable partition-owner state. Mutate a fork inside SQL, adopt only after COMMIT. */
export class NativeLiveState {
  through: number | undefined;
  readonly rows = new Map<number, CurrentStateRow>();

  fork(): NativeLiveState {
    const next = new NativeLiveState();
    next.through = this.through;
    for (const [id, row] of this.rows) next.rows.set(id, row);
    return next;
  }
  adopt(next: NativeLiveState): void {
    this.through = next.through;
    this.rows.clear();
    for (const [id, row] of next.rows) this.rows.set(id, row);
  }
  initialize(head: number, checkpoints: readonly CurrentStateSource[]): void {
    if (this.through !== undefined) return;
    this.through = head;
    for (const row of checkpoints) {
      if (row.replay_seq === null) continue;
      this.through = Math.min(this.through, Number(row.replay_seq) - 1);
      this.rows.set(Number(row.id), row);
    }
  }
}

export type NativeLiveProjection = Readonly<{
  state: NativeLiveState;
  position: NativeReplayPosition;
}>;
