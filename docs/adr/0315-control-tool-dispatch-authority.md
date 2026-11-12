# ADR-0315: Ordered control Tool dispatch without Worker lease polling

Date: 2026-11-12. Status: accepted for implementation by the owner.
Tracking: [#35](https://github.com/cookerpapa/pi-managed-agents/issues/35).

## Decision

The Session Projector admits fixed Guest and ordinary control Tools from its
existing ordered Session stream. Ordinary control dispatch does not query Worker
lease expiry or discover Worker ownership. Resource and business mutations retain
their own PG admission and tenant checks. Pi remains the native task/abort owner.

Keep the existing ControlToolDispatcher rather than adopt a second scheduler or
effect ledger. It already observes native task changes, writer completion/seals,
partition revocation and immutable dispatch commit. The additional per-dispatch
join to `active_execution_scopes` duplicates Worker lease policy and is removed.

Cold recovery still reads the bounded native task index and exact intent commit.
It joins the owning Run once in the recovery scan to exclude old writer identities,
non-running work and a requested/completed closure before reconstructing a wait.
This is a cold current-state boundary, not a lease-clock query or a new authority.
Ordinary dispatch continues to read the exact native intent/task when necessary;
no expanded argument copy or second persistent queue is introduced.

After admission, ordered cancellation/settlement removes pending work. Partition
loss invalidates asynchronous preparation and response publication. A successful
effect whose reply publication fails retains its original result for delivery;
retrying that delivery does not depend on the originating Worker's lease clock
and never repeats the effect. Explicit Stop and native terminal settlement remain
distinct from resource retirement. An uncertain unsafe effect remains UNKNOWN.

The caller's Session projection boundary still rejects closed writer traffic.
Cold restoration must exclude old Run/writer identities even when a stale native
task index says pending. Resource close admission cannot be replaced by waiting
for a delayed Kafka notification. No fencing or physical cleanup rule changes.

## Validation and publication

Test expired/absent lease metadata with an otherwise admitted operation; cold
closed/stale owners; native abort/retired documents; duplicate intent; reply loss;
partition loss and delayed completion. Keep concrete Skill/schedule/resource
business checks. Verify the shared Session handoff and relevant real Tool paths
in the coordinated release of the authorized decoupling work.

This uses the existing Kafka, PG and Pi contracts rather than a new infrastructure
component. The current review, ADR-0247, ADR-0305 and ADR-0306 supply the adopted
ordered-dispatch, immutable-intent and original-reply mechanisms.
