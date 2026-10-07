import { newIdempotencyKey } from "./api.ts";

type ComposerInput = Readonly<{
  sessionId: string;
  text: string;
  uploadIds: readonly string[];
  targetTurnId?: string;
}>;

/** One open composer's submission. An uncertain response retains its identity;
 * an acknowledged or different input starts a new intentional submission. */
export class ComposerSubmission {
  #pending: { fingerprint: string; key: string } | undefined;
  constructor(readonly kind: "turn" | "steer") {}

  async send<T>(input: ComposerInput, operation: (key: string) => Promise<T>): Promise<T> {
    const fingerprint = JSON.stringify(input);
    if (this.#pending?.fingerprint !== fingerprint)
      this.#pending = { fingerprint, key: newIdempotencyKey(this.kind) };
    const pending = this.#pending;
    const result = await operation(pending.key);
    // A late ACK cannot discard a newer submission's unresolved identity.
    if (this.#pending === pending) this.#pending = undefined;
    return result;
  }
}
