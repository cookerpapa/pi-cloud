# ADR-0314: Platform-owned elastic idle expiry

Date: 2026-11-11. Status: implemented and deployed.
Tracking: [#29](https://github.com/cookerpapa/pi-managed-agents/issues/29), prerequisite
to the full alternate-provider integration in #27.

The owner chooses one platform retention policy across sandbox providers. This
supersedes ADR-0309's native-provider expiry authority. The prerequisite to #27 is
complete; [delivery evidence](../reports/platform-idle-expiry-20261111.md) records
the matched release and serial acceptance.

## Authority and flow

The existing resource-management role owns expiry decisions. PG stores a deadline
on the existing physical elastic-allocation rows, including standalone terminal
allocations. The immutable creation specification already contains the idle
window. No extra resource ledger, scheduler, broker or per-Tool lease is added.
Initialize a deadline once when an allocation becomes ready; controller adoption,
health probes and accounting observations do not reset it. Dedicated machines
have no idle deadline. Unresolved creation retains its existing reconciliation
rules rather than guessing physical absence from elapsed time.

Continue using bounded, fenced Session activity through Kafka. The Projector
resolves the physical allocation in its current resource view, coalesces shared
uses and sends bounded batches to resource management. The management endpoint
updates only PG, never a provider timeout. Preserve the original activity time:
`deadline = max(deadline, activity time + recorded window)`. Validate freshness
against PG time; stale/replayed events cannot renew from delivery time. The
physical allocation ID, tenant and kind prevent old declarations from extending
a replacement. A closing allocation cannot reopen. No Worker/Run lease query is
introduced into this maintenance path, and absent compute is never created.

Move existing terminal/preview connection retention out of the Cube adapter.
The generic interaction layer declares use while an authorized connection is
held; coalescing and the same deadline rule apply. Closing a connection ends
that declaration. Fresh resource admission/reuse counts as use. Passive probes
never do. Large file transfers to a persistent Volume do not imply a running VM.

## Expiry, races and recovery

Use the current resource cleanup/reconciliation loop with bounded indexed due
queries. It atomically rechecks the deadline and closes the allocation, using the
same admission locks as resource reuse. A renewal committed first prevents
expiry; an expiry claim committed first rejects later renewal. Existing binding
closure and native provider deletion follow outside the database transaction.
Quota/ownership release still requires positive deletion evidence. A failed or
ambiguous delete stays closed and pending; it is not a successful reclaim.

An unconfirmed old Tool is not a permanent veto once retention expires. This
does not authorize shell replay or whole-VM deletion on an ordinary Tool error.
Workspace bytes and retained conversation attachments survive compute retirement.
Normal user Stop and abnormal Worker retirement retain their distinct semantics.

PG deadlines survive management restarts. On startup, allow a bounded two-activity-
interval reconciliation grace for fresh declarations to reach the new manager
before claiming previously due resources. This delays enforcement without
extending stored deadlines or treating restart as activity. During management/PG
or required ordered-closure outage, physical resources may remain longer than the deadline; restoration
reconciles them. No claim of independent expiry while the management plane is down.

## Provider and cutover

Create all PiCloud-managed Cube allocations with native timeout disabled. Remove
native periodic timeout calls and adapter-local interaction timers. Provider
adapters expose ordinary lifecycle mechanics; they do not maintain another idle
clock. A future BoxLite adapter therefore does not need a native AutoStop API.
No vendor source patch or full BoxLite cloud scheduler is introduced.

The matched upgrade drains/fences writers, confirms old compute retirement and
preserves stable machine intent, Workspace bytes, accounts/configuration and
credentials. Do not leave finite-native and platform-expiry allocations mixed.
Remove obsolete capsule/state fields instead of adding a compatibility reader.
Accounting remains independent; unconfirmed compute intervals stay unpriced.

## Build versus adopt and acceptance

Kubernetes' [TTL-after-finished controller](https://kubernetes.io/docs/concepts/workloads/controllers/ttlafterfinished/)
demonstrates deadline-based controller cleanup and cautions about TTL changes;
its authority is Kubernetes Jobs, not these existing PG/native VM allocations.
Adopting it would require a competing Kubernetes resource history. Reuse the
project's current PG-backed resource owner and cleanup loop instead.
PostgreSQL's [locking SELECT](https://www.postgresql.org/docs/current/sql-select.html)
supports bounded `FOR UPDATE SKIP LOCKED` work claiming. All provider calls stay
outside those transactions. No new distributed queue implementation is needed.

Test renewal/expiry races, duplicate/stale/future activity, shared resources,
replacement identities, active waits and interactive connections, pure chat,
dedicated machines, controller/PG downtime and uncertain deletion. Then deploy
and exercise actual Cube/Worker/Projector/PG behavior serially on WSL. Verify that
renewal produces no Cube timeout API request, that files survive expiry, and that
original assets remain. Complete this issue before resuming #27.
