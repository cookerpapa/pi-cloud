# Worker → PostgreSQL Session lease review

Date: 2026-10-18 (Asia/Shanghai). Reviewed revision:
`85eb2f073eb90b678327b38bf712bbc225daf6a5`.
Serving release remains `browser-delivery-205e6ac0`.

Scope: the production Worker's direct renewal, Session lease SQL/locks, shared
local authority observer, renewal acknowledgement handling and local failure
settlement. Management reconnect and expiry reconciliation are checked at their
interfaces; full forced-seal/successor recovery is the next walkthrough hop.
This review adds documentation and isolated characterizations only. No runtime,
protocol, schema or deployment changes; no production fault or paid model call.

## Findings

### WLR-01 — P2: an outstanding PG read disables local deadline enforcement

`PostgresSessionLeaseObserver` computes a conservative monotonic deadline from
confirmed PG lifetime. However, it checks that deadline only when adopting a
reply or when a caller enters `assertCurrent()`. The latter waits for the shared
refresh once its cache expires. The periodic timer awaits that same refresh
before scheduling another check. There is no independently scheduled expiration
of an already active owner's last confirmed lifetime.

The production Worker uses the ordinary authority pool without client query or
connection-acquisition budgets. A read-only check of the serving database also
reports `statement_timeout=0`, `lock_timeout=0` and
`idle_in_transaction_session_timeout=0`. Connection errors are handled, but a
request which remains pending is a distinct case.

The isolated observer test establishes a deadline at monotonic 3,000 ms, starts
a read at 1,000 ms, withholds its response, and advances to 10,000 ms. Its abort
signal is still unset; a new `assertCurrent()` also remains pending. Resolving the
read with a missing owner then aborts correctly. Existing tests cover errors and
late replies, but not a reply that never arrives.

Impact: when fresh renewal evidence is also unavailable, a provider request,
Tool wait or local cleanup can remain live beyond the known lifetime. New native
commits still encounter `assertCurrent()` and wait; this is **not** evidence that
expired native commits reach Kafka, a stale writer takes over, or arbitrary Tool
effects execute twice. Ordered Kafka fencing and PG takeover guards remain.
An otherwise healthy renewal can still refresh the observer while a read is
outstanding; the defect concerns lack of any newer confirmed lifetime.

Locations: `packages/pi-session-postgres/src/postgres-session-lease-observer.ts:61`,
`:122`, `:206`, `:226`; `packages/database/src/client.ts:40`;
`packages/supervisor-host/src/runtime.ts:185`.

Repair direction: enforce the active owner's existing conservative deadline
independently of observation I/O, and bound pending database/pool work and close
paths. Retain fresh PG authorization before cold restore can perform effects;
do not turn an old cold cache into proof that PG revoked a newly renewed owner.
Local expiration stops work but does not release PG ownership, reopen a producer,
cancel a whole VM or authorize a successor. Late responses cannot revive an
aborted owner. A Promise timeout alone is insufficient if the old SQL continues
to hold a pool slot/lock or a later callback can still adopt its result.

### WLR-02 — P2: local revocation waits for another PG mutation after renewal fails

The renewal loop catches a non-retryable failure, records a local failure flag,
then **awaits `quarantineWorker()` before invoking `revokeExecution()`**. That
quarantine transaction acquires a Worker row lock and writes `state=failed` using
the same ordinary database pool. If PG/pool/that row is stuck, the failure handler
waits on the component whose failure it is handling.

The isolated integration test uses the real Run admission/execution backend and
`AgentRunSupervisor`, injects a rejected renewal and holds the quarantine Promise.
The runner's abort signal remains unset until quarantine is released, after which
revocation and Run failure settlement complete. The runner and Kafka transport
are substituted: this proves the ordering, not a live Pi/Cube process leak.

Impact: already accepted work is not promptly stopped by this failure path.
The independent native observer can stop it if its own PG query completes; that
does not cover WLR-01's stalled-I/O case. Stopping locally must not require a
successful database mutation.

Location: `packages/supervisor-host/src/agent-run-execution-backend.ts:702`;
quarantine implementation: `packages/runtime-core/src/session-lease-coordinator.ts:282`.

Repair direction: mark local admission failed and signal the affected local
executions first. Persist existing Worker quarantine/retirement with a bounded
attempt afterward, preserving eventual PG/ordered-seal reconciliation. Local
abort is not physical cleanup confirmation. Do not retry uncertain native
publication or renew an owner whose authority has actually been revoked.

### WLR-03 — P2: one locked Session prevents other Sessions in the batch renewing

Renewal first locks every reported unreleased lease in sorted order with
`FOR NO KEY UPDATE`, then updates the complete batch. Ordering avoids inverse
lock order within the batch, and checking PG time **after** acquiring locks
correctly prevents revival. But all healthy physical Sessions on this Worker
must wait for the slowest lease lock. There is no lock-wait budget or partitioning
of busy leases from renewals that could proceed.

The real-PG characterization creates two independently owned Sessions on one
Worker, gives both one second of remaining lifetime, and holds only A's lease row.
It confirms the renewal is blocked on a PG lock and that B expires without being
renewed. After unlocking A, both renewals are rejected. This is a deliberately
short remaining-lifetime schedule, **not** a change to the 60-second production
lease or an observed production incident. With the production duration, a lock
which consumes the remaining lifetime has the same effect.

