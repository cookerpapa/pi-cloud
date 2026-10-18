# Control Plane → PG expiry review

Date: 2026-10-18. Reviewed revision:
`3494ff927f0188cf0eeccb33bf5f84845e895601`.
Serving release: `session-lease-079dbddc`.

Scope: expiry scheduling, management-connection expiry, Session candidates,
locked decisions, durable recovery/seal admission and the Worker retirement
queue boundary. Kafka seal publication, physical cleanup and successor bootstrap
remain the next walkthrough hop, except where completion explains selection.

This review adds documentation and isolated PG characterizations only. It changes
no runtime, protocol, schema or deployment and injects no production fault.

## Current flow

PG stores deadlines; it does not automatically send an expiration notification
when time passes a stored value. `SupervisorMaintenanceRuntime` initially waits
one second, completes a sweep, then waits another second. Errors also cause a
delay before retry. One second is a cycle delay, not a detection-time guarantee.

Each sweep processes due management connections, then selects ready Workers
with expired, unreleased Session leases. The lease cutoff is one PG
`clock_timestamp()` value. Defaults select up to 100 connections, then ten Workers
and ten expired physical Sessions per selected Worker. The shared `leaseLimit`
name obscures these different windows. Neither bounds the preliminary all-Session
cleanup below. Remote Worker retirement runs in a separate loop; its HTTP wait
does not directly await-block this sweep, though both still depend on PG.

For each Session candidate, the controller locks its Run/Session, physical
`pi_sessions` identity, Worker and lease in the maintained order, then rechecks
the current grant using fresh PG time. It skips a renewed owner or a changed
Run/lease/Fence. A confirmed expiry commits the following together:

| Location | Meaning |
| --- | --- |
| `session_leases.writer_failed_at` | The old writer cannot renew this grant |
| `runs.recovery_requested_at`, `output_seal_id` | Preserve the logical Run and identify its required closure |
| Existing `outbox` row (`execution_seal`, `recover=true`) and transactional `pg_notify` | Persist the request and wake its publisher |
| `runs.execution_released_at` | Remove this execution from the active-scope query view |

That last field is **not** the physical Session lease's `released_at`. The lease
remains unreleased until its ordered writer closure is materialized. A successor
cannot use a mere expiry/request as closure proof. This step does not increment
the next owner's epoch or prove that a VM/process is dead.

## Findings

### CPE-01 — P2: SQL/lock waits can stop the whole expiry sweep

Maintenance uses the Control Plane's ordinary 12-connection pool, with no
checkout/acquisition or statement budget configured for this path. The serving
role reports `statement_timeout=0`, `lock_timeout=0` and
`idle_in_transaction_session_timeout=0`. ADR-0258's bounded lease pool is on the
Worker side, not this scanner.

`expireConnections()` awaits each locked transaction before the Session query
starts. Session retirement is also serial. Before selecting expired assignments,
`#releaseIdleFamilies()` visits **every unreleased lease on that Worker**, including
healthy ones, locking its physical Session and attempting a usually no-op release.

Two real-PG schedules reproduce the coupling:

1. Worker A has an expired Session and a healthy Session; Worker B has another
   expired Session. Holding only the healthy Session's `pi_sessions` row keeps
   the sweep pending for at least 1,250 ms. Neither expired Session gets a seal
   request while blocked. Both do after unlocking; the healthy owner stays valid.
2. Holding an idle Worker's Host row during management expiry prevents an
   unrelated expired Session receiving a request until that Host is unlocked.

Impact: unrelated recovery waits behind one lock, and maintenance drain can wait
on the same outstanding query. Progress resumes on lock release, request failure
or process interruption; no scanner-owned bound exists. This is isolated
contention evidence, not a production incident or an incorrect successor grant.

Locations: `control-plane/src/supervisor-maintenance-runtime.ts:158`,
`supervisor-connection-manager.ts:755`, `:830`,
`assignment-reconciler.ts:135`, `:395`, `control-plane/src/main.ts:131`.

Repair direction: bound maintenance I/O and lock acquisition; skip busy candidates
without retaining earlier locks; preserve lock order and the post-lock PG check.
Management expiry must not monopolize Session expiry progress. Remove unrelated
healthy-owner work from ordinary expiry. If orphan release remains necessary,
select only eligible, already-sealed owners and bound that work separately.
A Promise timeout leaving SQL/locks alive is insufficient.

### CPE-02 — P2: failed Workers with live connections can miss retirement admission

Fatal direct renewal failure latches the backend unhealthy, revokes local work
and calls `quarantineWorker()`, which writes `workers.state='failed'` without
inserting `worker_retirements`.

The production management heartbeat contains no family renewals. Its connection
UPDATE validates connection/Boot/transport identity and expiry, but does not
consult Worker failure. An open socket can keep extending that connection.
The Session selector only considers `worker.state='ready'`; the retirement loop
only consumes existing retirement rows. Neither bridges this failed state.

The characterization uses real Run admission, backend, Supervisor, quarantine
and connection manager, with a substituted Runner/Kafka and injected renewal
error. Local Run recovery is correctly requested. Three subsequent actual
heartbeat/sweep/retirement cycles retain:

- Worker `failed`, backend `healthy=false`;
- connection `active`, three successful heartbeat acknowledgements;
- zero retirement rows and three idle retirement polls.

