import { Agent, fetch as internalFetch } from "undici";
import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_EXECUTION_FACT_BYTES,
  parsePublicationAvailability,
  type PublicationAvailability,
  type SessionControlChange,
  type SessionControlPublisher,
} from "@pi-cloud/protocol";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import type { AcceptedExecutionSealFact, AcceptedFactReceipt } from "./accepted-fact.ts";

export const PUBLICATION_PATH = "/internal/v1/session-publication";

/** Private forwarding between control partition owners. No Worker data path. */
export class HttpPublicationClient implements SessionControlPublisher {
  readonly #dispatcher = new Agent({ connections: 16 });
  readonly #owners = new Map<string, string>();
  #closed = false;

  constructor(readonly options: { baseUrl: string; token: string; timeoutMs?: number }) {}

  async publishControl(change: SessionControlChange): Promise<AcceptedFactReceipt> {
    return (await this.#request(
      "control",
      change.scope.piSessionId,
      change,
    )) as AcceptedFactReceipt;
  }

  async publishSeal(fact: AcceptedExecutionSealFact): Promise<AcceptedFactReceipt> {
    return (await this.#request("seal", fact.scope.piSessionId, fact)) as AcceptedFactReceipt;
  }

  async #request(
    action: "seal" | "control",
    sessionId: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed) throw new PublicationNotSentError("Publication client closed before send");
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > MAX_EXECUTION_FACT_BYTES)
      throw new PublicationNotSentError("Publication exceeds the transport size limit");
    let base = this.#owners.get(sessionId) ?? this.options.baseUrl;
    const deadline = Date.now() + (this.options.timeoutMs ?? 15_000);
    for (;;) {
      signal?.throwIfAborted();
      let response;
      try {
        response = await internalFetch(new URL(`${PUBLICATION_PATH}/${action}`, base), {
          method: "POST",
          body,
          dispatcher: this.#dispatcher,
          redirect: "manual",
          headers: {
            authorization: `Bearer ${this.options.token}`,
            "content-type": "application/octet-stream",
          },
          signal: AbortSignal.any([
            AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            ...(signal ? [signal] : []),
          ]),
        });
      } catch (error) {
        this.#forgetOwner(sessionId, base);
        throw error;
      }
      if (response.status === 307) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || Date.now() >= deadline)
          throw new PublicationNotSentError("Publication owner is unavailable");
        const owner = new URL(location);
        if (!["http:", "https:"].includes(owner.protocol) || owner.username || owner.password)
          throw new PublicationNotSentError("Invalid publication owner route");
        base = owner.origin;
        this.#owners.set(sessionId, base);
        if (this.#owners.size > 4096) this.#owners.delete(this.#owners.keys().next().value!);
        continue;
      }
      const payload = (await response.json().catch((error) => {
        this.#forgetOwner(sessionId, base);
        throw error;
      })) as {
        factId?: string;
        durable?: boolean;
        error?: { code?: string; reason?: string };
      };
      if (response.ok) return payload;
      if (payload.error?.code === "publication_not_sent") {
        const reason = payload.error.reason;
        if (reason === "not_owner" && Date.now() < deadline) {
          this.#forgetOwner(sessionId, base);
          base = this.options.baseUrl;
          await delay(50, undefined, { signal });
          continue;
        }
        throw new PublicationNotSentError(
          `Publication rejected before Kafka admission: ${reason ?? "unavailable"}`,
        );
      }
      throw new Error("Publication commit could not be confirmed");
    }
  }

  #forgetOwner(sessionId: string, attempted: string): void {
    // A late failure from an old request must not erase a newer discovered peer.
    if (this.#owners.get(sessionId) === attempted) this.#owners.delete(sessionId);
  }

  async publicationAvailability(
    baseUrl = this.options.baseUrl,
    local = false,
  ): Promise<PublicationAvailability> {
    if (this.#closed) throw new Error("Publication client is closed");
    const response = await internalFetch(
      new URL(`${PUBLICATION_PATH}/health${local ? "/local" : ""}`, baseUrl),
      {
        dispatcher: this.#dispatcher,
        headers: { authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Publication ingress is unavailable");
    }
    return parsePublicationAvailability(await response.json());
  }
  async checkHealth(): Promise<void> {
    if (!(await this.publicationAvailability()).partitions.length)
      throw new Error("Publication ingress has no available partitions");
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#owners.clear();
    await this.#dispatcher.destroy();
  }
}
