# ADR-0323: Platform service minutes and reclamation evidence

Date: 2026-11-13. Status: implemented and live-verified on 2026-11-14. Issue: #39.

The owner sells provisioned sandbox service, with minute-level settlement, and
exempts user-provided compute. This supersedes ADR-0309's compute pricing rule
only for new, explicit platform service contracts. Historical physical
observations remain unconfirmed; no retrospective charge is inferred from them.

## Contract and authority

Backend registration declares platform-provided or external/BYO compute. Freeze
that choice and verified capacity with the allocation. Existing managed Linux
backends adopt platform service eligibility at this development cutover; no old
allocation gains retrospective service time. New backend registration defaults
to external unless the administrator explicitly offers platform compute.
Later metadata changes affect new allocations, never old contracts.

Registered devices default to BYO. Only an explicit administrator request and a
verified managed Android allocation/capacity can open a platform compute service.
A local computer, physical phone or arbitrary registered endpoint does not become
billable because it is online, bound to a Session or executing Tools. Android
resource identity may have no Workspace; never fabricate a Workspace for billing.
Independent model and actually provided storage accounting retain their contracts.

Resource management remains the sole lifecycle authority. Persist service
boundaries with its existing resource-state transitions. A small accounting
period record retains each availability interval after active resource rows are
removed. It neither schedules work nor authorizes admission, cleanup or quotas.
The existing independent metering process consumes those periods into its
immutable receipt/rate ledger. No synchronous metering RPC enters a Tool or
resource operation. Stop of the metering process does not stop resources.

## Duration and failures

Start only when service is ready and capacity is known. Pause/resume produces
separate availability periods. Explicit accepted pause/release cuts customer
service time; normal expiry uses the last effective deadline of the allocation
actually admitted for expiry. Renewal and expiry keep ADR-0314's serialization.
No future retention time is prepaid. Cleanup after that cutoff is platform cost.

Use existing passive resource observations, coalesced to at most one healthy
checkpoint per minute per allocation. They do not renew idle time or execute
Guest probes. An interruption closes at the last confirmed service observation.
After an observation gap over 90 seconds, open a fresh period instead of filling
the gap. A normal close may settle its fresh final tail; stale/unconfirmed tails
remain unpriced. This is an explicit sampled service-availability contract, not
a claim of second-perfect physical uptime. Collector downtime alone does not
erase retained management observations or create a service outage.

Retain original timestamps and settle whole elapsed eligible minutes relative
to each period's start. Carry partial minutes across collection batches and
restarts; waive the final incomplete minute. Rate changes split the resulting
paid interval without independently rounding each segment. A shared allocation
is counted once across Sessions and children. Collector cursors and receipts
commit together under existing per-resource locking and idempotency.
Service receipts do not masquerade as vendor usage for upstream cost estimates.

For example, service ready at 10:00, expiry at 10:30 and confirmed deletion at
10:30:06 gives thirty service minutes. Six seconds of cleanup are not charged.
Earlier failure and unresolved gaps follow the interruption rule, even when the
planned expiry was later. Management outages can delay physical cleanup; they
never extend a closed billing period or justify a quota release.

## Lightweight physical timing

Keep requested cutoff, first delete dispatch, attempts and deletion confirmation
as bounded metadata on the existing resource directory. Emit structured logs on
boundary changes and aggregate retries. Only record a physical occurrence time
when an adapter supplies trustworthy evidence; otherwise it remains null.
Confirmation time is an observation/upper bound, not an invented exact stop time.
Android service withdrawal or loss is not proof that its VM was deleted.

These diagnostics never enter native conversation history, affect Tool results
or become an authority for resource destruction. Positive provider evidence
still gates physical ownership/quota release. No per-second sampling is added.

## Build versus adopt

[OpenMeter's usage events](https://openmeter.io/docs/metering/events/usage-events)
separate source/ID deduplication from duration aggregation. Its
[pipeline](https://openmeter.io/docs/metering/events/how-it-works) adds ClickHouse
and another ingestion/consumer stack. [Lago metrics](https://www.getlago.com/docs/guide/billable-metrics/aggregation-types/count)
also operate on application-supplied usage facts. Neither determines our
readiness, expiry or BYO boundary. Reuse the existing independent PG receipt and
price implementation with a bounded service-period source; adding another
billing stack would not remove that source contract and would duplicate storage.

## Cutover and acceptance

Use a drained matched schema release, retaining accounts, credentials and
Workspace bytes. Retire the old Cube-only observation collector, its credentials
and obsolete tests; physical lifecycle observation in resource adapters remains.
No old raw observations are relabelled as billable service.

Test Cube/BoxLite/managed Android service, BYO exclusion, pause/resume, shared
use, stale observations, collector restart, duplicate delivery, minute/rate
boundaries, renewed/expired deadlines and delayed/failed cleanup. Verify logs
without secret contents and actual retained physical files. Production tariff
activation/payment collection are not introduced by this change.

Delivery: [shared clients, local execution and service minutes](../reports/client-service-delivery-20261114.md).
