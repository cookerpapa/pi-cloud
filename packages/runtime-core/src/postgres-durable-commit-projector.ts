import { resolveDurableText, type PiCloudEvent } from "@pi-cloud/protocol";
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
  ): Promise<{ events: PiCloudEvent[]; covers: { sessionId: string; through: number }[] }> {
    const events: PiCloudEvent[] = [],
      covers: { sessionId: string; through: number }[] = [];
    const view = this.#view(fact.scope),
      state = view.liveState.fork();
    if (!current()) return { events, covers };
    await projectionTransaction(
      this.database,
      async (tx) => {
        // Lock all affected Runs in deterministic order before the shared lease.
        // Materialization plus aggregation forces completion of every Run lock;
        // never acquire a sibling Run after holding the lease.
        const ids = [
          ...new Set([fact.scope.runId, ...fact.display.map((d) => d.scope.runId)]),
        ].sort();
        type LockedRun = {
          id: string;
          session_id: string;
          turn_id: string;
          lease_id: string | null;
          output_seal_offset: string | null;
          output_first_topic: string | null;
          output_first_partition: number | null;
          output_first_offset: string | null;
          output_display_seq: string;
        };
        const {
          rows: [locked],
        } = await sql<{
          runs: LockedRun[];
          writer_seal_offset: string | null;
        }>`with locked_runs as materialized (
          select id,session_id,turn_id,lease_id,output_seal_offset::text,output_first_topic,output_first_partition,output_first_offset::text,output_display_seq::text
          from runs where tenant_id=${fact.scope.tenantId}::uuid and id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
          order by id for no key update
        ), gathered as materialized (select jsonb_agg(to_jsonb(r)) as runs from locked_runs r)
        select g.runs,l.writer_seal_offset from gathered g join session_leases l
          on l.tenant_id=${fact.scope.tenantId}::uuid and l.lease_id=${fact.scope.writerId}::uuid
        where g.runs is not null for no key update of l`.execute(tx);
        if (
          !locked ||
          locked.runs.length !== ids.length ||
          (locked.writer_seal_offset !== null &&
            position.offset > BigInt(locked.writer_seal_offset))
        )
          return;
        const runs = new Map(locked.runs.map((r) => [r.id, r]));
        for (const scope of [fact.scope, ...fact.display.map((d) => d.scope)]) {
          const run = runs.get(scope.runId)!;
          if (
            run.lease_id !== scope.writerId ||
            run.session_id !== scope.sessionId ||
            run.turn_id !== scope.turnId ||
            (run.output_seal_offset !== null && position.offset >= BigInt(run.output_seal_offset))
          )
            return;
          if (
            run.output_first_offset !== null &&
            (run.output_first_topic !== position.topic ||
              run.output_first_partition !== position.partition)
          )
            throw new Error("Native Run publication moved between Kafka streams");
        }
        await view.applyIn(tx, fact.commit as unknown as StoredDurableBatch, fact.origins, {
          state,
          position,
        });
        const floors = locked.runs.filter((r) => r.output_first_offset === null).map((r) => r.id);
        if (floors.length)
          await tx
            .updateTable("runs")
            .set({
              output_first_topic: position.topic,
              output_first_partition: position.partition,
              output_first_offset: position.offset.toString(),
            })
            .where("tenant_id", "=", fact.scope.tenantId)
            .where("id", "in", floors)
            .execute();
        for (const display of fact.display) {
          const previous = Number(runs.get(display.scope.runId)!.output_display_seq);
          // Historical live documents may have been superseded by a newer PG
          // checkpoint. Never resolve text already represented by native Entries.
          for (const description of display.texts) {
            if (description.event.seq <= previous) continue;
            events.push(
              resolveDurableText(fact.commit, description, (id) => {
                const row = state.rows.get(id);
                if (
                  !row ||
                  state.through !== fact.commit.seq ||
                  Number(row.seq) !== fact.commit.seq
                )
                  throw new Error("Native display is missing its current document projection");
                return JSON.parse(row.body).content.value;
              }),
            );
          }
          if (display.coveredThrough !== undefined)
            covers.push({ sessionId: display.scope.sessionId, through: display.coveredThrough });
        }
        const covered = fact.display.filter((d) => d.coveredThrough !== undefined);
        if (covered.length)
          await sql`update runs r set
          output_display_seq=greatest(r.output_display_seq,c.through),
          output_display_native_seq=greatest(r.output_display_native_seq,${fact.commit.seq})
          from (values ${sql.join(covered.map((d) => sql`(${d.scope.runId}::uuid,${d.coveredThrough!}::bigint)`))}) as c(id,through)
          where r.id=c.id and r.tenant_id=${fact.scope.tenantId}::uuid`.execute(tx);
        await recordFactProjection(tx, position);
        if (!current()) throw new Error("Native projection owner changed before commit");
      },
      this.budget,
    );
    if (current() && this.#views.get(this.#key(fact.scope)) === view) view.liveState.adopt(state);
    return { events, covers };
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
