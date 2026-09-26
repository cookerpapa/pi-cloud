import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { migrationProvider } from "../../database/src/migrations/index.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ToolBrokerClient } from "@pi-cloud/tool-broker/client";
import { GitLabIssueNoteReconciler } from "../src/gitlab-issue-note-reconciler.ts";
import { SourceControlService, SourceControlServiceError } from "../src/source-control-service.ts";
import { SourceControlIssueCoordinator } from "../src/source-control-issue-coordinator.ts";
import { SourceControlCredentialVault } from "../src/source-control-credential-vault.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import type { TenantRequestIdentity } from "../src/tenant-identity.ts";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
let pg: PGlite, socket: PGLiteSocketServer, db: Kysely<Database>;
const external = process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL;
let administrator: Pool | undefined, databaseName: string | undefined;
let origin: string,
  signingToken = "",
  nextIssue = 100,
  nextNote = 700;
const publicOrigins = new Map<string, string>();
const notes = new Map<string, { id: number; body: string; issue: string }>();
const requests: Array<{ method: string; issue: string; body?: string }> = [];
type Write = { method: string; issue: string; body: string };
let beforeWrite: ((write: Write) => Promise<void>) | undefined;
let rejectIssue: string | undefined,
  loseReply = false;
let failSecondPage: string | undefined;
const reconcilers: GitLabIssueNoteReconciler[] = [];
const held: Array<() => void> = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  held.push(resolve);
  return { promise, resolve };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, "http://fixture.invalid");
    const method = request.method!;
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    const send = (value: unknown, status = 200) => {
      if (!response.destroyed) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      }
    };
    if (
      url.pathname === "/api/v4/projects/group%2Frepo" ||
      url.pathname === "/api/v4/projects/501"
    ) {
      const publicOrigin = publicOrigins.get(String(request.headers["private-token"]));
      send({
        id: 501,
        path: "repo",
        path_with_namespace: "group/repo",
        visibility: "private",
        default_branch: "main",
        http_url_to_repo: `${publicOrigin}/group/repo.git`,
        web_url: `${publicOrigin}/group/repo`,
        namespace: { id: 41, kind: "group" },
      });
    } else if (url.pathname === "/api/v4/projects/501/hooks") {
      if (method === "POST") {
        signingToken = body.signing_token;
        send({ id: 91 }, 201);
      } else send([]);
    } else {
      const match = /^\/api\/v4\/projects\/501\/issues\/(\d+)\/notes(?:\/(\d+))?$/.exec(
        url.pathname,
      );
      if (!match) {
        send({}, 404);
        return;
      }
      const issue = match[1]!,
        noteId = match[2];
      requests.push({ method, issue, ...(body.body ? { body: body.body } : {}) });
      if (rejectIssue === issue) {
        send({}, 403);
        return;
      }
      if (method === "GET") {
        if (failSecondPage === issue && url.searchParams.get("page") === "2") {
          send({}, 503);
          return;
        }
        if (noteId) {
          const note = notes.get(noteId);
          send(note ?? {}, note?.issue === issue ? 200 : 404);
        } else send([...notes.values()].filter((note) => note.issue === issue).reverse());
      } else {
        await beforeWrite?.({ method, issue, body: body.body });
        const id = method === "POST" ? String(++nextNote) : noteId!;
        if (method === "PUT" && !notes.has(id)) {
          send({}, 404);
          return;
        }
        notes.set(id, { id: Number(id), body: body.body, issue });
        if (loseReply) {
          loseReply = false;
          response.destroy();
        } else send({ id: Number(id) }, method === "POST" ? 201 : 200);
      }
    }
  } catch {
    response.destroy();
  }
});

