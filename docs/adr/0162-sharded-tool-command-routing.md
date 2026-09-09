# ADR-0162 — Owner-routed Tool commands and direct results

Status: accepted. The original independent Broker consumer groups were replaced
by [ADR-0163](0163-direct-log-and-unified-projector.md). This document retains
only the effect-routing contract that remains current. The
[earlier report](../reports/tool-command-sharding.md) describes the pre-unification
topology and is not a current throughput/consumer-count claim.

Projector routes already-admitted Tool commands, native-result acknowledgements
and seals to the exact binding owner. PostgreSQL stores immutable
Attempt/binding-to-Broker-boot routes before handing a binding to the Worker.
Positive lookups are cached; whole-writer closure resolves all affected owners.
This is routing metadata, not another lease or partition authority.

Internal deliveries carry log topic/partition/offset and the expected owner boot.
The receiver folds positions synchronously before acknowledging, without waiting
for guest completion. Lost delivery ACKs retry the same record. Lower-position
replays and operation-ID reuse cannot execute another effect. A different boot
rejects delivery rather than adopting old bindings. An unreachable live owner
stalls its source partition; a stopped owner results in UNKNOWN semantics.

Worker GETs retrieve raw results directly from the actual executor. The routing
module does not retain or return result bodies. Pi's final native result retires
the owner retry copy; seals also release orphaned copies. Already-started work
can finish after retirement but cannot repopulate closed state.

The internal dispatch secret belongs to Projectors and executors, never Workers,
Cube or browsers. Broker keeps PG Lease/fence and operation admission. Log
fencing is not atomic Cube launch or exactly-once shell execution.
