# ADR-0162 — Owner-routed Tool commands

Status: accepted. The original independent Broker consumer groups were replaced
by [ADR-0163](0163-direct-log-and-unified-projector.md). This document retains
only the effect-routing contract that remains current. Pre-unification consumer
benchmarks remain in Git history, not current deployment guidance.

Projector routes committed Tool commands and seals to the exact binding owner.
PostgreSQL stores immutable
Run/binding-to-Broker-boot routes before handing a binding to the Worker.
Positive lookups are cached; whole-writer closure resolves all affected owners.
This is routing metadata, not another lease or partition authority.

Internal deliveries carry log topic/partition/offset and the expected owner boot.
The receiver folds positions synchronously before acknowledging, without waiting
for guest completion. Under ADR-0183, ambiguous command delivery is not retried;
seal delivery may retry. Lower-position
replays and operation-ID reuse cannot execute another effect. A different boot
rejects delivery rather than adopting old bindings. Unconfirmed command delivery
results in UNKNOWN semantics; a failed control/seal delivery may stall its partition.

Native Tool final results return through the boot-scoped Kafka channel in
ADR-0183; temporary updates use HTTP/SSE under ADR-0184. This routing module neither retains result bodies nor consumes native
result acknowledgements. Already-started work may finish after retirement but
cannot reopen a closed invocation.

The internal dispatch secret belongs to Projectors and executors, never Workers,
Cube or browsers. Broker keeps PG Lease/fence admission, not a PG operation ledger. Log
fencing is not atomic Cube launch or exactly-once shell execution.