Impact: contention in one Session can unnecessarily interrupt another Session
and require its ordered recovery. Shared renewal is a good SQL optimization, but
it currently also shares the lock failure boundary. Native child Conversations
within the same physical Session should continue sharing one lease.

Location: `packages/runtime-core/src/session-lease-coordinator.ts:196`.

Repair direction: retain batch renewal for immediately available owners while
isolating lock-busy owners, with bounded retries constrained by their last
confirmed lifetime. A possible implementation uses nonblocking row selection
and updates only the selected, locked rows, retaining a post-lock PG time check.
**Do not merely add `SKIP LOCKED`:** both acknowledgement consumers currently
interpret a missing renewal as revocation. Busy/unconfirmed and positively
rejected owners must be represented separately; skipping a row never extends its
lifetime. Bound the PG request itself as well. Preserve independent expiry of
each physical Session and ordinary errors' current fail-closed policy unless a
separate decision explicitly changes it.

## Current path and SQL cost

The production `AgentRunExecutionBackend` starts one renewal loop when it tracks
work. `heartbeatIdentity()` reads the Worker once when this loop starts. The
loop immediately renews, then waits `leaseDuration / 3` after each completed
cycle: by default a 60-second lifetime and a 20-second delay, not a strict
wall-clock schedule. Only aborted/deadlocked transactions (`40001`/`40P01`) get
up to five bounded-count retries; other errors enter the failure path above.

`AgentRunSupervisor.createHeartbeat()` reports one owner per physical Session.
The production coordinator has no management connection guard. Its ordinary
successful nonempty renewal contains:

| SQL | Role |
| --- | --- |
| `BEGIN` | Start the renewal transaction |
| Read `workers` | Check Worker/Boot/capacity identity and ready state |
| Lock reported `session_leases` | Serialize against closure, release and other lease mutation |
| Batch `UPDATE session_leases … RETURNING` | Check PG time, tenant/Session/lease/Fence/owner and closed/failed state; update `valid_until`, `renewed_at` |
| `COMMIT` | Confirm the renewal before using its evidence |

Thus **three business statements, five including transaction boundaries**, both
for one and eight Sessions. Ten isolated samples per size measured:

| Physical Sessions | p50 | p95 (maximum of 10) | Statements |
| --- | ---: | ---: | ---: |
| 1 | 5.86 ms | 9.51 ms | 5 |
| 8 | 5.83 ms | 6.09 ms | 5 |

These are a local disposable PG sample, not production/fleet percentiles. A
batch with no successful renewal reads PG time once more for its acknowledgement.
The initial Worker identity read is outside these recurring counts. Renewal does
not update Runs, native history, Kafka or management connection rows.

One Worker-local observer separately batches a read of all watched owners at
roughly one-second intervals. Committed renewals feed its cache; publication and
model-start checks normally read that cache, not PG per token/commit. That is
already the intended optimization. Removing the observer would slow awareness
of explicit revocation to the renewal cadence; this review does not recommend it.

The management WebSocket has its own connection heartbeat, with no family
renewals in the production transport copy. Its reconnect does not create a new
Session lease. End-to-end Kafka/Cube probes are disposable transport observations
and never renew execution authority. Existing reconnect tests preserve these
boundaries. Full seal/recovery timing is deferred to the next hop.

## Preserved design and verification

The review checked ADR-0170, ADR-0201, ADR-0247/0248 and the historical shared
observer repair. The latter deliberately chose one-second batched observation
and fail-closed handling of actual query errors; that choice is not reclassified
as a newly found defect. Keep PG authority, one physical Session owner, direct
Kafka fencing and control-independent renewal. The priority is bounded failure
handling and isolation, not adding services, a lease broker or per-Step SQL.

- **123 existing tests pass across eight files**: observer (including stale
  replies/clock skew), Supervisor heartbeat, family/expiry isolation, real-PG
  authority time and atomic admission, PG Worker operation and management reconnect.
- **Four isolated characterizations pass**: pending observation, SQL batching,
  real-PG lease-lock coupling and quarantine-before-local-abort ordering. These
  assert the current defects, not repaired behavior. The original run used
  `console.log`, whose output was not retained; the final diagnostic run changes
  only reporting to `process.stdout.write` and repeats the same four assertions.
- The isolated probes' strict TypeScript check initially found a missing array
  type annotation in the new fixture; adding the existing heartbeat-family type
  fixes it without changing assertions or runtime behavior. The final strict
  typecheck, documentation-link check, formatting and whitespace checks pass.
- Existing real-PG tests confirm that a lease which expires while waiting for a
  lock cannot revive, and a stale expiry candidate cannot retire a renewed owner.
- The only serving-system access reads timeout settings/active lease count and
  Pod readiness. At that observation there are zero active leases and all Pods
  are Ready. Disposable test databases/containers are removed by their fixtures.
- This is not a full CI, a new live crash test, a fleet capacity benchmark or a
  claim that every recovery hop has been re-audited. No credentials, user data or
  runtime configuration are changed.

Baseline reproducers/commands are preserved in Git at `ddc404f8` under
`scripts/experiments/review-worker-lease-20261018/`. The approved repair replaces
them with maintained observer and real-PG renewal regression tests (ADR-0258).
Sanitized measurements and source hashes: [evidence](worker-session-lease-review-20261018.json).
Repair items remain open in [BACKLOG](../BACKLOG.md#worker--postgresql-session-lease-review).