Impact: effective pool capacity can remain reduced until another reconnect,
restart or Boot replacement event enters existing retirement. This is not a
revived lease or a failure of local-first stopping. A live Kubernetes liveness
fault was not injected.

Locations: `runtime-core/src/session-lease-coordinator.ts:306`,
`supervisor-host/src/agent-run-execution-backend.ts:714`,
`control-plane/src/supervisor-connection-manager.ts:617`, `:855`, `:1214`;
the gateway forwards heartbeats at `supervisor-websocket-gateway.ts:372`.

Repair direction: connect authoritative Worker failure to the existing durable
retirement flow, atomically at failure or through bounded controller reconciliation
of failed Workers without retirement work. Connection liveness must not suppress
that transition. Preserve healthy idle/busy reconnect, old-Boot identity, local
revocation, ordered closure and physical cleanup. Do not mark failed Workers ready
because they heartbeat, or retire a healthy Worker merely because one Session expired.

### CPE-03 — P2: pending seals can monopolize the Worker candidate window

The outer query orders by the oldest expired **unreleased** lease and takes ten
Workers. After requesting a seal, `runs.execution_released_at` excludes the Run
from the inner `active_execution_scopes` view. Its lease correctly stays
unreleased until seal projection, so the outer query keeps selecting it despite
having no new expiry action for this hop.

Using the actual default and eleven isolated Workers: the first round requests
ten seals; three more rounds request zero, leaving the eleventh Worker without
a seal request. Projecting one old seal through the real PG Projector frees a
slot, and the next round immediately requests the eleventh seal.

Impact: delayed sealing in earlier candidates can postpone independent recovery.
Raising the limit only moves the threshold. **Production currently has two
Workers**: the eleven-Worker condition is an expansion risk, not an observed
incident on this deployment.

Location: `control-plane/src/supervisor-connection-manager.ts:843`; inner filter:
`assignment-reconciler.ts:249` and `active_execution_scopes`.

Repair direction: select owners which still need closure admission, excluding
requests already handed durably to the seal publisher. Keep their unreleased
lease evidence; never release early to free a scan slot. Bound candidates in
SQL and retain progress past busy/deferred ones. Existing Outbox owns seal
retries; failed/incompletely recovered owners need explicit handling, not blind exclusion.

### CPE-O1 — P3: expiry SQL grows unnecessarily with healthy Sessions

Actual pg client calls, with real admission and no expired management connection:

| Scenario | Business SQL | Including BEGIN/COMMIT | Physical Session lock reads |
| --- | ---: | ---: | ---: |
| Nothing expired | 2 | 2 | 0 |
| One expired Session, one Session total on its Worker | 24 | 28 | 3 |
| One expired Session, eight Sessions total on its Worker | 38 | 56 | 10 |

Each extra healthy Session adds begin, physical-Session lock, no-op release
UPDATE and commit. Finalization also rereads already locked Run/Session and
tenant facts, and relocks physical ownership inside release. For this one-expiry
fixture the total is `24 + 4 × N`. Counts include the outer two reads, exclude
Runner work and the separate retirement poll, and do not count server-internal
trigger SQL. The independent idle retirement poll itself has one business SELECT
inside BEGIN/COMMIT; it is not part of these numbers.

This is a recovery-path cost, not per-token/Tool traffic. The ordinary two-read
scan does not justify another cache or event service. Remove unrelated-owner
work, then reuse transaction-local locked facts with identity/version checks.
Current normal/seal projection already releases eligible owners in its closure
transaction: establish any remaining present-day orphan-release need before
removing protection. Historical child Run topology is not a justification for
unconditional all-family scans after ADR-0247.

## Verification and limits

- **50 existing tests across eight files pass**, including real-PG expiry/renewal
  races, clock skew, family isolation, ordered seals, management reconnect,
  WebSocket gateway and independent maintenance/remote-retirement loops.
- Six characterizations confirm two SQL samples, two lock paths, candidate
  starvation and failed-connected Worker. The first run passes five and fails
  one probe assertion: A's current seal pointer is cleared when projection
  requeues A. Corrected assertions check ten current pointers, eleven immutable
  Outbox requests and the eleventh Worker's new pointer. The focused repeat passes;
  five unrelated cases are skipped only by `-t`. Product behavior is not changed.
- Strict typecheck initially finds UUID default-argument inference in the new
  helper; explicitly typing its instance-ID parameter as `string` corrects it.
  Final strict typecheck passes.
- Production access is read-only: two configured/Ready Workers, zero unreleased
  leases and the three zero timeout settings. Isolated databases/test containers
  are removed. No paid model call, VM fault or deployment is performed.

Locked PG-time rechecking, atomic seal intent/notification, one physical-Session
owner and ordered closure before takeover remain appropriate. No expired-owner
revival or early-successor admission is established here. Pi owns native task
continuation; this is the outer cloud ownership controller, and repair does not
require patching Pi's Agent Loop.

[Reproducer commands](../../scripts/experiments/review-control-expiry-20261018/README.md)
and [sanitized evidence](control-plane-expiry-review-20261018.json) accompany the
review. Findings are open in [BACKLOG](../BACKLOG.md#control-plane--pg-expiry-review).
