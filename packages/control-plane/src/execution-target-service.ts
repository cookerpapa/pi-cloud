import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parseExecutionReference,
  parseExecutionTargetGrants,
  parseExecutorBinding,
  type ExecutionTargetGrant,
  type ExecutionTargetResource,
  type ExecutorBinding,
  type SessionControlChange,
} from "@pi-cloud/protocol";
import type { ExecutorTransport } from "@pi-cloud/sandbox-control";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import { kafkaProducerLane } from "@pi-cloud/runtime-core/kafka-accepted-fact";

type TargetRow = {
  id: string;
  tenant_id: string;
  revision: string;
  name: string;
  kind: "android";
  capabilities: string[];
  endpoint: string;
  bound_session_id: string | null;
  admission_generation: string;
  enabled: boolean;
};
export type ExecutionBindingRow = {
  id: string;
  tenant_id: string;
  target_id: string;
  run_id: string;
  session_id: string;
  pi_session_id: string;
  writer_id: string;
  fencing_token: string;
  conversation_id: string;
  target_revision: string;
  admission_generation: string;
  executor_boot_id: string;
  endpoint: string;
  capabilities: string[];
  closed: boolean;
  revision: string;
};
export const executionBinding = (r: ExecutionBindingRow): ExecutorBinding =>
  parseExecutorBinding({
    bindingId: r.id,
    targetId: r.target_id,
    bootId: r.executor_boot_id,
    generation: r.admission_generation,
    tenantId: r.tenant_id,
    sessionId: r.session_id,
    runId: r.run_id,
    piSessionId: r.pi_session_id,
    writerId: r.writer_id,
    fencingToken: Number(r.fencing_token),
    capabilities: r.capabilities,
  });

/** PG owns registration/binding. The first Android resources are provisioned by
 * the operator; this service never creates or destroys a phone or a Workspace. */
