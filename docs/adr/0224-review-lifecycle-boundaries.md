# ADR-0224: Lifecycle recovery and request-policy boundaries

Status: implemented and deployed, 2026-10-05.
[Verification and matched release](../reports/review-repair-20261005.md).

The owner approved the October 4 review repair proposal. Preserve PG control
authority, ordered Kafka publication, native Pi execution and Cube physical
lifecycle ownership. This decision covers R04-01/02/04/05/07 and Q04-01;
Volume reconciliation and structured Tool failures have separate decisions.

## Accepted cleanup

Allocation queries retain a short transport budget. Close durably excludes new
creation before waiting for the allocation lock. Once cleanup starts, Cube owns
its bounded native destroy lifetime independently of the caller connection,
as it already does for accepted creation in ADR-0223. Normal calls still await
the result; interrupted calls reconcile the same allocation. No new task queue
or scheduler is added. Cube's configured destroy budget must cover paused-VM
resume, cleanup and response. Master and client Close transports reserve time
outside that budget. The managed profile currently configures 60 seconds at
Cubelet, followed by 65/70/75/80-second Master/API-client/API-route/PiCloud Close
budgets. Queries keep their short budget; accepted cleanup can outlive it. Timeout never proves absence or releases capacity.

Reuse the adopted Apache-2.0 Cube native lifecycle and allocation adapter,
pinned by runtime-build.json. The native paused-delete implementation and the
review's real paused VM reproduction establish the missing contract. The
[ADR-0223 survey](0223-recoverable-vm-allocation.md#adopt-before-build) remains
applicable: another controller framework cannot supply a missing Cube RPC
lifetime contract and would duplicate PG ownership.

## Local recovery publication

Prepare recovered handles, bindings and required durable state before making
them available through controller maps or capacity accounting. A failed local
adoption detaches only its candidate and leaves durable recovery information
retryable. Committed PG changes are reconciled, not falsely rolled back.
Individual health-target enumeration failures are isolated and reported; they
do not establish physical VM failure. Unexpected timer failures must not escape
as uncaught exceptions. Preserve visibility of errors and retryability.

## PG decision boundary

Lifecycle authorization locks the controller identity before resource mutation,
uses a consistent lock order and rechecks PG time after lock acquisition. Owner
revocation must conflict with this lock. Keep resource ownership CAS predicates;
no Cube RPC may run inside the transaction. Tool routing retains its installed
memory view without per-Tool PG lease checks.

SSH issue/consumption uses PG time. After taking the ticket lock, consumption
checks expiry and one-use state in its guarded update. Application clocks are
not an authorization source.

## Model policy and verification

Apply the frozen common model request policy to ordinary sampling and native
Compaction, preserving native summary limits, session identity and caching.
Keep model permits scoped to each provider call. Failed/empty/truncated summaries
must not replace the original context. Validate browser fixtures with the same
protocol parser used in production.

Acceptance includes paused direct release, caller loss, delayed creation,
failure at every adoption stage, live monitor survival, owner-revocation/lock
wait races, Fast compaction and SSH expiry under lock contention. Run real
metadata/native contract tests plus matched Cube lifecycle and Luna acceptance.
Preserve existing business data and uncertain historical allocations.
