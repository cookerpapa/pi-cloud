import { newIdempotencyKey } from "./http.ts";

export type ComposerInput = Readonly<{
  kind: "turn" | "compact";
  sessionId: string;
  text: string;
  uploadIds: readonly string[];
  whenBusy?: "follow_up" | "steer";
}>;

export type ComposerSubmissionView = Readonly<{
  input: ComposerInput;
  state: "sending" | "unconfirmed";
  key: string;
  placement: "timeline" | "queue";
  afterMailboxPosition: number;
  afterSequence: number;
  knownInputIds: readonly string[];
}>;
export type ComposerPlacement = Pick<
  ComposerSubmissionView,
  "placement" | "afterMailboxPosition" | "afterSequence" | "knownInputIds"
>;

/** One open composer's submission. An uncertain response retains its identity;
 * an acknowledged or different input starts a new intentional submission. */
export class ComposerSubmission {
  #pending:
    | { fingerprint: string; sessionId: string; key: string; placement: ComposerPlacement }
    | undefined;
  #view: ComposerSubmissionView | null = null;
  readonly #listeners = new Set<() => void>();
  readonly snapshot = (): ComposerSubmissionView | null => this.#view;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #show(view: ComposerSubmissionView | null): void {
    this.#view = view;
    for (const listener of this.#listeners) listener();
  }

  reset(): void {
    this.#pending = undefined;
    this.#show(null);
  }

  /** A returned input is a new editable intent. An older Stop must not retire
   * an unrelated, uncertain submission accepted after its queue cut. */
  retireReturned(sessionId: string, keys: readonly string[]): void {
    if (this.#pending?.sessionId === sessionId && keys.includes(this.#pending.key)) this.reset();
  }

  async send<T>(
    input: ComposerInput,
    operation: (key: string) => Promise<T>,
    options?: {
      idempotencyKey?: string;
      placement?: ComposerPlacement;
      confirmed?(result: T, key: string): void;
    },
  ): Promise<T> {
    const fingerprint = JSON.stringify(input);
    if (this.#pending?.fingerprint !== fingerprint)
      this.#pending = {
        fingerprint,
        sessionId: input.sessionId,
        key: options?.idempotencyKey ?? newIdempotencyKey(input.kind),
        placement: options?.placement ?? {
          placement: "timeline",
          afterMailboxPosition: 0,
          afterSequence: 0,
          knownInputIds: [],
        },
      };
    const pending = this.#pending;
    const view = {
      input: { ...input, uploadIds: [...input.uploadIds] },
      key: pending.key,
      ...pending.placement,
    };
    this.#show({ ...view, state: "sending" });
    try {
      const result = await operation(pending.key);
      // Present the authoritative receipt before retiring its local feedback.
      options?.confirmed?.(result, pending.key);
      // A late ACK cannot discard a newer submission's unresolved identity.
      if (this.#pending === pending) this.reset();
      return result;
    } catch (error) {
      if (this.#pending === pending) this.#show({ ...view, state: "unconfirmed" });
      throw error;
    }
  }
}
