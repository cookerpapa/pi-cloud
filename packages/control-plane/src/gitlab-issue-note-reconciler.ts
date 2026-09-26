import type { Database } from "@pi-cloud/database";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { GitLabProjectClientError, type GitLabProjectClient } from "./gitlab-project-client.ts";
import { SourceControlServiceError } from "./source-control-service.ts";

const POLL_MS = 2_000;
const CONCURRENCY = 2;
const LEASE_MS = 60_000;
const REQUEST_MS = 30_000;
const VERIFY_MS = 5 * 60_000;
const PERSISTENT_FAILURE_MS = 15 * 60_000;

type NoteClient = Pick<
  GitLabProjectClient,
  "getIssueNote" | "findIssueNote" | "createIssueNote" | "updateIssueNote"
>;
type Claim = NonNullable<Awaited<ReturnType<GitLabIssueNoteReconciler["claimNext"]>>>;
type Failure = Readonly<{ code: string; retryable: boolean }>;

function failure(error: unknown): Failure {
  if (
    (error instanceof GitLabProjectClientError || error instanceof SourceControlServiceError) &&
    /^[a-z_]{1,64}$/.test(error.code)
  )
    return { code: error.code, retryable: error.retryable };
  return { code: "gitlab_sync_failed", retryable: true };
}

function lostClaim(): GitLabProjectClientError {
  return new GitLabProjectClientError(
    "gitlab_sync_lease_lost",
    "Issue-note synchronization ownership expired",
    true,
  );
}

