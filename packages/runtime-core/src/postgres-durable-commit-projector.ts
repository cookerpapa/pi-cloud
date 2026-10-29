import { resolveDurableDisplay, type PiCloudEvent } from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  DurablePostgresProjection,
  type StoredDurableBatch,
} from "@pi-cloud/pi-session-postgres/durable";
import type { AcceptedDurableCommitFact } from "./accepted-fact.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";
import { projectionTransaction, type ProjectionBudget } from "./projection-transaction.ts";
import { captureNativePresentation } from "./frozen-history.ts";

function cloudMetadata(fact: AcceptedDurableCommitFact) {
  const controlTools = fact.tools.filter((tool) => tool.target === "control");
  return controlTools.length ? { controlTools } : undefined;
}

export class PostgresDurableCommitProjector {
  readonly #views = new Map<string, DurablePostgresProjection>();
  constructor(
    readonly database: Kysely<Database>,
    readonly budget?: ProjectionBudget,
  ) {}
  #key(scope: AcceptedDurableCommitFact["scope"]): string {
    // All Conversations/anchors of one physical writer share this view. Old
    // closure replay must never evict the next lease incarnation's live suffix.
    return JSON.stringify([scope.tenantId, scope.piSessionId, scope.writerId]);
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
  /** Caller has confirmed closure/checkpoint in its transaction. Invoke only
   * after COMMIT, including when reconciling a previously lost commit return. */
  closedWriterCleanup(
    scope: AcceptedDurableCommitFact["scope"],
    current: () => boolean,
  ): () => void {
    const key = this.#key(scope);
    return this.#viewCleanup(key, this.#views.get(key), current);
  }
  #viewCleanup(
    key: string,
    view: DurablePostgresProjection | undefined,
    current: () => boolean,
  ): () => void {
    return () => {
      if (current() && view !== undefined && this.#views.get(key) === view) this.#views.delete(key);
    };
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
        // Every child view shares the root Run. Materialize its lock before
        // locking the lease; the native Session lock follows in applyIn().
        const {
          rows: [run],
        } = await sql<{
          id: string;
          session_id: string;
          turn_id: string;
          lease_id: string | null;
          output_seal_offset: string | null;
          output_first_topic: string | null;
          output_first_partition: number | null;
          output_first_offset: string | null;
          output_display_seq: string;
          writer_seal_offset: string | null;
        }>`with locked_run as materialized (
          select id,session_id,turn_id,lease_id,output_seal_offset::text,output_first_topic,output_first_partition,output_first_offset::text,output_display_seq::text
          from runs where tenant_id=${fact.scope.tenantId}::uuid and id=${fact.scope.runId}::uuid
          for no key update
        ) select r.*,l.writer_seal_offset from locked_run r join session_leases l
          on l.tenant_id=${fact.scope.tenantId}::uuid and l.lease_id=${fact.scope.writerId}::uuid
        for no key update of l`.execute(tx);
        if (
          !run ||
          (run.writer_seal_offset !== null && position.offset > BigInt(run.writer_seal_offset))
        )
          return;
        if (
          run.lease_id !== fact.scope.writerId ||
          run.session_id !== fact.scope.sessionId ||
          run.turn_id !== fact.scope.turnId ||
          (run.output_seal_offset !== null && position.offset >= BigInt(run.output_seal_offset))
        )
          return;
        if (
          run.output_first_offset !== null &&
          (run.output_first_topic !== position.topic ||
            run.output_first_partition !== position.partition)
        )
          throw new Error("Native Run publication moved between Kafka streams");
        const displayViews = fact.display.length
          ? await sql<{
              session_id: string;
              turn_id: string;
              id: string;
              output_display_seq: string;
            }>`select session_id,turn_id,id,output_display_seq::text from conversation_turns
          where tenant_id=${fact.scope.tenantId}::uuid and id=${fact.scope.runId}::uuid
            and session_id=any(${fact.display.map((d) => d.scope.sessionId)}::uuid[])`.execute(tx)
          : { rows: [] };
        const displays = new Map(displayViews.rows.map((r) => [r.session_id, r]));
        for (const display of fact.display) {
          const target = displays.get(display.scope.sessionId);
          if (
            !target ||
            target.turn_id !== display.scope.turnId ||
            display.scope.runId !== fact.scope.runId ||
            display.scope.writerId !== fact.scope.writerId ||
            display.scope.piSessionId !== fact.scope.piSessionId
          )
            throw new Error("Native display has no admitted Conversation view");
        }
        const appended = await view.applyIn(
          tx,
          fact.commit as unknown as StoredDurableBatch,
          fact.origins,
          { state, position },
          cloudMetadata(fact),
        );
        if (
          appended &&
          fact.commit.writes.some((write) => write.type === "entry" || write.type === "task")
        )
          await captureNativePresentation(
            tx,
            { tenantId: fact.scope.tenantId, sessionId: fact.scope.piSessionId },
            fact.commit.seq,
          );
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
            .execute();
        for (const display of fact.display) {
          const previous = Number(displays.get(display.scope.sessionId)!.output_display_seq);
          // Historical live documents may have been superseded by a newer PG
          // checkpoint. Never resolve text already represented by native Entries.
          for (const description of display.events) {
            if (description.event.seq <= previous) continue;
            events.push(
              resolveDurableDisplay(fact.commit, description, (id) => {
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
        if (covered.length) {
          const coverage = sql`(values ${sql.join(covered.map((d) => sql`(${d.scope.sessionId}::uuid,${d.scope.turnId}::uuid,${d.coveredThrough!}::bigint)`))})`;
          await sql`with coverage(session_id,turn_id,through) as ${coverage}, root as (
          update runs r set
          output_display_seq=greatest(r.output_display_seq,c.through),
          output_display_native_seq=greatest(r.output_display_native_seq,${fact.commit.seq})
          from coverage c where r.session_id=c.session_id and r.turn_id=c.turn_id
            and r.id=${fact.scope.runId}::uuid and r.tenant_id=${fact.scope.tenantId}::uuid
            and (r.output_display_seq<c.through or r.output_display_native_seq<${fact.commit.seq}) returning r.id)
          update subagent_conversations v set output_display_seq=greatest(v.output_display_seq,c.through),
            output_display_native_seq=greatest(v.output_display_native_seq,${fact.commit.seq})
          from coverage c where v.child_session_id=c.session_id and v.child_turn_id=c.turn_id
            and v.root_run_id=${fact.scope.runId}::uuid and v.tenant_id=${fact.scope.tenantId}::uuid
            and (v.output_display_seq<c.through or v.output_display_native_seq<${fact.commit.seq})`.execute(
            tx,
          );
        }
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
        await view.replayLiveIn(
          tx,
          fact.commit as unknown as StoredDurableBatch,
          fact.origins,
          { state, position },
          cloudMetadata(fact),
        );
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
    return this.#viewCleanup(this.#key(scope), view, current);
  }
}
