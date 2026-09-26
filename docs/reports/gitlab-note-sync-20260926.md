# GitLab Issue-note synchronization — 2026-09-26

Baseline: `0e8362e9`. This is the owner-approved follow-up to PI-12, which the
earlier Pi-alignment repair intentionally retained until its consistency boundary
was discussed. Decision: [ADR-0190](../adr/0190-gitlab-issue-note-convergence.md).

## Change

GitLab comments now have an independent, bounded Control Plane reconciler.
The business transaction updates PG claim/job state and its desired note version
atomically. HTTP happens after the synchronization claim transaction commits.
Only the captured version can be acknowledged, under its current PG-time claim
token/lease. A newer desired version remains pending. The Issue-to-Run loop no
longer waits for comment synchronization.

Migration 149 installs one sync target per GitLab job and narrow invalidation
triggers. It covers claim changes and actual displayed state changes, including
Run completion/failure; unchanged claims and heartbeat metadata do not invalidate.
The old `claim_sync_pending` column, lock-held HTTP method and coordinator-wide
sync retry branch were deleted. There is no old/new writer compatibility path.
The sync row contains versions, remote identity and bounded scheduling/error
metadata, never comment bodies or credentials. PG remains the sole business
authority; no queue framework, broker or Agent scheduling role was added.

Each process has at most two in-flight syncs. The lease is 60 seconds; a whole
HTTP attempt is bounded to 30 seconds. Transient errors back off per job from
2 to 60 seconds; persistent failures become due again after 15 minutes. Successful
rows become eligible for remote verification after five minutes, even when PG's
desired/synced versions are equal. Actual scheduling also depends on backlog,
available concurrency and provider availability; these are not latency SLAs.

Stable marker lookup and saved note IDs recover lost responses. Identical remote
content needs no PUT; an incomplete marker lookup cannot authorize a create.
A stored note whose identity marker was removed is reported as a mismatch rather
than overwritten. Periodic readback corrects late stale writes. Local fencing
does not fence GitLab: temporary remote regression and duplicate comments after
ambiguous creates remain possible. Arbitrary comments are never deleted.

## Verification

The maintained [reconciler tests](../../packages/control-plane/test/gitlab-issue-note-reconciler.test.ts)
use actual HTTP sockets and an isolated database. All **17 cases passed on real
PostgreSQL**, including:

- migration from schema 148 with both old pending and non-pending jobs;
- atomic version invalidation, rollback, no-op and heartbeat behavior;
- a held provider request while another replica skips its lease and the user
  claims/starts the Issue; an actual queued Run is admitted before HTTP is released;
- two bounded background syncs while the independent Issue loop keeps ticking;
- another tenant's progress while a provider request is blocked;
- create/update applied remotely but their responses lost: readback confirms the
  existing result without another write in those scenarios;
- abandoned ownership, expired acknowledgement after an observed PG row-lock
  wait, and rejection of an old execution's acknowledgement;
- a late stale PUT after the newer version was acknowledged: equal local
  versions still receive verification and the current content is restored;
- per-job authorization failure/backoff, a newer revision surviving an older
  failure, deleted notes, identity mismatch and cross-tenant credential rejection;
- incomplete lookup without POST, overall deadline propagation across lookup
  and write, and shutdown abort retaining pending work.

The Run-admission case stubs the existing Tool Broker credential preflight;
it does not execute an Agent, model, Git command or Cube. Provider behavior is a
controlled localhost HTTP server, not an external GitLab installation. No paid
model calls or real GitLab comments were created for this acceptance.

The existing source-control service and GitLab client cases also passed against
the isolated PostgreSQL service. Workspace-wide typechecks, formatting,
documentation, runtime policy and image closure checks passed. Full regression
including acceptance helpers passed **1,117 tests**, with **108 opt-in tests
skipped** and zero failures. Skips are not counted as live passes.
The expanded [fault gate](gitlab-note-sync-faults-20260926.md) passed **42/42**;
its [JSON evidence](gitlab-note-sync-faults-20260926.json) records that it ran on
the uncommitted implementation (`dirtyWorktree: true`), not unmodified baseline.

The first fault-gate invocation omitted `PI_CLOUD_POSTGRES_INTEGRATION_URL`, so
eight existing atomic-admission cases were skipped and correctly failed the gate.
Its new GitLab cases passed. That invocation is not accepted evidence; the complete
gate must set both it and `PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL` to the
disposable PostgreSQL endpoint, as CI does. The corrected invocation passed all
42 targets. The disposable PostgreSQL container and its data were removed after
the successful gate.

## Rollout

Preflight found zero active Runs, current Session leases, active Issue owners or
GitLab Issue jobs. One configured GitLab connection remains, without tasks to
seed or comments to modify. The guest build-input identity still matches the
deployed `908d27fc397894bdebe74ccc1c9a7d075df8389a`.

The pending rollout replaces Control Plane and its database-bootstrap image,
with the old Control Plane stopped before migration 149. Guest and native
execution-log protocols are unchanged. Final deployment and cleanup evidence
will be recorded here after verification.
