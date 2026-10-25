import { newIdempotencyKey } from "./api.ts";

type ComposerInput = Readonly<{
  kind: "turn" | "steer" | "compact";
  sessionId: string;
  text: string;
  uploadIds: readonly string[];
  targetTurnId?: string;
}>;

/** One open composer's submission. An uncertain response retains its identity;
 * an acknowledged or different input starts a new intentional submission. */
export class ComposerSubmission {
  #pending: { fingerprint: string; sessionId: string; key: string } | undefined;

  reset(): void {
    this.#pending = undefined;
  }

  /** A returned input is a new editable intent. An older Stop must not retire
   * an unrelated, uncertain submission accepted after its queue cut. */
  retireReturned(sessionId: string, keys: readonly string[]): void {
    if (this.#pending?.sessionId === sessionId && keys.includes(this.#pending.key))
      this.#pending = undefined;
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
    const result = await operation(pending.key);
    // A late ACK cannot discard a newer submission's unresolved identity.
    if (this.#pending === pending) this.#pending = undefined;
    return result;
  }
}