export class ExecutionTargetService {
  #cleanupCursor = "00000000-0000-0000-0000-000000000000";
  constructor(
    readonly options: {
      database: Kysely<Database>;
      transport?: ExecutorTransport;
      publish?(ids: readonly string[]): Promise<void>;
    },
  ) {}
  async list(tenantId: string): Promise<{ targets: ExecutionTargetResource[] }> {
    const { rows } =
      await sql<TargetRow>`select * from execution_targets where tenant_id=${tenantId}::uuid and enabled order by name,id`.execute(
        this.options.database,
      );
    return {
      targets: rows.map((r) => ({
        targetId: r.id,
        revision: r.revision,
        kind: r.kind,
        name: r.name,
        capabilities: r.capabilities,
        boundSessionId: r.bound_session_id,
      })),
    };
  }
  async selection(
    tenantId: string,
    sessionId: string,
  ): Promise<import("@pi-cloud/protocol").SessionExecutionTarget> {
    const { rows } = await sql<{
      revision: string;
      target: ExecutionTargetGrant | null;
    }>`select s.row_version::text as revision,
      case when t.id is null then null else jsonb_build_object('targetId',t.id,'revision',t.revision::text,'kind',t.kind,'name',t.name,'capabilities',t.capabilities) end as target
      from sessions s left join execution_targets t on t.tenant_id=s.tenant_id and t.bound_session_id=s.id
      where s.tenant_id=${tenantId}::uuid and s.id=${sessionId}::uuid and s.pruned_at is null`.execute(
      this.options.database,
    );
    if (!rows[0]) throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    return { sessionId, ...rows[0] };
  }
  async bindSession(
    tenantId: string,
    sessionId: string,
    targetId: string | null,
    revision: string,
  ): Promise<import("@pi-cloud/protocol").SessionExecutionTarget> {
    await this.options.database.transaction().execute(async (tx) => {
      const session = await tx
        .selectFrom("sessions")
        .select(["id", "session_kind", "state", "pi_session_id", "row_version"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", sessionId)
        .where("pruned_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!session) throw new ControlPlaneStoreError("not_found", "Conversation was not found");
      if (session.session_kind !== "conversation")
        throw new ControlPlaneStoreError(
          "conflict",
          "Only a root conversation can control a device",
        );
      const prior = await sql<{
        id: string;
      }>`select id from execution_targets where tenant_id=${tenantId}::uuid and bound_session_id=${sessionId}::uuid`.execute(
        tx,
      );
      if ((prior.rows[0]?.id ?? null) === targetId) return;
      if (session.row_version !== revision)
        throw new ControlPlaneStoreError(
          "conflict",
          "Conversation changed; refresh the device selection",
        );
      const busy =
        await sql`select 1 from runs where tenant_id=${tenantId}::uuid and session_id=${sessionId}::uuid and (state not in ('completed','failed','cancelled','timed_out') or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null))
        union all select 1 from session_leases where tenant_id=${tenantId}::uuid and pi_session_id=${session.pi_session_id} and released_at is null limit 1`.execute(
          tx,
        );
      const pending =
        await sql`select 1 from execution_target_bindings where tenant_id=${tenantId}::uuid and (session_id=${sessionId}::uuid or target_id=${targetId}::uuid) limit 1`.execute(
          tx,
        );
      if (busy.rows.length || pending.rows.length)
        throw new ControlPlaneStoreError(
          "conflict",
          "Finish or stop the current work before changing its device",
        );
      const targets =
        await sql<TargetRow>`select * from execution_targets where tenant_id=${tenantId}::uuid and (bound_session_id=${sessionId}::uuid or id=${targetId}::uuid) order by id for update`.execute(
          tx,
        );
      if (targetId) {
        const target = targets.rows.find((r) => r.id === targetId);
        if (!target || !target.enabled)
          throw new ControlPlaneStoreError("not_found", "Execution target was not found");
        if (target.bound_session_id && target.bound_session_id !== sessionId)
          throw new ControlPlaneStoreError(
            "conflict",
            "This device is already bound to another conversation",
          );
      }
      await sql`update execution_targets set bound_session_id=null,revision=revision+1,updated_at=clock_timestamp() where tenant_id=${tenantId}::uuid and bound_session_id=${sessionId}::uuid and id is distinct from ${targetId}::uuid`.execute(
        tx,
      );
      if (targetId)
        await sql`update execution_targets set bound_session_id=${sessionId}::uuid,revision=revision+1,updated_at=clock_timestamp() where tenant_id=${tenantId}::uuid and id=${targetId}::uuid and bound_session_id is distinct from ${sessionId}::uuid`.execute(
          tx,
        );
      await tx
        .updateTable("sessions")
        .set({ row_version: sql`row_version+1`, updated_at: new Date() })
        .where("id", "=", sessionId)
        .execute();
    });
    return this.selection(tenantId, sessionId);
  }
  async #owner(db: Kysely<Database>, reference: string, lock = false) {
    const identity = parseExecutionReference(reference);
    const query = db
      .selectFrom("runs as r")
      .innerJoin("session_leases as l", "l.lease_id", "r.lease_id")
      .innerJoin("sessions as s", "s.id", "r.session_id")
      .select([
        "r.tenant_id",
        "r.id",
        "r.session_id",
        "r.execution_target_snapshot",
        "s.pi_session_id",
        "s.pi_conversation_id",
        "s.session_kind",
        "l.lease_id",
        "l.fencing_token",
      ])
      .where("r.id", "=", identity.runId)
      .where("l.lease_id", "=", identity.leaseId)
      .where("l.fencing_token", "=", String(identity.fencingToken))
      .where("l.released_at", "is", null)
      .where("l.writer_failed_at", "is", null)
      .where("l.writer_sealed_at", "is", null)
      .where("l.valid_until", ">", sql<Date>`clock_timestamp()`)
      .where("r.output_seal_id", "is", null)
      .where("r.state", "in", ["running", "settling"]);
    const row = await (lock ? query.forShare(["r", "l"]) : query).executeTakeFirst();
    if (!row || row.session_kind !== "conversation")
      throw new ControlPlaneStoreError("conflict", "Execution owner is no longer current");
    return row;
  }
  async prepare(reference: string, grant: ExecutionTargetGrant): Promise<string> {
    if (!this.options.transport || !this.options.publish)
      throw new Error("Execution target transport is unavailable");
    const owner = await this.#owner(this.options.database, reference);
    const selected = parseExecutionTargetGrants(owner.execution_target_snapshot).find(
      (g) => g.targetId === grant.targetId && g.revision === grant.revision,
    );
    if (!selected)
      throw new ControlPlaneStoreError("conflict", "Target was not accepted with this Run");
    const first =
      await sql<TargetRow>`select * from execution_targets where tenant_id=${owner.tenant_id}::uuid and id=${grant.targetId}::uuid and enabled`.execute(
        this.options.database,
      );
    if (!first.rows[0])
      throw new ControlPlaneStoreError("not_found", "Execution target was not found");
    const status = await this.options.transport.inspect(first.rows[0].endpoint);
    if (
      status.targetId !== grant.targetId ||
      !selected.capabilities.every((c) => status.capabilities.includes(c))
    )
      throw new Error("Execution target identity or capabilities changed");
    const id = await this.options.database.transaction().execute(async (tx) => {
      const current = await this.#owner(tx, reference, true);
      const { rows } =
        await sql<TargetRow>`select * from execution_targets where tenant_id=${current.tenant_id}::uuid and id=${grant.targetId}::uuid and enabled for update`.execute(
          tx,
        );
      const target = rows[0];
      if (
        !target ||
        target.revision !== grant.revision ||
        target.bound_session_id !== current.session_id ||
        target.endpoint !== first.rows[0]!.endpoint
      )
        throw new ControlPlaneStoreError("conflict", "Execution target binding changed");
      const old =
        await sql<ExecutionBindingRow>`select * from execution_target_bindings where tenant_id=${current.tenant_id}::uuid and run_id=${current.id}::uuid and writer_id=${current.lease_id}::uuid and target_id=${target.id}::uuid`.execute(
          tx,
        );
      if (old.rows[0]) {
        if (old.rows[0].closed || old.rows[0].executor_boot_id !== status.bootId)
          throw new ControlPlaneStoreError("conflict", "Executor admission has closed");
        return old.rows[0].id;
      }
      const generation = (BigInt(target.admission_generation) + 1n).toString();
      await sql`update execution_targets set admission_generation=${generation}::bigint where id=${target.id}::uuid`.execute(
        tx,
      );
      const bindingId = randomUUID();
      await sql`insert into execution_target_bindings(id,tenant_id,target_id,run_id,session_id,pi_session_id,writer_id,fencing_token,conversation_id,target_revision,admission_generation,executor_boot_id,endpoint,capabilities)
        values(${bindingId}::uuid,${current.tenant_id}::uuid,${target.id}::uuid,${current.id}::uuid,${current.session_id}::uuid,${current.pi_session_id},${current.lease_id}::uuid,${current.fencing_token}::bigint,${current.pi_conversation_id}::bigint,${target.revision}::bigint,${generation}::bigint,${status.bootId}::uuid,${target.endpoint},${JSON.stringify(selected.capabilities)}::jsonb)`.execute(
        tx,
      );
      return bindingId;
    });
    try {
      await this.#owner(this.options.database, reference);
      await this.options.publish([id]);
      return id;
    } catch (error) {
      await this.closeWriter(owner.tenant_id, owner.pi_session_id, owner.lease_id);
      throw error;
    }
  }
  async read(id: string): Promise<ExecutionBindingRow | undefined> {
    return (
      await sql<ExecutionBindingRow>`select * from execution_target_bindings where id=${id}::uuid`.execute(
        this.options.database,
      )
    ).rows[0];
  }
  async closeWriter(tenant: string, session: string, writer: string): Promise<void> {
    const { rows } =
      await sql<ExecutionBindingRow>`update execution_target_bindings set closed=true where tenant_id=${tenant}::uuid and pi_session_id=${session} and writer_id=${writer}::uuid and not closed returning *`.execute(
        this.options.database,
      );
    await Promise.all(rows.map((r) => this.revoke(r)));
  }
  async revoke(row: ExecutionBindingRow): Promise<void> {
    if (!this.options.transport) return;
    try {
      await this.options.transport.revoke(row.endpoint, executionBinding(row));
      await sql`delete from execution_target_bindings where id=${row.id}::uuid and closed`.execute(
        this.options.database,
      );
    } catch {
      /* Closed routing remains durable until endpoint closure can be confirmed. */
    }
  }
  async cleanup(): Promise<void> {
    const { rows } =
      await sql<ExecutionBindingRow>`select * from execution_target_bindings where closed and id>${this.#cleanupCursor}::uuid order by id limit 32`.execute(
        this.options.database,
      );
    this.#cleanupCursor =
      rows.length === 32 ? rows.at(-1)!.id : "00000000-0000-0000-0000-000000000000";
    await Promise.all(rows.map((row) => this.revoke(row)));
  }
  async screen(tenantId: string, targetId: string, signal?: AbortSignal): Promise<Buffer> {
    const { rows } =
      await sql<TargetRow>`select * from execution_targets where tenant_id=${tenantId}::uuid and id=${targetId}::uuid and enabled`.execute(
        this.options.database,
      );
    if (!rows[0] || !this.options.transport)
      throw new ControlPlaneStoreError("not_found", "Device screen is unavailable");
    return this.options.transport.screenshot(rows[0].endpoint, signal);
  }
}

type BindingEntry = {
  row?: ExecutionBindingRow;
  version: bigint;
  closed: boolean;
  readers: number;
  bytes: number;
};
/** Disposable routing: publication preparation may revoke, but only ordered
 * consumption may open a route. Binding IDs never reopen. */
export class ExecutionBindingView {
  readonly #entries = new Map<string, BindingEntry>();
  #generation = 0;
  #partitions = new Set<number>();
  #ready = false;
  #bytes = 0;
  constructor(
    readonly service: ExecutionTargetService,
    readonly partitions: number,
  ) {}
  reset() {
    this.#generation++;
    this.#entries.clear();
    this.#partitions.clear();
    this.#ready = false;
    this.#bytes = 0;
  }
  #entry(id: string): BindingEntry {
    let e = this.#entries.get(id);
    if (e) return e;
    if (this.#entries.size >= 65536) {
      const disposable = [...this.#entries].find(([, v]) => v.closed && !v.readers);
      if (!disposable) throw new Error("Execution binding view capacity exceeded");
      this.#entries.delete(disposable[0]);
    }
    e = { version: -1n, closed: false, readers: 0, bytes: 0 };
    this.#entries.set(id, e);
    return e;
  }
  #apply(entry: BindingEntry, row: ExecutionBindingRow | undefined, version: bigint) {
    if (entry.closed && row && !row.closed) return;
    if (row && version < entry.version) return;
    const active = row && !row.closed ? row : undefined;
    const bytes = active ? Buffer.byteLength(JSON.stringify(active)) : 0;
    if (this.#bytes - entry.bytes + bytes > 64 * 1024 * 1024)
      throw new Error("Execution binding view byte capacity exceeded");
    this.#bytes += bytes - entry.bytes;
    entry.bytes = bytes;
    entry.closed ||= !row || row.closed;
    entry.version = version > entry.version ? version : entry.version;
    if (active) entry.row = structuredClone(active);
    else delete entry.row;
  }
  async load(partitions: readonly number[], current: () => boolean) {
    this.reset();
    const generation = this.#generation;
    this.#partitions = new Set(partitions);
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const { rows } =
        await sql<ExecutionBindingRow>`select * from execution_target_bindings where not closed and id>${after}::uuid order by id limit 128`.execute(
          this.service.options.database,
        );
      if (!current() || generation !== this.#generation) return;
      for (const row of rows)
        if (this.#partitions.has(kafkaProducerLane(row.pi_session_id, this.partitions)))
          this.#apply(this.#entry(row.id), row, BigInt(row.revision));
      if (rows.length < 128) break;
      after = rows.at(-1)!.id;
    }
    this.#ready = true;
  }
  async #change(change: SessionControlChange, current: () => boolean, closureOnly: boolean) {
    if (change.entity !== "execution_binding") return;
    if (
      !current() ||
      !this.#ready ||
      !this.#partitions.has(kafkaProducerLane(change.scope.piSessionId, this.partitions))
    )
      throw new Error("Execution binding view owner is unavailable");
    const generation = this.#generation,
      entry = this.#entry(change.entityId);
    if (!closureOnly && BigInt(change.version) <= entry.version) return;
    entry.readers++;
    try {
      const row = await this.service.read(change.entityId);
      if (!current() || generation !== this.#generation) return;
      if (
        row &&
        (row.tenant_id !== change.scope.tenantId ||
          row.pi_session_id !== change.scope.piSessionId ||
          row.run_id !== change.runId)
      )
        throw new Error("Execution binding scope changed");
      if (row && BigInt(row.revision) < BigInt(change.version))
        throw new Error("Execution binding is behind its change");
      if (!closureOnly || !row || row.closed)
        this.#apply(entry, row, BigInt(row?.revision ?? change.version));
    } finally {
      entry.readers--;
    }
  }
  prepare(change: SessionControlChange, current: () => boolean) {
    return this.#change(change, current, true);
  }
  consume(change: SessionControlChange, current: () => boolean) {
    return this.#change(change, current, false);
  }
  get(
    id: string,
    scope: {
      tenantId: string;
      sessionId: string;
      runId: string;
      piSessionId: string;
      writerId: string;
      fencingToken: number;
    },
  ): ExecutionBindingRow | undefined {
    if (!this.#ready) throw new Error("Execution binding view has not recovered");
    const row = this.#entries.get(id)?.row;
    return row &&
      !row.closed &&
      row.tenant_id === scope.tenantId &&
      row.run_id === scope.runId &&
      row.session_id === scope.sessionId &&
      row.pi_session_id === scope.piSessionId &&
      row.writer_id === scope.writerId &&
      row.fencing_token === String(scope.fencingToken)
      ? row
      : undefined;
  }
  async closeWriter(scope: { tenantId: string; piSessionId: string; writerId: string }) {
    for (const entry of this.#entries.values()) {
      const row = entry.row;
      if (
        row &&
        row.tenant_id === scope.tenantId &&
        row.pi_session_id === scope.piSessionId &&
        row.writer_id === scope.writerId
      )
        this.#apply(entry, undefined, entry.version);
    }
    await this.service.closeWriter(scope.tenantId, scope.piSessionId, scope.writerId);
  }
}