beforeAll(async () => {
  if (external) {
    administrator = new Pool({ connectionString: external, max: 1 });
    databaseName = `pi_gitlab_notes_${randomUUID().replaceAll("-", "")}`;
    await administrator.query(`create database "${databaseName}"`);
    const endpoint = new URL(external);
    endpoint.pathname = `/${databaseName}`;
    db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 6 });
  } else {
    pg = await PGlite.create();
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0, maxConnections: 6 });
    await socket.start();
    db = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 6,
    });
  }
  await runMigrations(db, "up");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not listen");
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  // This is a disposable test database, never the deployment database.
  await sql`truncate source_control_issue_jobs cascade`.execute(db);
  requests.length = 0;
  notes.clear();
  beforeWrite = undefined;
  rejectIssue = undefined;
  loseReply = false;
  failSecondPage = undefined;
});
afterEach(async () => {
  for (const release of held.splice(0)) release();
  await Promise.all(reconcilers.splice(0).map((reconciler) => reconciler.close()));
  vi.restoreAllMocks();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.destroy();
  await socket?.stop();
  await pg?.close();
  if (administrator && databaseName) {
    await administrator.query(`drop database "${databaseName}"`);
    await administrator.end();
  }
});

async function fixture(database: Kysely<Database> = db) {
  return createFixture(database);
}

async function createFixture(db: Kysely<Database>) {
  const tenant = await createPrivateTenant(db, {
    slug: `note-${randomUUID()}`,
    ownerDisplayName: "Fixture owner",
  });
  const publicBaseUrl = `https://${tenant.tenantSlug}.gitlab.example.invalid`;
  const accessToken = `fixture-secret-${randomUUID()}`;
  publicOrigins.set(accessToken, publicBaseUrl);
  const identity: TenantRequestIdentity = {
    credentialId: tenant.credential.credentialId,
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    userId: tenant.ownerUserId,
    displayName: "Fixture owner",
    username: "fixture-owner",
    role: "owner",
    defaultModelProfileId: tenant.defaultModelProfileId,
  };
  const service = new SourceControlService({
    database: db,
    workspaceServiceToken: "fixture-private-service-token-000000",
    allowInsecureInternalHttp: true,
    gitlab: {
      vault: new SourceControlCredentialVault(Buffer.alloc(32, 7).toString("base64url")),
      webhookUrl: "https://picloud.example.invalid/webhook",
      publicOrigin: "https://picloud.example.invalid",
      issueLabel: "picloud",
      internalBaseUrl: origin,
    },
  });
  await service.connectGitLabProject(identity, {
    baseUrl: publicBaseUrl,
    project: "group/repo",
    accessToken,
  });
  const issue = String(++nextIssue);
  const delivery = randomUUID(),
    timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = Buffer.from(
    JSON.stringify({
      object_kind: "issue",
      project: { id: 501 },
      user: { username: "fixture-owner" },
      object_attributes: {
        action: "open",
        iid: Number(issue),
        title: "Fixture Issue",
        description: "Fixture",
        url: `${publicBaseUrl}/group/repo/-/issues/${issue}`,
      },
      labels: [{ title: "picloud" }],
    }),
  );
  const signature = `v1,${createHmac("sha256", Buffer.from(signingToken.slice(6), "base64"))
    .update(Buffer.concat([Buffer.from(`${delivery}.${timestamp}.`), rawBody]))
    .digest("base64")}`;
  await service.acceptGitLabWebhook({
    deliveryId: delivery,
    eventName: "Issue Hook",
    instance: publicBaseUrl,
    timestamp,
    signature,
    rawBody,
  });
  const job = await db
    .selectFrom("source_control_issue_jobs")
    .selectAll()
    .where("tenant_id", "=", tenant.tenantId)
    .executeTakeFirstOrThrow();
  const makeReconciler = () => {
    const reconciler = new GitLabIssueNoteReconciler({
      database: db,
      access: (tenantId, installationId) => service.gitlabIssueNoteAccess(tenantId, installationId),
    });
    reconcilers.push(reconciler);
    return reconciler;
  };
  const state = () =>
    db
      .selectFrom("gitlab_issue_note_sync")
      .selectAll()
      .where("issue_job_id", "=", job.id)
      .executeTakeFirstOrThrow();
  const due = () =>
    db
      .updateTable("gitlab_issue_note_sync")
      .set({ available_at: sql<Date>`clock_timestamp()` })
      .where("issue_job_id", "=", job.id)
      .execute();
  const expire = () =>
    db
      .updateTable("gitlab_issue_note_sync")
      .set({ lease_expires_at: sql<Date>`clock_timestamp() - interval '1 second'` })
      .where("issue_job_id", "=", job.id)
      .execute();
  const remote = async () => notes.get((await state()).note_id!)!;
  return { tenant, identity, service, job, issue, makeReconciler, state, due, expire, remote };
}

