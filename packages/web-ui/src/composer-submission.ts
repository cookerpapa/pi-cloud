import { newIdempotencyKey } from "./api.ts";

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
}>;

/** One open composer's submission. An uncertain response retains its identity;
 * an acknowledged or different input starts a new intentional submission. */
export class ComposerSubmission {
  #pending: { fingerprint: string; sessionId: string; key: string } | undefined;
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

  async send<T>(input: ComposerInput, operation: (key: string) => Promise<T>): Promise<T> {
    const fingerprint = JSON.stringify(input);
    if (this.#pending?.fingerprint !== fingerprint)
      this.#pending = {
        fingerprint,
        sessionId: input.sessionId,
        key: newIdempotencyKey(input.kind),
      };
    const pending = this.#pending;
    const view = { ...input, uploadIds: [...input.uploadIds] };
    this.#show({ input: view, state: "sending" });
    try {
      const result = await operation(pending.key);
      // A late ACK cannot discard a newer submission's unresolved identity.
      if (this.#pending === pending) this.reset();
      return result;
    } catch (error) {
      if (this.#pending === pending) this.#show({ input: view, state: "unconfirmed" });
      throw error;
    }
  }
}
