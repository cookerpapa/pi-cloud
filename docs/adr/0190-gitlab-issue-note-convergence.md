# ADR-0190: independent GitLab Issue-note convergence

Status: accepted, implemented and locally validated, 2026-09-26.
Evidence: [GitLab note-sync acceptance](../reports/gitlab-note-sync-20260926.md).

## Context and authorization

The owner approved replacing the low-volume, lock-held GitLab claim-note sync
after discussing its concurrency and remote-write limits. September 15's SC-03
repair deliberately kept pending state and the job lock until the remote write
finished: clearing pending before HTTP had lost work. Preserve that failure
guarantee while removing HTTP from business transactions and the Issue execution
coordinator's serial tick. This completes PI-12 from the September 26 review.

## Build versus adopt

Reviewed maintained PostgreSQL queues before implementation:

- [pg-boss](https://github.com/timgit/pg-boss), MIT; inspected its
  [package](https://github.com/timgit/pg-boss/blob/master/package.json),
  [releases](https://github.com/timgit/pg-boss/releases) and
  [SQL source](https://github.com/timgit/pg-boss/blob/master/src/plans.ts).
  It supports transactional enqueue, SKIP LOCKED claims, expiration and retries.
  Its worker ownership cannot fence a GitLab request.
- [Graphile Worker](https://github.com/graphile/worker), MIT, release
  [0.18.0](https://github.com/graphile/worker/releases/tag/v0.18.0); inspected its
  [job-key behavior](https://worker.graphile.org/docs/job-key). Replacing a running
  keyed job schedules another job; unsafe deduplication can discard a new wake.
  It also cannot provide conditional GitLab note writes.

Both fit general task queues. This concern retains one current synchronization
target per Issue, including synced rows for periodic remote verification.
Either library would still require version/note/check state and coordination with
its separate job lifecycle. Retain a bounded domain reconciler on PostgreSQL:
one table, short claims/conditional acknowledgements, fixed local concurrency,
per-resource backoff. It is not a general queue or another Agent scheduler.
No dependency/service/broker is added; the native terminal Outbox stays native.

## Decision

PostgreSQL Issue/claim rows remain authoritative. The managed GitLab comment is
an eventually consistent view. `gitlab_issue_note_sync` owns only desired/synced
versions, remote note identity, claim token/expiry and bounded retry/check
metadata. It stores no comment body, credential or model payload.

Database triggers invalidate that row in the same transaction as real claim
changes and displayed Issue-state changes. Unchanged writes and heartbeats do
not invalidate. This covers all existing Issue writers, including completion and
failure, without scattered best-effort enqueue calls.

A separate Control Plane reconciler claims only the sync row with SKIP LOCKED,
assigns a fresh token and uses primary database decision-time expiry. The short
transaction reads committed current job/claims; its sync-row lock serializes their
invalidation but never spans HTTP. Credential loading and HTTP occur after
commit. Two local in-flight claims bound resource use. The overall request
deadline is shorter than its lease; shutdown aborts requests. An expired owner
cannot confirm, fail or release a successor's work. Tokens fence PG, not GitLab.

Success confirms only the captured version. Newer desired versions remain
eligible, so changes coalesce without being cleared by an older response.
Abandoned attempts remain discoverable. Failures back off per job; persistent
errors retry slowly and retain a safe code. Note failures cannot fail Issue Runs.

Store successful/discovered note IDs, retain the stable resource marker and add
the captured version to rendered comments. Read before writing; unchanged content
needs no PUT. A missing ID requires bounded paginated marker lookup before create.
The resource marker must be a prefix; a known note whose marker was removed is
reported as an identity mismatch rather than overwriting a human-owned comment.
An incomplete lookup is not absence. Lost replies trigger readback on retry.
All managed rows, even equal desired/synced versions, receive low-frequency
verification so late older writes are corrected after remote requests settle.

The [GitLab Notes API](https://docs.gitlab.com/api/notes/) does not document a
conditional-version write or create-idempotency contract for these endpoints.
Do not claim exactly-once creation, remote fencing or monotonic visibility.
A timed-out create may finish after a later lookup and cause a duplicate. The
stored/discovered managed note converges; arbitrary remote comments are not
deleted. Disabled connections remain observable sync failures without changing
PG's accepted business state.

## Cutover and rollback

Migration 149 seeds pending rows for existing GitLab jobs, installs invalidation
triggers and drops `claim_sync_pending`. Delete the old lock-held method and the
Issue coordinator's sync/backoff branch; no dual writer or compatibility mode.
Stop old Control Planes before migration and deploy matching code. This is not
a mixed-version rolling change. Rollback restores matched PG backup/code, not a
down-migration over new writes. Integration export remains PG business/sync rows
plus GitLab note IDs. Guest templates and native Run/log authority are unchanged.

## Acceptance

Real PostgreSQL and controlled HTTP supplement deterministic tests. Slow HTTP
must release business/database transaction locks; claim/unclaim and Issue
admission continue. Concurrent reconcilers normally have one active sync per job;
other jobs progress independently. Test mid-flight changes, crashes, expired
tokens, uncertain create/update replies, late stale writes, per-job backoff,
deleted notes, incomplete lookups, tenant scope and shutdown aborts. All displayed
state changes invalidate; no-op claims and heartbeats do not. Complete migration,
typecheck/regression gates and document local rollout evidence.