it("versions real claim/state changes atomically; no-op claims and heartbeats do not invalidate", async () => {
  const f = await fixture();
  expect((await f.state()).desired_version).toBe("1");
  await f.service.claimIssueJob(f.identity, f.job.id);
  expect((await f.state()).desired_version).toBe("2");
  await f.service.claimIssueJob(f.identity, f.job.id);
  await db
    .updateTable("source_control_issue_jobs")
    .set({ updated_at: new Date(), state: "awaiting_claim" })
    .where("id", "=", f.job.id)
    .execute();
  expect((await f.state()).desired_version).toBe("2");
  await expect(
    db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom("source_control_issue_claims")
        .where("issue_job_id", "=", f.job.id)
        .execute();
      expect(
        (
          await tx
            .selectFrom("gitlab_issue_note_sync")
            .select("desired_version")
            .where("issue_job_id", "=", f.job.id)
            .executeTakeFirstOrThrow()
        ).desired_version,
      ).toBe("3");
      throw new Error("fixture rollback");
    }),
  ).rejects.toThrow("fixture rollback");
  expect((await f.state()).desired_version).toBe("2");
  await f.service.unclaimIssueJob(f.identity, f.job.id);
  for (const state of ["received", "queued", "running", "completed", "failed"] as const)
    await db
      .updateTable("source_control_issue_jobs")
      .set({
        state,
        settled_at: ["completed", "failed"].includes(state) ? new Date() : null,
        failure_code: state === "failed" ? "fixture_failure" : null,
      })
      .where("id", "=", f.job.id)
      .execute();
  expect((await f.state()).desired_version).toBe("8");
});

