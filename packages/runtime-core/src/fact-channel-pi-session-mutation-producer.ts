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

export class FactChannelPiSessionMutationProducer {
  readonly #database: Kysely<Database>;
  readonly #channels: ActiveFactChannelResolver;
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

  async checkHealth(): Promise<void> {
    if (this.#closed) throw new Error("Pi Session mutation producer is closed");
    await this.#channels.checkHealth();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  async #mutate(
    scope: PiSessionMutationScope,
    operation: PiSessionMutationOperation,
    events: readonly PiCloudEvent[],
  ) {
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
    const deadline = Date.now() + 120_000;
    let accepted = false;
    let nextSubmitAt = 0;
    let retryDelayMs = 100;
    while (true) {
      const result = await this.#result(scope, mutationId);
      if (result?.state === "completed") return structuredClone(result.result);
      if (result?.state === "failed") {
        throw new SessionError(
          "storage",
          `${result.error_code ?? "storage"}: ${result.error_message ?? "Pi Session mutation failed"}`,
        );
      }
      if (Date.now() >= deadline) throw new Error("Pi Session mutation projection timed out");
      if (!accepted && Date.now() >= nextSubmitAt) {
        const channel = this.#channels.resolve(scope.executionLease);
        const outcome = await channel?.mutate(request).catch(() => undefined);
        if (outcome?.accepted === true && outcome.mutationId === mutationId) {
          accepted = true;
        } else {
          nextSubmitAt = Date.now() + retryDelayMs;
          retryDelayMs = Math.min(1_000, retryDelayMs * 2);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  #result(scope: PiSessionMutationScope, mutationId: string) {
    return this.#database
      .selectFrom("pi_session_mutation_results")
      .select(["state", "result", "error_code", "error_message"])
      .where("mutation_id", "=", mutationId)
      .where("tenant_id", "=", scope.tenantId)
      .where("session_id", "=", scope.sessionId)
      .executeTakeFirst();
  }
}
