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
import type {
  AcceptedFact,
  AcceptedFactBus,
  AcceptedFactReceipt,
  ExecutionPublication,
} from "./accepted-fact.ts";

export const PUBLICATION_PATH = "/internal/v1/session-publication";

/** A pooled private HTTP hop; a successful response is the Kafka commit ACK. */
export class HttpPublicationClient implements AcceptedFactBus, SessionControlPublisher {
  readonly #dispatcher = new Agent({ connections: 16 });
  readonly #owners = new Map<string, string>();
  readonly #scopes = new Map<string, ExecutionPublication>();
  #closed = false;

  constructor(readonly options: { baseUrl: string; token: string; timeoutMs?: number }) {}

  async open(publication: ExecutionPublication, signal?: AbortSignal): Promise<void> {
    await this.#request("open", publication.scope.piSessionId, publication, true, signal);
    signal?.throwIfAborted();
    this.#scopes.set(publication.scope.runId, structuredClone(publication));
  }

  async publishControl(change: SessionControlChange): Promise<AcceptedFactReceipt> {
    return (await this.#request(
      "control",
      change.scope.piSessionId,
      change,
      false,
    )) as AcceptedFactReceipt;
  }

  async append(fact: AcceptedFact): Promise<AcceptedFactReceipt> {
    try {
      return (await this.#request(
        fact.kind === "execution_seal" ? "seal" : "append",
        fact.scope.piSessionId,
        fact,
        false,
      )) as AcceptedFactReceipt;
    } catch (error) {
      if (error instanceof RemotePublicationNotOpen && fact.kind !== "execution_seal") {
        const scope = this.#scopes.get(fact.scope.runId);
        if (!scope) throw error;
        // A new ingress owner has no soft state. Reinstall the PG grant only
        // after it positively rejected this record before enqueueing it.
        await this.open(scope);
        return (await this.#request(
          "append",
          fact.scope.piSessionId,
          fact,
          false,
        )) as AcceptedFactReceipt;
      }
      throw error;
    }
  }

  async #request(
    action: "open" | "append" | "seal" | "control",
    sessionId: string,
    value: unknown,
    opening: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed) throw new PublicationNotSentError("Publication client closed before send");
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > (opening ? 8192 : MAX_EXECUTION_FACT_BYTES))
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
        if (opening)
          throw new PublicationNotSentError("Publication scope could not be installed", {
            cause: error,
          });
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
      const payload = (await response.json()) as {
        factId?: string;
        durable?: boolean;
        error?: { code?: string; reason?: string };
      };
      if (response.ok) return payload;
      if (payload.error?.code === "publication_not_sent") {
        const reason = payload.error.reason;
        if (
          (reason === "not_owner" || (opening && reason === "not_open")) &&
          Date.now() < deadline
        ) {
          this.#owners.delete(sessionId);
          base = this.options.baseUrl;
          await delay(50, undefined, { signal });
          continue;
        }
        if (reason === "not_open") throw new RemotePublicationNotOpen();
        throw new PublicationNotSentError(
          `Publication rejected before Kafka admission: ${reason ?? "unavailable"}`,
        );
      }
      throw new Error("Publication commit could not be confirmed");
    }
  }

  forget(runId: string): void {
    this.#scopes.delete(runId);
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
    this.#scopes.clear();
    this.#owners.clear();
    await this.#dispatcher.destroy();
  }
}

class RemotePublicationNotOpen extends PublicationNotSentError {
  constructor() {
    super("Publication scope is not installed on this owner");
  }
}