it("migrates existing GitLab jobs into verification targets and removes the old pending flag", async () => {
  const oldPg = await PGlite.create();
  const oldSocket = new PGLiteSocketServer({ db: oldPg, host: "127.0.0.1", port: 0 });
  await oldSocket.start();
  const oldDb = createDatabase({
    connectionString: `postgresql://postgres@${oldSocket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  try {
    const migrator = new Migrator({
      db: oldDb,
      provider: migrationProvider,
      allowUnorderedMigrations: true,
    });
    const result = await migrator.migrateTo("148_retire_tool_operation_ledger");
    if (result.error) throw result.error;
    const first = await fixture(oldDb),
      second = await fixture(oldDb);
    await sql`update source_control_issue_jobs set claim_sync_pending=true where id=${first.job.id}::uuid`.execute(
      oldDb,
    );
    await runMigrations(oldDb, "up");
    const rows = await oldDb.selectFrom("gitlab_issue_note_sync").selectAll().execute();
    expect(new Set(rows.map((row) => row.issue_job_id))).toEqual(
      new Set([first.job.id, second.job.id]),
    );
    expect(
      rows.every(
        (row) => row.desired_version === "1" && row.synced_version === "0" && row.note_id === null,
      ),
    ).toBe(true);
    expect(
      (
        await sql`select 1 from information_schema.columns where table_name='source_control_issue_jobs' and column_name='claim_sync_pending'`.execute(
          oldDb,
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await oldDb.destroy();
    await oldSocket.stop();
    await oldPg.close();
  }
});

it("HTTP releases the transaction: another replica skips its lease while claim and Run admission finish", async () => {
  const f = await fixture(),
    a = f.makeReconciler(),
    b = f.makeReconciler();
  const entered = deferred(),
    release = deferred();
  beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  const syncing = a.reconcileOnce();
  await entered.promise;
  expect(await b.reconcileOnce()).toBe(false);
  await f.service.claimIssueJob(f.identity, f.job.id);
  const store = new ControlPlaneStore({
    database: db,
    tenantId: f.tenant.tenantId,
    defaultModelProfileId: f.tenant.defaultModelProfileId,
  });
  const project = await store.createProject({ name: "Fixture", source: { kind: "empty" } });
  vi.spyOn(ToolBrokerClient.prototype, "preflightSourceCredential").mockImplementation(
    async (request) => ({
      sourceControlProtocolVersion: 1,
      type: "source_control.workspace_credential_result",
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      origin: request.origin,
      authorized: true,
    }),
  );
  await f.service.startIssueJob(f.identity, f.job.id, {
    executionMode: "elastic",
    sessionTitle: "Fixture Run",
    sandboxProfileKey: "starter",
    workspaceId: project.workspaceId,
  });
  const coordinator = new SourceControlIssueCoordinator({
    database: db,
    sourceControl: f.service,
    instanceId: "note-fixture",
    environmentImageRevision: "0".repeat(40),
  });
  expect(await coordinator.reconcileOnce()).toBe(true);
  const job = await db
    .selectFrom("source_control_issue_jobs")
    .select(["state", "run_id"])
    .where("id", "=", f.job.id)
    .executeTakeFirstOrThrow();
  expect(job.state).toBe("queued");
  expect(job.run_id).not.toBeNull();
  release.resolve();
  expect(await syncing).toBe(true);
  expect((await f.state()).synced_version).toBe("1");
  expect(BigInt((await f.state()).desired_version)).toBeGreaterThan(1n);
  beforeWrite = undefined;
  expect(await b.reconcileOnce()).toBe(true);
  expect((await f.remote()).body).toContain("状态：queued");
});

it("one slow job does not prevent another tenant's note from being synchronized", async () => {
  const first = await fixture(),
    other = await fixture();
  const entered = deferred(),
    release = deferred();
  beforeWrite = async (write) => {
    if (write.issue === first.issue) {
      entered.resolve();
      await release.promise;
    }
  };
  const reconciler = first.makeReconciler(),
    active = reconciler.reconcileOnce();
  await entered.promise;
  expect(await reconciler.reconcileOnce()).toBe(true);
  expect((await other.state()).synced_version).toBe("1");
  expect((await first.state()).synced_version).toBe("0");
  release.resolve();
  await active;
});

// This exercises simultaneous claimant transactions and an independent owner
// loop. PGlite's multiplexed socket sessions are not PostgreSQL concurrency
// evidence; the real-PG fault gate requires and executes this case.
it.skipIf(!external)(
  "bounds background HTTP concurrency while the independent Issue loop keeps ticking",
  async () => {
    const first = await fixture();
    await fixture();
    await fixture();
    const release = deferred();
    let started = 0;
    beforeWrite = async () => {
      started++;
      await release.promise;
    };
    const coordinator = new SourceControlIssueCoordinator({
      database: db,
      sourceControl: first.service,
      instanceId: "independent-issue-loop",
      environmentImageRevision: "0".repeat(40),
    });
    const observe = vi.spyOn(coordinator, "reconcileOnce");
    try {
      first.makeReconciler().start();
      coordinator.start();
      await vi.waitFor(() => expect(started).toBe(2), { timeout: 5000 });
      await vi.waitFor(() => expect(observe.mock.calls.length).toBeGreaterThanOrEqual(2), {
        timeout: 4000,
      });
      expect(started).toBe(2);
      const leased = await db
        .selectFrom("gitlab_issue_note_sync")
        .select("issue_job_id")
        .where("claim_token", "is not", null)
        .execute();
      expect(leased).toHaveLength(2);
    } finally {
      release.resolve();
      await coordinator.close();
    }
  },
);

it.each(["create", "update"])(
  "reads back an applied %s whose response was lost",
  async (operation) => {
    const f = await fixture(),
      reconciler = f.makeReconciler();
    if (operation === "update") await reconciler.reconcileOnce();
    await f.service.claimIssueJob(f.identity, f.job.id);
    loseReply = true;
    await expect(reconciler.reconcileOnce()).rejects.toMatchObject({ retryable: true });
    const failed = await f.state();
    expect(BigInt(failed.desired_version)).toBeGreaterThan(BigInt(failed.synced_version));
    expect(failed.claim_token).toBeNull();
    expect(failed.failure_code).toBe("gitlab_unavailable");
    const writeCount = requests.filter((r) => r.method !== "GET").length;
    await f.due();
    await reconciler.reconcileOnce();
    expect(notes.size).toBe(1);
    expect(requests.filter((r) => r.method !== "GET")).toHaveLength(writeCount);
    expect((await f.state()).synced_version).toBe((await f.state()).desired_version);
  },
);

it("takes over an abandoned claim and fences its late acknowledgement", async () => {
  const f = await fixture(),
    a = f.makeReconciler(),
    b = f.makeReconciler();
  const abandoned = await a.claimNext();
  expect(abandoned).toBeDefined();
  expect(await b.reconcileOnce()).toBe(false);
  await f.expire();
  await b.reconcileOnce();
  const current = await f.state();
  expect(current.synced_version).toBe("1");
  expect(current.claim_token).toBeNull();
  expect(notes.size).toBe(1);
});

it("periodic verification repairs a late stale remote write even when PG versions were equal", async () => {
  const f = await fixture(),
    a = f.makeReconciler(),
    b = f.makeReconciler();
  await a.reconcileOnce();
  await f.service.claimIssueJob(f.identity, f.job.id);
  const entered = deferred(),
    release = deferred();
  let blocked = false;
  beforeWrite = async () => {
    if (!blocked) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
  };
  const stale = a.reconcileOnce().catch((error: unknown) => error);
  await entered.promise;
  await f.service.unclaimIssueJob(f.identity, f.job.id);
  await f.expire();
  await b.reconcileOnce();
  expect((await f.state()).synced_version).toBe("3");
  release.resolve();
  expect(await stale).toMatchObject({ code: "gitlab_sync_lease_lost" });
  expect((await f.remote()).body).toContain("picloud-claims-version:2");
  expect((await f.state()).synced_version).toBe((await f.state()).desired_version);
  await f.due();
  await b.reconcileOnce();
  expect((await f.remote()).body).toContain("picloud-claims-version:3");
  expect((await f.remote()).body).not.toContain("fixture-owner");
});

it("periodic checks avoid redundant writes and rediscover a deleted managed comment", async () => {
  const f = await fixture(),
    reconciler = f.makeReconciler();
  await reconciler.reconcileOnce();
  const original = (await f.state()).note_id;
  await f.due();
  await reconciler.reconcileOnce();
  expect(requests.filter((r) => r.method !== "GET")).toHaveLength(1);
  notes.delete(original!);
  await f.due();
  await reconciler.reconcileOnce();
  expect((await f.state()).note_id).not.toBe(original);
  expect(notes.size).toBe(1);
});

it("keeps persistent errors unsynced with per-job backoff and never changes Issue execution state", async () => {
  const f = await fixture(),
    other = await fixture(),
    reconciler = f.makeReconciler();
  rejectIssue = f.issue;
  await expect(reconciler.reconcileOnce()).rejects.toMatchObject({ retryable: false });
  const failed = await f.state();
  expect(failed).toMatchObject({
    synced_version: "0",
    failure_code: "gitlab_authorization_failed",
    claim_token: null,
  });
  expect(failed.available_at.valueOf()).toBeGreaterThan(Date.now() + 10 * 60_000);
  expect(await reconciler.reconcileOnce()).toBe(true);
  expect((await other.state()).synced_version).toBe("1");
  const job = await db
    .selectFrom("source_control_issue_jobs")
    .select("state")
    .where("id", "=", f.job.id)
    .executeTakeFirstOrThrow();
  expect(job.state).toBe("awaiting_claim");
  rejectIssue = undefined;
  await f.due();
  await reconciler.reconcileOnce();
  expect((await f.state()).failure_code).toBeNull();
});

it("does not create a comment when its marker lookup is incomplete", async () => {
  const f = await fixture();
  for (let id = 1; id <= 100; id++)
    notes.set(String(id), { id, body: "Unrelated note", issue: f.issue });
  failSecondPage = f.issue;
  await expect(f.makeReconciler().reconcileOnce()).rejects.toMatchObject({ retryable: true });
  expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  expect((await f.state()).synced_version).toBe("0");
});

it("a failed older version cannot postpone a newer committed change", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  const failing = new GitLabIssueNoteReconciler({
    database: db,
    access: async () => {
      entered.resolve();
      await release.promise;
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "Fixture unavailable",
        false,
      );
    },
  });
  reconcilers.push(failing);
  const pending = failing.reconcileOnce().catch((error: unknown) => error);
  await entered.promise;
  await f.service.claimIssueJob(f.identity, f.job.id);
  release.resolve();
  expect(await pending).toMatchObject({ retryable: false });
  expect((await f.state()).synced_version).toBe("0");
  expect(await f.makeReconciler().reconcileOnce()).toBe(true);
  expect((await f.remote()).body).toContain("picloud-claims-version:2");
});

it("carries the overall attempt deadline through both lookup and write", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  const deadline = new AbortController(),
    timeout = AbortSignal.timeout.bind(AbortSignal);
  const budgets: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    budgets.push(milliseconds);
    return budgets.length === 1 ? deadline.signal : timeout(milliseconds);
  });
  beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  const active = f
    .makeReconciler()
    .reconcileOnce()
    .catch((error: unknown) => error);
  await entered.promise;
  expect(budgets[0]).toBeGreaterThan(0);
  expect(budgets[0]).toBeLessThanOrEqual(30_000);
  deadline.abort(new Error("Fixture attempt deadline"));
  expect(await active).toMatchObject({ retryable: true });
  expect((await f.state()).synced_version).toBe("0");
  release.resolve();
});

it("rejects a mismatched note identity and a cross-tenant credential lookup", async () => {
  const f = await fixture(),
    reconciler = f.makeReconciler();
  await reconciler.reconcileOnce();
  (await f.remote()).body = "A human-owned comment without the managed marker";
  await f.due();
  await expect(reconciler.reconcileOnce()).rejects.toMatchObject({
    code: "gitlab_note_identity_mismatch",
  });
  expect((await f.remote()).body).toBe("A human-owned comment without the managed marker");
  const other = await fixture();
  const repository = await db
    .selectFrom("source_control_repositories")
    .select("installation_id")
    .where("id", "=", f.job.repository_id)
    .executeTakeFirstOrThrow();
  await expect(
    f.service.gitlabIssueNoteAccess(other.tenant.tenantId, repository.installation_id),
  ).rejects.toMatchObject({ code: "source_control_authorization_denied" });
});

it("shutdown aborts a pending HTTP request and preserves work for a successor", async () => {
  const f = await fixture(),
    reconciler = f.makeReconciler();
  const entered = deferred(),
    release = deferred();
  beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  const active = reconciler.reconcileOnce().catch((error: unknown) => error);
  await entered.promise;
  await reconciler.close();
  expect(await active).toMatchObject({ retryable: true });
  expect((await f.state()).synced_version).toBe("0");
  expect((await f.state()).claim_token).toBeNull();
  expect(await reconciler.reconcileOnce()).toBe(false);
  release.resolve();
});

it.skipIf(!external)("checks expiry after waiting for the acknowledgement row lock", async () => {
  const f = await fixture(),
    reconciler = f.makeReconciler();
  const entered = deferred(),
    remoteReply = deferred(),
    locked = deferred(),
    unlock = deferred();
  beforeWrite = async () => {
    entered.resolve();
    await remoteReply.promise;
  };
  const syncing = reconciler.reconcileOnce().catch((error: unknown) => error);
  await entered.promise;
  const blocker = db.transaction().execute(async (tx) => {
    await tx
      .updateTable("gitlab_issue_note_sync")
      .set({ lease_expires_at: sql<Date>`clock_timestamp() + interval '400 milliseconds'` })
      .where("issue_job_id", "=", f.job.id)
      .execute();
    locked.resolve();
    await unlock.promise;
  });
  await locked.promise;
  remoteReply.resolve();
  // Observe the real PG waiter before releasing a row whose lease has expired.
  await vi.waitFor(
    async () => {
      const waiting = await sql<{
        count: string;
      }>`select count(*)::text as count from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock'
        and query like '%gitlab_issue_note_sync%'`.execute(db);
      expect(Number(waiting.rows[0]!.count)).toBeGreaterThan(0);
    },
    { timeout: 3000, interval: 20 },
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  unlock.resolve();
  await blocker;
  expect(await syncing).toMatchObject({ code: "gitlab_sync_lease_lost" });
  expect((await f.state()).synced_version).toBe("0");
  await f.makeReconciler().reconcileOnce();
  expect((await f.state()).synced_version).toBe("1");
  expect(notes.size).toBe(1);
});
