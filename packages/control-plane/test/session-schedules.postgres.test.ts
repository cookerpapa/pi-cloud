import { createControlPlaneApplication } from "../src/application.ts";
import { emptyEventRuntime } from "./fixtures/event-runtime.ts";
import { createScheduleTool } from "../src/ordinary-tools/schedule-tool.ts";
import { ControlToolRegistry } from "../src/control-tool-registry.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql, type Kysely } from "kysely";
import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { parseSessionSchedule, parseSessionScheduleList } from "@pi-cloud/protocol";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { SessionScheduleService } from "../src/session-schedule-service.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";

const external = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.sequential("transactional scheduled Run admission", () => {
  let db: Kysely<Database>, admin: Pool, name: string;
  beforeAll(async () => {
    if (!external) throw Error("Use isolated PG runner");
    admin = new Pool({ connectionString: external, max: 1 });
    name = "schedules_" + randomUUID().replaceAll("-", "");
    await admin.query(`create database "${name}"`);
    const url = new URL(external);
    url.pathname = "/" + name;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
    await runMigrations(db, "up");
  }, 60000);
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.query(`drop database "${name}"`);
      await admin.end();
    }
  });
  afterEach(async () => {
    await db.deleteFrom("session_schedules").execute();
  });
  async function fixture() {
    const tenant = await createPrivateTenant(db, {
      slug: "timer-" + randomUUID(),
      ownerDisplayName: "Timer fixture",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "timer", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Timer",
      "elastic",
    );
    let now = new Date("2026-10-26T00:00:00Z");
    const clock = () => now,
      service = new SessionScheduleService({ database: db, clock });
    const scope = { tenantId: tenant.tenantId, sessionId: session.sessionId };
    const create = (
      timing: import("@pi-cloud/protocol").ScheduleTiming = {
        kind: "once",
        at: "2026-10-26T00:00:10Z",
      },
      missed: "latest" | "skip" = "latest",
    ) =>
      service.create(scope, randomUUID(), {
        name: "Daily summary",
        prompt: "Summarize the project.",
        timing,
        missed,
      });
    const runs = () =>
      db.selectFrom("runs").selectAll().where("session_id", "=", scope.sessionId).execute();
    return {
      tenant,
      service,
      scope,
      store,
      create,
      runs,
      clock,
      setTime: (value: string) => {
        now = new Date(value);
      },
    };
  }
  it("resolves relative time once and keeps the same deadline on a creation retry", async () => {
    const f = await fixture(),
      id = randomUUID();
    const input = {
      name: "Later",
      prompt: "Report progress",
      timing: { kind: "after" as const, seconds: 15 },
    };
    const first = await f.service.create(f.scope, id, input);
    expect(first.timing).toEqual({ kind: "once", at: "2026-10-26T00:00:15.000Z" });
    f.setTime("2026-10-26T00:00:10Z");
    expect(await f.service.create(f.scope, id, input)).toEqual(first);
  });
  it("stops an unclaimed scheduled Run and releases the next queued occurrence", async () => {
    const f = await fixture();
    await f.create();
    await f.create();
    f.setTime("2026-10-26T00:00:10Z");
    await f.service.dispatchDue();
    const runs = (await f.runs()).sort(
      (a, b) => Number(a.mailbox_position) - Number(b.mailbox_position),
    );
    expect(runs[0]!.ready_at).not.toBeNull();
    expect(runs[1]!.ready_at).toBeNull();
    await f.store.acceptTurnCancellation(f.scope.sessionId, runs[0]!.turn_id, randomUUID(), {});
    const next = (await f.runs()).find((row) => row.id === runs[1]!.id)!;
    expect(next.ready_at).not.toBeNull();
  });
  it("persists a plan without starting work; two dispatchers admit one occurrence", async () => {
    const f = await fixture(),
      p = await f.create();
    expect(parseSessionSchedule(p).state).toBe("scheduled");
    expect(await f.runs()).toHaveLength(0);
    expect((await f.service.dispatchDue()).admitted).toBe(0);
    f.setTime("2026-10-26T00:00:10Z");
    const second = new SessionScheduleService({ database: db, clock: f.clock });
    await Promise.all([f.service.dispatchDue(), second.dispatchDue()]);
    expect(await f.runs()).toHaveLength(1);
    const r = (await f.runs())[0]!;
    expect(r.state).toBe("queued");
    expect(r.ready_at).not.toBeNull();
    expect(r.scheduled_origin).toMatchObject({
      scheduleId: p.id,
      scheduledAt: "2026-10-26T00:00:10.000Z",
    });
    expect(r.input_text).toBe("Summarize the project.");
    expect(r.agent_system_prompt).toContain("Scheduled task metadata");
    expect((await f.service.get(f.scope, p.id)).state).toBe("finished");
    await f.service.dispatchDue();
    expect(await f.runs()).toHaveLength(1);
  });
  it("deletion before firing wins; deletion after admission preserves the Run", async () => {
    const f = await fixture(),
      p = await f.create();
    await f.service.delete(f.scope, p.id, p.revision);
    f.setTime("2026-10-26T00:01:00Z");
    await f.service.dispatchDue();
    expect(await f.runs()).toHaveLength(0);
    const q = await f.create({ kind: "once", at: "2026-10-26T00:01:10Z" });
    f.setTime("2026-10-26T00:01:10Z");
    await f.service.dispatchDue();
    const removed = await f.service.delete(f.scope, q.id, q.revision);
    expect(removed.lastRunId).toBe((await f.runs())[0]!.id);
    expect(await f.runs()).toHaveLength(1);
    expect(await f.service.list(f.scope)).toEqual({ schedules: [], nextCursor: null });
  });
  it("skips overlap and catches up only the latest missed recurrence", async () => {
    const f = await fixture(),
      p = await f.create({ kind: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" });
    f.setTime("2026-10-29T01:00:00Z");
    await f.service.dispatchDue();
    expect(await f.runs()).toHaveLength(1);
    expect((await f.runs())[0]!.scheduled_origin).toMatchObject({
      scheduledAt: "2026-10-29T00:00:00.000Z",
    });
    f.setTime("2026-10-30T00:00:00Z");
    await f.service.dispatchDue();
    expect(await f.runs()).toHaveLength(1);
    const updated = await f.service.get(f.scope, p.id);
    expect(updated.lastSkippedAt).toBe("2026-10-30T00:00:00.000Z");
    expect(updated.nextFireAt).toBe("2026-10-31T00:00:00.000Z");
  });
  it("skip policy suppresses a stale occurrence; pause/resume ignores the paused interval", async () => {
    const f = await fixture(),
      p = await f.create({ kind: "once", at: "2026-10-26T00:00:10Z" }, "skip");
    f.setTime("2026-10-26T00:02:00Z");
    await f.service.dispatchDue();
    expect(await f.runs()).toHaveLength(0);
    expect((await f.service.get(f.scope, p.id)).lastSkippedAt).not.toBeNull();
    let q = await f.create({ kind: "cron", expression: "0 8 * * *", timezone: "Asia/Shanghai" });
    q = await f.service.change(f.scope, q.id, { action: "pause", revision: q.revision });
    f.setTime("2026-11-01T03:00:00Z");
    await f.service.dispatchDue();
    expect(await f.runs()).toHaveLength(0);
    q = await f.service.change(f.scope, q.id, { action: "resume", revision: q.revision });
    expect(q.nextFireAt).toBe("2026-11-02T00:00:00.000Z");
    await expect(
      f.service.change(f.scope, q.id, { action: "pause", revision: "1" }),
    ).rejects.toThrow("changed");
  });
  it("waits through normal Session readiness instead of steering its native inbox", async () => {
    const f = await fixture();
    await f.store.acceptTurn(f.scope.sessionId, randomUUID(), { prompt: "Existing work" });
    await db
      .updateTable("sessions")
      .set({ state: "running" })
      .where("id", "=", f.scope.sessionId)
      .execute();
    await f.create();
    f.setTime("2026-10-26T00:00:10Z");
    await f.service.dispatchDue();
    const r = (await f.runs()).find((r) => r.scheduled_origin !== null)!;
    expect(r.ready_at).toBeNull();
    expect(r.state).toBe("queued");
    expect((await f.runs()).length).toBe(2);
  });
  it("rolls back Run creation when plan advancement fails", async () => {
    const f = await fixture(),
      p = await f.create();
    await sql
      .raw(
        `create function fixture_fail_plan() returns trigger language plpgsql as $$ begin if new.id='${p.id}'::uuid and new.last_run_id is not null then raise exception 'fixture rollback'; end if; return new; end $$; create trigger fixture_plan before update on session_schedules for each row execute function fixture_fail_plan()`,
      )
      .execute(db);
    try {
      f.setTime("2026-10-26T00:00:10Z");
      await f.service.dispatchDue();
      expect(await f.runs()).toHaveLength(0);
    } finally {
      await sql`drop trigger fixture_plan on session_schedules; drop function fixture_fail_plan()`.execute(
        db,
      );
    }
    const row = await db
      .selectFrom("session_schedules")
      .selectAll()
      .where("id", "=", p.id)
      .executeTakeFirstOrThrow();
    expect(row.next_fire_at?.toISOString()).toBe("2026-10-26T00:00:10.000Z");
    expect(row.last_run_id).toBeNull();
    // A restart sees the retry eligibility in PG, not a lost in-memory job.
    f.setTime(new Date(row.available_at!.valueOf() + 1).toISOString());
    await new SessionScheduleService({ database: db, clock: f.clock }).dispatchDue();
    expect(await f.runs()).toHaveLength(1);
  });
  it("disables a pruned Session's due plan instead of spinning or admitting work", async () => {
    const f = await fixture(),
      p = await f.create();
    await db
      .updateTable("sessions")
      .set({ pruned_at: new Date() })
      .where("id", "=", f.scope.sessionId)
      .execute();
    f.setTime("2026-10-26T00:00:10Z");
    expect(await f.service.dispatchDue()).toMatchObject({ admitted: 0, advanced: 1 });
    expect(await f.runs()).toHaveLength(0);
    expect(
      await db
        .selectFrom("session_schedules")
        .select(["enabled", "error_code"])
        .where("id", "=", p.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ enabled: false, error_code: "not_found" });
    expect(await f.service.dispatchDue()).toEqual({ examined: 0, admitted: 0, advanced: 0 });
    expect((await f.service.list(f.scope)).schedules).toEqual([]);
  });
  it("offers non-replayable root management and the same direct HTTP service without an Agent", async () => {
    const f = await fixture(),
      registry = new ControlToolRegistry();
    registry.register(createScheduleTool(f.service));
    const command = {
      scope: { tenantId: f.scope.tenantId, sessionId: f.scope.sessionId },
      // A root Session can use a non-reserved native Conversation after a fork.
      // Root authority comes from its cloud Session, never a magic native id.
      conversationId: 17,
      operationId: randomUUID(),
      toolName: "schedule",
      nativeCallId: "create",
      arguments: {
        action: "create",
        name: "HTTP management",
        prompt: "Report status",
        timing: { kind: "after", seconds: 60 },
      },
    } as unknown as AcceptedControlToolCommand;
    expect(registry.replayable("schedule")).toBe(false);
    expect(
      (
        await registry.execute(
          { ...command, scope: { ...command.scope, sessionId: randomUUID() } },
          () => true,
        )
      ).isError,
    ).toBe(true);
    expect((await registry.execute(command, () => true)).isError).not.toBe(true);
    const plan = (await f.service.list(f.scope)).schedules[0]!;
    expect(await f.runs()).toHaveLength(0);
    const app = await createControlPlaneApplication({
      database: db,
      tenantId: f.tenant.tenantId,
      defaultModelProfileId: f.tenant.defaultModelProfileId,
      eventRuntime: emptyEventRuntime(),
      schedules: f.service,
    });
    try {
      const http = app.getHttpAdapter().getInstance();
      await http.ready();
      const url = `/v1/conversations/${f.scope.sessionId}/schedules/${plan.id}`;
      const changed = await http.inject({
        method: "PATCH",
        url,
        payload: {
          action: "update",
          revision: plan.revision,
          patch: { name: "Edited in the page" },
        },
      });
      expect(changed.statusCode).toBe(200);
      const result = parseSessionSchedule(changed.json());
      expect(result.name).toBe("Edited in the page");
      expect(
        (await http.inject({ method: "DELETE", url, payload: { revision: plan.revision } }))
          .statusCode,
      ).toBe(409);
      expect(
        (await http.inject({ method: "DELETE", url, payload: { revision: result.revision } }))
          .statusCode,
      ).toBe(200);
      expect((await http.inject({ method: "GET", url })).statusCode).toBe(404);
      // A retired dispatch is rejected, rather than recreating the deleted plan.
      expect((await registry.execute(command, () => false)).isError).toBe(true);
      expect((await f.service.list(f.scope)).schedules).toHaveLength(0);
      expect(await f.runs()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("does not expose large instructions in list responses or cross Session boundaries", async () => {
    const f = await fixture(),
      p = await f.create();
    const list = await f.service.list(f.scope);
    expect(parseSessionScheduleList(list).schedules[0]).not.toHaveProperty("prompt");
    await expect(f.service.get({ ...f.scope, sessionId: randomUUID() }, p.id)).rejects.toThrow(
      "not found",
    );
  });
});