/** One current managed comment per job; PostgreSQL business rows own its content. */
export class GitLabIssueNoteReconciler {
  readonly #database: Kysely<Database>;
  readonly #access: (
    tenantId: string,
    installationId: string,
  ) => Promise<{ client: NoteClient; resourceUrl: string }>;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #shutdown = new AbortController();
  readonly #inFlight = new Set<Promise<boolean>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    database: Kysely<Database>;
    access: (
      tenantId: string,
      installationId: string,
    ) => Promise<{ client: NoteClient; resourceUrl: string }>;
    onError?: (error: unknown) => void;
  }) {
    this.#database = options.database;
    this.#access = options.access;
    this.#onError = options.onError;
  }

  start(): void {
    if (this.#timer || this.#shutdown.signal.aborted) return;
    this.#timer = setInterval(() => this.#tick(), POLL_MS);
    this.#timer.unref();
    this.#tick();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#shutdown.abort();
    await Promise.allSettled(this.#inFlight);
  }

  #tick(): void {
    for (let i = 0; i < CONCURRENCY && this.#inFlight.size < CONCURRENCY; i++)
      void this.reconcileOnce().catch((error: unknown) => this.#onError?.(error));
  }

  async reconcileOnce(): Promise<boolean> {
    if (this.#shutdown.signal.aborted || this.#inFlight.size >= CONCURRENCY) return false;
    const task = this.#reconcile();
    this.#inFlight.add(task);
    try {
      return await task;
    } finally {
      this.#inFlight.delete(task);
    }
  }

  async claimNext() {
    const startedAt = performance.now();
    return this.#database.transaction().execute(async (transaction) => {
      const candidate = await transaction
        .selectFrom("gitlab_issue_note_sync")
        .select(["issue_job_id", "tenant_id"])
        .where("available_at", "<=", sql<Date>`clock_timestamp()`)
        .where((eb) =>
          eb.or([
            eb("lease_expires_at", "is", null),
            eb("lease_expires_at", "<=", sql<Date>`clock_timestamp()`),
          ]),
        )
        .orderBy("available_at")
        .orderBy("issue_job_id")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!candidate) return;
      // Decision time is sampled after locking. The token fences this claim's
      // acknowledgements; it cannot revoke HTTP already accepted by GitLab.
      const sync = await transaction
        .updateTable("gitlab_issue_note_sync")
        .set({
          claim_token: randomUUID(),
          lease_expires_at: sql<Date>`clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'`,
        })
        .where("issue_job_id", "=", candidate.issue_job_id)
        .where("tenant_id", "=", candidate.tenant_id)
        .returning([
          "issue_job_id",
          "tenant_id",
          "desired_version",
          "note_id",
          "claim_token",
          sql<number>`(extract(epoch from (lease_expires_at - clock_timestamp())) * 1000)::integer`.as(
            "remaining_ms",
          ),
        ])
        .executeTakeFirstOrThrow();
      // All displayed mutations invalidate the locked sync row in their own
      // transaction. Plain committed reads stay consistent with this version;
      // taking a business-row lock here would invert that lock order.
      const job = await transaction
        .selectFrom("source_control_issue_jobs as job")
        .innerJoin("source_control_repositories as repository", (join) =>
          join
            .onRef("repository.tenant_id", "=", "job.tenant_id")
            .onRef("repository.id", "=", "job.repository_id"),
        )
        .select([
          "job.state",
          "job.issue_number",
          "repository.installation_id",
          "repository.provider_repository_id",
        ])
        .where("job.id", "=", sync.issue_job_id)
        .where("job.tenant_id", "=", sync.tenant_id)
        .where("job.provider", "=", "gitlab")
        .executeTakeFirstOrThrow();
      const claims = await transaction
        .selectFrom("source_control_issue_claims")
        .select(["username", "display_name", "claimed_at"])
        .where("tenant_id", "=", sync.tenant_id)
        .where("issue_job_id", "=", sync.issue_job_id)
        .orderBy("claimed_at")
        .orderBy("user_id")
        .execute();
      return { ...sync, ...job, claims, startedAt };
    });
  }

  async #assertCurrent(claim: Claim, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const current = await this.#database
      .selectFrom("gitlab_issue_note_sync")
      .select("issue_job_id")
      .where("tenant_id", "=", claim.tenant_id)
      .where("issue_job_id", "=", claim.issue_job_id)
      .where("claim_token", "=", claim.claim_token)
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    signal.throwIfAborted();
    if (!current) throw lostClaim();
  }

  async #reconcile(): Promise<boolean> {
    const claim = await this.claimNext();
    if (!claim) return false;
    let noteId = claim.note_id;
    try {
      const remaining = Math.floor(
        Math.min(REQUEST_MS, claim.remaining_ms - (performance.now() - claim.startedAt) - 1_000),
      );
      if (remaining <= 0) throw lostClaim();
      const signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(remaining)]);
      signal.throwIfAborted();
      const { client, resourceUrl } = await this.#access(claim.tenant_id, claim.installation_id);
      await this.#assertCurrent(claim, signal);
      const target = {
        projectId: claim.provider_repository_id,
        issueNumber: claim.issue_number,
        signal,
      };
      const marker = `<!-- picloud-claims:${claim.issue_job_id} -->`;
      let note = noteId === null ? undefined : await client.getIssueNote({ ...target, noteId });
      if (!note) {
        noteId = null;
        note = await client.findIssueNote({ ...target, marker });
      }
      if (note && !note.body.startsWith(marker))
        throw new GitLabProjectClientError(
          "gitlab_note_identity_mismatch",
          "Managed Issue note marker changed",
          false,
        );
      if (note) noteId = note.id;
      const body = [
        marker,
        `<!-- picloud-claims-version:${claim.desired_version} -->`,
        "### PiCloud 处理意向",
        "",
        ...(claim.claims.length === 0
          ? ["当前没有员工认领。"]
          : claim.claims.map(
              (person) =>
                `- PiCloud \`${person.username}\` · ${person.display_name} · ${new Date(person.claimed_at).toISOString()}`,
            )),
        "",
        claim.state === "awaiting_claim" ? "状态：等待开始" : `状态：${claim.state}`,
        `[在 PiCloud 中查看](${resourceUrl})`,
      ].join("\n");
      if (note?.body !== body) {
        await this.#assertCurrent(claim, signal);
        if (!note) noteId = (await client.createIssueNote({ ...target, body })).id;
        else await client.updateIssueNote({ ...target, noteId: note.id, body });
      }
      signal.throwIfAborted();
      if (!(await this.#settle(claim, noteId))) throw lostClaim();
    } catch (error) {
      await this.#settle(claim, noteId, failure(error));
      throw error;
    }
    return true;
  }

  async #settle(claim: Claim, noteId: string | null, error?: Failure): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("gitlab_issue_note_sync")
        .select(["desired_version", "synced_version", "failure_count"])
        .where("tenant_id", "=", claim.tenant_id)
        .where("issue_job_id", "=", claim.issue_job_id)
        .where("claim_token", "=", claim.claim_token)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return false;
      const newer = BigInt(current.desired_version) > BigInt(claim.desired_version);
      const failures = error && !newer ? Math.min(30, current.failure_count + 1) : 0;
      const delay = newer
        ? 0
        : !error
          ? VERIFY_MS
          : error.retryable
            ? Math.min(60_000, POLL_MS * 2 ** Math.min(failures - 1, 6))
            : PERSISTENT_FAILURE_MS;
      const result = await transaction
        .updateTable("gitlab_issue_note_sync")
        .set({
          note_id: noteId,
          synced_version: error ? current.synced_version : claim.desired_version,
          claim_token: null,
          lease_expires_at: null,
          available_at: sql<Date>`clock_timestamp() + ${delay} * interval '1 millisecond'`,
          ...(!error ? { checked_at: sql<Date>`clock_timestamp()` } : {}),
          failure_count: failures,
          failure_code: error?.code ?? null,
        })
        .where("tenant_id", "=", claim.tenant_id)
        .where("issue_job_id", "=", claim.issue_job_id)
        .where("claim_token", "=", claim.claim_token)
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .executeTakeFirstOrThrow();
      return result.numUpdatedRows === 1n;
    });
  }
}
