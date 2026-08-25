import type { Database } from "@pi-cloud/database";
import { parseExecutionGrant } from "@pi-cloud/protocol";
import { SessionError } from "@earendil-works/pi-agent-core";
import type { Kysely, Transaction } from "kysely";
import type { ActiveExecutionAuthority } from "./execution-authority.ts";

export type PostgresRunExecutionAuthorityOptions = {
  database: Kysely<Database>;
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  executionGrant: string;
  clock?: () => Date;
  pollIntervalMs?: number;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** Opaque Run authority checked at each durable Pi Session effect boundary. */
export class PostgresRunExecutionAuthority implements ActiveExecutionAuthority {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #runId: string;
  readonly #turnId: string;
  readonly #executionGrant: ReturnType<typeof parseExecutionGrant>;
  readonly #clock: () => Date;
  readonly #pollIntervalMs: number;
  readonly #abort = new AbortController();
  #watch: Promise<void> | undefined;
  #closed = false;

  constructor(options: PostgresRunExecutionAuthorityOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#sessionId = options.sessionId;
    this.#runId = options.runId;
    this.#turnId = options.turnId;
    this.#executionGrant = parseExecutionGrant(options.executionGrant);
    this.#clock = options.clock ?? (() => new Date());
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  start(): void {
    if (this.#closed) throw new Error("PostgreSQL Run execution authority is closed");
    this.#watch ??= this.#watchCurrent();
  }

  async assertCurrent(database?: Transaction<Database>): Promise<void> {
    if (this.#closed || this.#abort.signal.aborted) {
      throw new SessionError("storage", "Pi Session execution authority is no longer active");
    }
    const authority = database ?? this.#database;
    const row = await authority
      .selectFrom("execution_grants")
      .select("grant_id")
      .where("grant_id", "=", this.#executionGrant.grantId)
      .where("execution_id", "=", this.#executionGrant.executionId)
      .where("generation", "=", String(this.#executionGrant.generation))
      .where("tenant_id", "=", this.#tenantId)
      .where("session_id", "=", this.#sessionId)
      .where("run_id", "=", this.#runId)
      .where("turn_id", "=", this.#turnId)
      .where("valid_until", ">", this.#clock())
      .executeTakeFirst();
    if (row === undefined) {
      const error = new SessionError(
        "storage",
        "Pi Session mutation was rejected by a stale ExecutionGrant",
      );
      this.#abort.abort(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort(new Error("PostgreSQL Run execution authority closed"));
    await this.#watch;
  }

  async #watchCurrent(): Promise<void> {
    while (!this.#closed && !this.#abort.signal.aborted) {
      await new Promise<void>((resolvePromise) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#abort.signal.removeEventListener("abort", settle);
          resolvePromise();
        };
        const timer = setTimeout(settle, this.#pollIntervalMs);
        timer.unref();
        this.#abort.signal.addEventListener("abort", settle, { once: true });
      });
      if (this.#closed || this.#abort.signal.aborted) return;
      try {
        await this.assertCurrent();
      } catch {
        return;
      }
    }
  }
}
