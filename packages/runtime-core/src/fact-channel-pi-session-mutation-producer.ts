import type { Database } from "@pi-cloud/database";
import type {
  PiSessionMutationOperation,
  PiSessionMutationPublisher,
} from "@pi-cloud/pi-session-postgres";
import type { PiCloudEvent } from "@pi-cloud/protocol";
import { SessionError } from "@earendil-works/pi-agent-core";
import type { Kysely } from "kysely";
import type { ActiveFactChannelResolver, CandidatePiSessionMutationFact } from "./accepted-fact.ts";

export type PiSessionMutationScope = Readonly<{
  tenantId: string;
  sessionId: string;
  piSessionId: string;
  piSessionLane: string;
  turnId: string;
  runId: string;
  executionLease: string;
}>;

type PendingProjection = {
  scope: PiSessionMutationScope;
  deadline: number;
  resolve(result: unknown): void;
  reject(error: unknown): void;
};

/** One shared receipt reader per Worker; notifications are only wake-up hints. */
export class FactChannelPiSessionMutationProducer {
  readonly #database: Kysely<Database>;
  readonly #channels: ActiveFactChannelResolver;
  readonly #pending = new Map<string, PendingProjection>();
  #timer: NodeJS.Timeout | undefined;
  #checking: Promise<void> | undefined;
  #checkRequested = false;
  #closed = false;

  constructor(options: { database: Kysely<Database>; channels: ActiveFactChannelResolver }) {
    this.#database = options.database;
    this.#channels = options.channels;
  }

  scoped(scope: PiSessionMutationScope): PiSessionMutationPublisher {
    return {
      mutate: (operation, events = []) => this.#mutate(scope, operation, events),
      synchronize: async () => {
        await this.#mutate(scope, { kind: "projection_barrier" }, []);
      },
    };
  }

  notifyProjected(mutationId: string): void {
    if (this.#pending.has(mutationId)) this.#requestCheck();
  }

  async checkHealth(): Promise<void> {
    if (this.#closed) throw new Error("Pi Session mutation producer is closed");
    await this.#channels.checkHealth();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const pending of this.#pending.values())
      pending.reject(new Error("Pi Session mutation producer closed"));
    this.#pending.clear();
    await this.#checking;
  }

  async #mutate(
    scope: PiSessionMutationScope,
    operation: PiSessionMutationOperation,
    events: readonly PiCloudEvent[],
  ): Promise<unknown> {
    if (this.#closed) throw new Error("Pi Session mutation producer is closed");
    const mutationId = globalThis.crypto.randomUUID();
    const request: CandidatePiSessionMutationFact = {
      schemaVersion: 1,
      mutationId,
      scope,
      operation,
      events,
      occurredAt: new Date().toISOString(),
    };
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(mutationId, { scope, deadline: Date.now() + 120_000, resolve, reject });
    });
    // Notifications may precede the transport ACK. Register first, but do not
    // query a fresh ID until publication or a committed notification.
    void result.catch(() => undefined);
    try {
      const channel = this.#channels.resolve(scope.executionLease);
      if (channel === undefined) throw new Error("Pi Session Fact Stream is unavailable");
      const ack = await channel.mutate(request);
      if (ack.mutationId !== mutationId || !ack.accepted)
        throw new Error("Pi Session receipt identity changed");
      this.#requestCheck();
      return await result;
    } finally {
      this.#pending.delete(mutationId);
      if (this.#pending.size === 0) clearTimeout(this.#timer);
    }
  }

  #requestCheck(): void {
    if (this.#closed || this.#pending.size === 0) return;
    this.#checkRequested = true;
    clearTimeout(this.#timer);
    if (this.#checking !== undefined) return;
    this.#checking = Promise.resolve()
      .then(async () => {
        while (this.#checkRequested && !this.#closed) {
          this.#checkRequested = false;
          await this.#readPending();
        }
      })
      .finally(() => {
        this.#checking = undefined;
        if (this.#checkRequested && !this.#closed) {
          this.#requestCheck();
          return;
        }
        if (!this.#closed && this.#pending.size > 0) {
          this.#timer = setTimeout(() => this.#requestCheck(), 1_000);
          this.#timer.unref();
        }
      });
  }

  async #readPending(): Promise<void> {
    for (const [id, pending] of this.#pending) {
      if (Date.now() >= pending.deadline) {
        this.#pending.delete(id);
        pending.reject(new Error("Pi Session mutation projection timed out"));
      }
    }
    const ids = [...this.#pending.keys()];
    for (let index = 0; index < ids.length; index += 256) {
      try {
        const rows = await this.#database
          .selectFrom("pi_session_mutation_results")
          .select([
            "mutation_id",
            "tenant_id",
            "session_id",
            "state",
            "result",
            "error_code",
            "error_message",
          ])
          .where("mutation_id", "in", ids.slice(index, index + 256))
          .execute();
        for (const row of rows) {
          const pending = this.#pending.get(row.mutation_id);
          if (
            pending === undefined ||
            row.tenant_id !== pending.scope.tenantId ||
            row.session_id !== pending.scope.sessionId
          )
            continue;
          this.#pending.delete(row.mutation_id);
          if (row.state === "completed") pending.resolve(structuredClone(row.result));
          else
            pending.reject(
              new SessionError(
                "storage",
                `${row.error_code ?? "storage"}: ${row.error_message ?? "Pi Session mutation failed"}`,
              ),
            );
        }
      } catch {
        // Failed reads never acknowledge a mutation. One bounded fallback per
        // Worker checks the same IDs even when the LISTEN connection is lost.
      }
    }
  }
}
