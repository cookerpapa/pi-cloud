import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  DurablePostgresProjection,
  type StoredDurableBatch,
} from "@pi-cloud/pi-session-postgres/durable";
import type { AcceptedDurableCommitFact } from "./accepted-fact.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";
import { projectionTransaction, type ProjectionBudget } from "./projection-transaction.ts";

export class PostgresDurableCommitProjector {
  readonly #views = new Map<string, DurablePostgresProjection>();
  constructor(
    readonly database: Kysely<Database>,
    readonly budget?: ProjectionBudget,
  ) {}
  #key(scope: AcceptedDurableCommitFact["scope"]): string {
    return JSON.stringify([scope.tenantId, scope.piSessionId]);
  }
  #view(scope: AcceptedDurableCommitFact["scope"]): DurablePostgresProjection {
    const key = this.#key(scope);
    let view = this.#views.get(key);
    if (!view) {
      view = new DurablePostgresProjection(
        this.database,
        { tenantId: scope.tenantId, sessionId: scope.piSessionId },
        undefined,
        "references",
      );
      this.#views.set(key, view);
    }
    return view;
  }
  reset(): void {
    this.#views.clear();
  }
  releaseSettled(scope: AcceptedDurableCommitFact["scope"]): void {
    const key = this.#key(scope);
    if (this.#views.get(key)?.liveState.rows.size === 0) this.#views.delete(key);
  }
  async project(
    fact: AcceptedDurableCommitFact,
    position: FactPosition,
    current: () => boolean = () => true,
  ): Promise<void> {
    const view = this.#view(fact.scope),
      state = view.liveState.fork();
    if (!current()) return;
    await projectionTransaction(
      this.database,
      async (tx) => {
        // Materialize the locked Run before locking the shared lease. Keep this
        // append path's Run -> lease -> native order; a plain join can reorder locks.
        // Both locking reads recheck changed tuples after a concurrent lock wait.
        const {
          rows: [run],
        } = await sql<{
          lease_id: string | null;
          output_seal_offset: string | null;
          output_first_topic: string | null;
          output_first_partition: number | null;
          output_first_offset: string | null;
          writer_seal_offset: string | null;
        }>`with locked_run as materialized (
          select lease_id,output_seal_offset,output_first_topic,output_first_partition,output_first_offset
          from runs where tenant_id=${fact.scope.tenantId}::uuid and id=${fact.scope.runId}::uuid
          for no key update
        ) select r.*,l.writer_seal_offset from locked_run r
          join session_leases l on l.tenant_id=${fact.scope.tenantId}::uuid
            and l.lease_id=r.lease_id
          where r.lease_id=${fact.scope.writerId}::uuid
          for no key update of l`.execute(tx);
        if (
          !run ||
          run.lease_id !== fact.scope.writerId ||
          (run.output_seal_offset !== null && position.offset >= BigInt(run.output_seal_offset)) ||
          (run.writer_seal_offset !== null && position.offset > BigInt(run.writer_seal_offset))
        )
          return;
        await view.applyIn(tx, fact.commit as unknown as StoredDurableBatch, fact.origins, {
          state,
          position,
        });
        if (
          run.output_first_offset !== null &&
          (run.output_first_topic !== position.topic ||
            run.output_first_partition !== position.partition)
        )
          throw new Error("Native Run publication moved between Kafka streams");
        if (run.output_first_offset === null)
          await tx
            .updateTable("runs")
            .set({
              output_first_topic: position.topic,
              output_first_partition: position.partition,
              output_first_offset: position.offset.toString(),
            })
            .where("tenant_id", "=", fact.scope.tenantId)
            .where("id", "=", fact.scope.runId)
            .where("lease_id", "=", fact.scope.writerId)
            .execute();
        await recordFactProjection(tx, position);
        if (!current()) throw new Error("Native projection owner changed before commit");
      },
      this.budget,
    );
    if (current() && this.#views.get(this.#key(fact.scope)) === view) view.liveState.adopt(state);
  }
  async replay(
    fact: AcceptedDurableCommitFact,
    position: FactPosition,
    current: () => boolean = () => true,
  ): Promise<void> {
    if (!current()) return;
    const view = this.#view(fact.scope),
      state = view.liveState.fork();
    await projectionTransaction(
      this.database,
      async (tx) => {
        const proof = await sql<{
          writer_seal_offset: string | null;
          output_seal_offset: string | null;
          lease_id: string | null;
        }>`
        select l.writer_seal_offset,r.output_seal_offset,r.lease_id
        from session_leases l left join runs r on r.id=${fact.scope.runId}::uuid and r.tenant_id=l.tenant_id
        where l.tenant_id=${fact.scope.tenantId}::uuid and l.lease_id=${fact.scope.writerId}::uuid
          and l.pi_session_id=${fact.scope.piSessionId}`.execute(tx);
        const accepted = proof.rows[0];
        if (
          !accepted ||
          (accepted.writer_seal_offset !== null &&
            position.offset >= BigInt(accepted.writer_seal_offset)) ||
          (accepted.lease_id === fact.scope.writerId &&
            accepted.output_seal_offset !== null &&
            position.offset >= BigInt(accepted.output_seal_offset))
        )
          return;
        await view.replayLiveIn(tx, fact.commit as unknown as StoredDurableBatch, fact.origins, {
          state,
          position,
        });
        if (!current()) throw new Error("Native replay owner changed before completion");
      },
      this.budget,
    );
    if (current() && this.#views.get(this.#key(fact.scope)) === view) view.liveState.adopt(state);
  }
  async checkpointLiveIn(
    tx: Transaction<Database>,
    scope: AcceptedDurableCommitFact["scope"],
    current: () => boolean,
  ): Promise<() => void> {
    const view = this.#view(scope),
      state = view.liveState.fork();
    await view.checkpointLiveIn(tx, state);
    if (!current()) throw new Error("Native checkpoint owner changed before commit");
    return () => {
      if (current() && this.#views.get(this.#key(scope)) === view)
        this.#views.delete(this.#key(scope));
    };
  }
}
