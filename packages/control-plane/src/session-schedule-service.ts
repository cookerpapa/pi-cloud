import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction, type Selectable } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parseCreateSchedule,
  parseScheduleChange,
  parseScheduledOrigin,
  type CreateSchedule,
  type ScheduleChange,
  type ScheduleTiming,
  type SessionSchedule,
  type SessionScheduleList,
  type SessionScheduleSummary,
  type ScheduleDeletion,
  type ScheduledOrigin,
} from "@pi-cloud/protocol";
import { ControlPlaneStore } from "./control-plane-store.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import {
  latestScheduleTime,
  nextScheduleTime,
  validateScheduleTiming,
  resolveScheduleTiming,
} from "./schedule-calendar.ts";

type Scope = { tenantId: string; sessionId: string };
type DB = Kysely<Database>;
type Cursor = { at: Date; id: string };
type ResourceRow = Pick<
  Selectable<Database["session_schedules"]>,
  | "id"
  | "session_id"
  | "name"
  | "timing"
  | "missed"
  | "revision"
  | "enabled"
  | "next_fire_at"
  | "last_skipped_at"
  | "error_code"
  | "error_message"
  | "created_at"
  | "updated_at"
> & {
  lastId: string | null;
  lastTurnId: string | null;
  lastState: string | null;
  lastSeal: string | null;
  lastSealedAt: Date | null;
  admittedAt: Date | null;
  origin: unknown;
};
const iso = (date: Date | string) => new Date(date).toISOString();
const MISFIRE_GRACE_MS = 60_000;
const busyRun = (r: {
  state: string;
  recovery_requested_at: Date | null;
  output_seal_id: string | null;
  output_sealed_at: Date | null;
}) =>
  !["completed", "cancelled", "failed", "timed_out"].includes(r.state) ||
  r.recovery_requested_at !== null ||
  (r.output_seal_id !== null && r.output_sealed_at === null);
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Current plans in PG; every execution is an existing Run, not a second job. */
export class SessionScheduleService {
  #cursor: Cursor | undefined;
  constructor(
    readonly options: {
      database: DB;
      admissionDatabase?: DB;
      environmentImageRevision?: string;
      /** Deterministic calendar tests only; production always uses PG time. */
      clock?: () => Date;
    },
  ) {}
  async #now(db: DB): Promise<Date> {
    return (
      this.options.clock?.() ??
      (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db)).rows[0]!.now
    );
  }
  async #root(tx: Transaction<Database>, scope: Scope, skipLocked = false) {
    let q = tx
      .selectFrom("sessions")
      .select(["id", "desired_model_profile_id"])
      .where("tenant_id", "=", scope.tenantId)
      .where("id", "=", scope.sessionId)
      .where("session_kind", "=", "conversation")
      .where("pruned_at", "is", null)
      .forNoKeyUpdate();
    if (skipLocked) q = q.skipLocked();
    const row = await q.executeTakeFirst();
    if (!row && !skipLocked)
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    return row;
  }
  #query(scope: Scope, db = this.options.database) {
    return db
      .selectFrom("session_schedules as p")
      .innerJoin("sessions as s", (join) =>
        join.onRef("s.tenant_id", "=", "p.tenant_id").onRef("s.id", "=", "p.session_id"),
      )
      .where("s.pruned_at", "is", null)
      .where("s.session_kind", "=", "conversation")
      .leftJoin("runs as r", "r.id", "p.last_run_id")
      .select([
        "p.id",
        "p.session_id",
        "p.name",
        "p.timing",
        "p.missed",
        "p.revision",
        "p.enabled",
        "p.next_fire_at",
        "p.last_skipped_at",
        "p.error_code",
        "p.error_message",
        "p.created_at",
        "p.updated_at",
      ])
      .select([
        "r.id as lastId",
        "r.turn_id as lastTurnId",
        "r.state as lastState",
        "r.output_seal_id as lastSeal",
        "r.output_sealed_at as lastSealedAt",
        "r.created_at as admittedAt",
        "r.scheduled_origin as origin",
      ])
      .where("p.tenant_id", "=", scope.tenantId)
      .where("p.session_id", "=", scope.sessionId);
  }
  #resource(row: ResourceRow): SessionScheduleSummary {
    const origin = row.origin === null ? null : parseScheduledOrigin(row.origin);
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      timing: row.timing as ScheduleTiming,
      missed: row.missed,
      revision: row.revision,
      state: row.enabled
        ? row.error_code
          ? "waiting"
          : "scheduled"
        : row.error_code
          ? "blocked"
          : row.next_fire_at === null
            ? "finished"
            : "paused",
      nextFireAt: row.next_fire_at === null ? null : iso(row.next_fire_at),
      lastRun:
        row.lastId && row.lastTurnId && row.lastState && row.admittedAt && origin
          ? {
              runId: row.lastId,
              turnId: row.lastTurnId,
              state: row.lastSeal && !row.lastSealedAt ? "settling" : row.lastState,
              scheduledAt: origin.scheduledAt,
              admittedAt: iso(row.admittedAt),
            }
          : null,
      lastSkippedAt: row.last_skipped_at === null ? null : iso(row.last_skipped_at),
      error: row.error_code
        ? { code: row.error_code, message: row.error_message ?? "Schedule needs attention" }
        : null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
  async get(scope: Scope, id: string, db = this.options.database): Promise<SessionSchedule> {
    const row = await this.#query(scope, db)
      .select("p.prompt")
      .where("p.id", "=", id)
      .executeTakeFirst();
    if (!row) throw new ControlPlaneStoreError("not_found", "Schedule was not found");
    return { ...this.#resource(row), prompt: row.prompt };
  }
  async list(scope: Scope, cursor?: string, limit = 50): Promise<SessionScheduleList> {
    let q = this.#query(scope)
      .orderBy("p.id")
      .limit(limit + 1);
    if (cursor) q = q.where("p.id", ">", cursor);
    const rows = await q.execute();
    return {
      schedules: rows.slice(0, limit).map((row) => this.#resource(row)),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  #configuration(input: CreateSchedule): CreateSchedule & { missed: "latest" | "skip" } {
    const parsed = parseCreateSchedule(input);
    const name = parsed.name.trim();
    if (!name || /[\x00-\x1f\x7f]/.test(name))
      throw new ControlPlaneStoreError(
        "invalid_request",
        "Schedule name must be a nonempty single line",
      );
    return {
      name,
      prompt: parsed.prompt,
      timing:
        parsed.timing.kind === "after" ? parsed.timing : validateScheduleTiming(parsed.timing),
      missed: parsed.missed ?? "latest",
    };
  }
  /** The ordinary Tool's ordered, non-replayable dispatch supplies the stable id. */
  async create(scope: Scope, id: string, input: CreateSchedule): Promise<SessionSchedule> {
    const config = this.#configuration(input),
      hash = fingerprint(config);
    return this.options.database.transaction().execute(async (tx) => {
      await this.#root(tx, scope);
      const old = await tx
        .selectFrom("session_schedules")
        .select(["create_request_sha256"])
        .where("tenant_id", "=", scope.tenantId)
        .where("session_id", "=", scope.sessionId)
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (old) {
        if (old.create_request_sha256 !== hash)
          throw new ControlPlaneStoreError(
            "idempotency_conflict",
            "Schedule creation identity was reused with different arguments",
          );
        return this.get(scope, id, tx);
      }
      const now = await this.#now(tx),
        resolved = resolveScheduleTiming(config.timing, now),
        next = nextScheduleTime(resolved, now);
      await tx
        .insertInto("session_schedules")
        .values({
          id,
          tenant_id: scope.tenantId,
          session_id: scope.sessionId,
          name: config.name,
          prompt: config.prompt,
          timing: sql<Record<string, unknown>>`${JSON.stringify(resolved)}::jsonb`,
          missed: config.missed,
          next_fire_at: next,
          available_at: next,
          create_request_sha256: hash,
        })
        .execute();
      return this.get(scope, id, tx);
    });
  }
  async change(scope: Scope, id: string, raw: ScheduleChange): Promise<SessionSchedule> {
    const input = parseScheduleChange(raw);
    return this.options.database.transaction().execute(async (tx) => {
      await this.#root(tx, scope);
      const row = await tx
        .selectFrom("session_schedules")
        .selectAll()
        .where("tenant_id", "=", scope.tenantId)
        .where("session_id", "=", scope.sessionId)
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new ControlPlaneStoreError("not_found", "Schedule was not found");
      if (row.revision !== input.revision)
        throw new ControlPlaneStoreError("conflict", "Schedule changed; refresh it before editing");
      const now = await this.#now(tx);
      const config = this.#configuration({
        name: row.name,
        prompt: row.prompt,
        timing: row.timing as ScheduleTiming,
        missed: row.missed,
        ...(input.action === "update" ? input.patch : {}),
      });
      const resolved = resolveScheduleTiming(config.timing, now);
      let enabled = row.enabled,
        next = row.next_fire_at;
      if (input.action === "pause") enabled = false;
      if (input.action === "resume") {
        enabled = true;
        next = nextScheduleTime(resolved, now);
      }
      if (input.action === "update" && input.patch.timing) next = nextScheduleTime(resolved, now);
      await tx
        .updateTable("session_schedules")
        .set({
          name: config.name,
          prompt: config.prompt,
          timing: sql<Record<string, unknown>>`${JSON.stringify(resolved)}::jsonb`,
          missed: config.missed,
          enabled,
          next_fire_at: next,
          available_at: enabled ? next : null,
          revision: sql`revision+1`,
          retry_count: 0,
          error_code: null,
          error_message: null,
          updated_at: now,
        })
        .where("id", "=", id)
        .execute();
      return this.get(scope, id, tx);
    });
  }
  async delete(scope: Scope, id: string, revision: string): Promise<ScheduleDeletion> {
    return this.options.database.transaction().execute(async (tx) => {
      await this.#root(tx, scope);
      const row = await tx
        .selectFrom("session_schedules")
        .select(["revision", "last_run_id"])
        .where("tenant_id", "=", scope.tenantId)
        .where("session_id", "=", scope.sessionId)
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { id, deleted: true, lastRunId: null, activeRun: null };
      if (row.revision !== revision)
        throw new ControlPlaneStoreError(
          "conflict",
          "Schedule changed; refresh it before deleting",
        );
      const last = row.last_run_id
        ? await tx
            .selectFrom("runs")
            .select([
              "id",
              "turn_id",
              "state",
              "recovery_requested_at",
              "output_seal_id",
              "output_sealed_at",
            ])
            .where("id", "=", row.last_run_id)
            .executeTakeFirst()
        : undefined;
      await tx.deleteFrom("session_schedules").where("id", "=", id).execute();
      return {
        id,
        deleted: true,
        lastRunId: row.last_run_id,
        activeRun:
          last && busyRun(last)
            ? { runId: last.id, turnId: last.turn_id, state: last.state }
            : null,
      };
    });
  }
  async currentTime(): Promise<string> {
    return iso(await this.#now(this.options.database));
  }
  async nextWake(): Promise<{ now: Date; next: Date | null }> {
    const db = this.options.admissionDatabase ?? this.options.database;
    const { rows } = await sql<{ now: Date; next: Date | null }>`select clock_timestamp() as now,
      (select available_at from session_schedules where enabled order by available_at,id limit 1) as next`.execute(
      db,
    );
    return { now: this.options.clock?.() ?? rows[0]!.now, next: rows[0]!.next };
  }
  /** Read candidate ids without holding a batch transaction; each admission locks
   * Session before plan, matching deletion order. A cursor skips contended heads. */
  async dispatchDue(limit = 32): Promise<{ examined: number; admitted: number; advanced: number }> {
    const db = this.options.admissionDatabase ?? this.options.database,
      now = await this.#now(db);
    const read = (cursor: Cursor | undefined) => {
      let q = db
        .selectFrom("session_schedules")
        .select(["id", "tenant_id", "session_id", "revision", "next_fire_at", "available_at"])
        .where("enabled", "=", true)
        .where("available_at", "<=", now)
        .orderBy("available_at")
        .orderBy("id")
        .limit(limit);
      if (cursor)
        q = q.where(sql<boolean>`(available_at,id)>(${cursor.at}::timestamptz,${cursor.id}::uuid)`);
      return q.execute();
    };
    let candidates = await read(this.#cursor);
    if (!candidates.length && this.#cursor) {
      this.#cursor = undefined;
      candidates = await read(undefined);
    }
    const tail = candidates.at(-1);
    this.#cursor = tail?.available_at ? { at: tail.available_at, id: tail.id } : undefined;
    let admitted = 0,
      advanced = 0,
      offset = 0;
    const bySession = new Map<string, typeof candidates>();
    for (const row of candidates) {
      const key = row.tenant_id + ":" + row.session_id;
      const group = bySession.get(key) ?? [];
      group.push(row);
      bySession.set(key, group);
    }
    const groups = [...bySession.values()];
    const work = async () => {
      for (;;) {
        const group = groups[offset++];
        if (!group) return;
        for (const row of group) {
          try {
            const outcome = await this.#fire(db, row);
            if (outcome === 2) admitted++;
            if (outcome > 0) advanced++;
          } catch (error) {
            // CAS cannot rewind an already-committed advancement after a lost ACK.
            const permanent =
              error instanceof ControlPlaneStoreError &&
              !error.retryable &&
              error.code !== "capacity_exhausted";
            const code =
              error instanceof ControlPlaneStoreError
                ? error.code
                : "schedule_admission_unavailable";
            const message =
              error instanceof ControlPlaneStoreError
                ? error.message
                : "Schedule admission is temporarily unavailable";
            const updated = await db
              .updateTable("session_schedules")
              .set({
                enabled: !permanent,
                error_code: code,
                error_message: message.slice(0, 512),
                available_at: permanent
                  ? null
                  : sql`greatest(next_fire_at,clock_timestamp()+least(60,power(2,least(retry_count,6))) * interval '1 second')`,
                retry_count: sql`least(retry_count+1,16)`,
                updated_at: sql`clock_timestamp()`,
              })
              .where("id", "=", row.id)
              .where("revision", "=", row.revision)
              .where("enabled", "=", true)
              .where("next_fire_at", "=", row.next_fire_at)
              .executeTakeFirst();
            if (updated.numUpdatedRows) advanced++;
          }
        }
      }
    };
    await Promise.all([work(), work()]);
    return { examined: candidates.length, admitted, advanced };
  }
  async #fire(
    db: DB,
    candidate: {
      id: string;
      tenant_id: string;
      session_id: string;
      revision: string;
      next_fire_at: Date | null;
    },
  ) {
    const scope = { tenantId: candidate.tenant_id, sessionId: candidate.session_id };
    return db.transaction().execute(async (tx) => {
      const session = await this.#root(tx, scope, true);
      if (!session) {
        const exists = await tx
          .selectFrom("sessions")
          .select("id")
          .where("tenant_id", "=", scope.tenantId)
          .where("id", "=", scope.sessionId)
          .where("session_kind", "=", "conversation")
          .where("pruned_at", "is", null)
          .executeTakeFirst();
        if (exists) return 0; // A live Session is merely locked by another admission.
        await tx
          .updateTable("session_schedules")
          .set({
            enabled: false,
            available_at: null,
            error_code: "not_found",
            error_message: "The target conversation is no longer available",
            updated_at: sql`clock_timestamp()`,
          })
          .where("id", "=", candidate.id)
          .where("revision", "=", candidate.revision)
          .execute();
        return 1;
      }
      const plan = await tx
        .selectFrom("session_schedules")
        .selectAll()
        .where("id", "=", candidate.id)
        .where("tenant_id", "=", scope.tenantId)
        .where("session_id", "=", scope.sessionId)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      const now = await this.#now(tx);
      if (
        !plan?.enabled ||
        !plan.next_fire_at ||
        !plan.available_at ||
        plan.available_at > now ||
        plan.revision !== candidate.revision
      )
        return 0;
      const timing = validateScheduleTiming(plan.timing as ScheduleTiming);
      const planned = latestScheduleTime(timing, plan.next_fire_at, now);
      const next = timing.kind === "once" ? null : nextScheduleTime(timing, now);
      const previous = plan.last_run_id
        ? await tx
            .selectFrom("runs")
            .select(["state", "recovery_requested_at", "output_seal_id", "output_sealed_at"])
            .where("id", "=", plan.last_run_id)
            .executeTakeFirst()
        : undefined;
      const skipped =
        (previous && busyRun(previous)) ||
        (plan.missed === "skip" && now.valueOf() - planned.valueOf() > MISFIRE_GRACE_MS);
      let lastRunId = plan.last_run_id;
      if (!skipped) {
        const origin: ScheduledOrigin = {
          kind: "schedule",
          scheduleId: plan.id,
          name: plan.name,
          revision: plan.revision,
          scheduledAt: planned.toISOString(),
          timezone: timing.kind === "cron" ? timing.timezone : "UTC",
        };
        const store = new ControlPlaneStore({
          database: db,
          tenantId: scope.tenantId,
          defaultModelProfileId: session.desired_model_profile_id,
          ...(this.options.environmentImageRevision
            ? { environmentImageRevision: this.options.environmentImageRevision }
            : {}),
        });
        const run = await store.acceptTurn(
          scope.sessionId,
          `schedule:${plan.id}:${plan.revision}:${origin.scheduledAt}`,
          { prompt: plan.prompt },
          tx,
          origin,
        );
        lastRunId = run.runId;
      }
      await tx
        .updateTable("session_schedules")
        .set({
          enabled: next !== null,
          next_fire_at: next,
          available_at: next,
          last_run_id: lastRunId,
          ...(skipped ? { last_skipped_at: planned } : {}),
          error_code: null,
          error_message: null,
          retry_count: 0,
          updated_at: now,
        })
        .where("id", "=", plan.id)
        .execute();
      return skipped ? 1 : 2;
    });
  }
}
