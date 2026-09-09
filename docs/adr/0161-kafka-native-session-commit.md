# ADR-0161: Kafka-native Session commit

Accepted and implemented, 2026-09-09; replaces the PG receipt/cache boundary.
[Production acceptance](../reports/kafka-native-session-cutover.md).
The earlier [isolated experiment](../reports/kafka-native-session-append-experiment.md)
proved the append boundary but is not the production implementation.

The trusted Worker hosts one native log writer for every active physical Pi
Session. All Lane operations share its ordered append queue, not an Agent Loop
thread or a global queue. It assigns native IDs, parents, sequence and timestamps,
publishes complete semantic records through its direct signed log writer and
returns after Kafka ACK. PG materializes exactly those records asynchronously.
The Pi Harness sees a SessionStorage port, never Kafka or PG polling.

Bootstrap loads only the selected Lane's newest compaction and suffix, plus
the unfinished operation's intent ledger when needed. Pi's public in-memory storage/query APIs may
be used as a disposable query engine; internal bootstrap positions are never
published. Canonical stamps remain stable. Compaction and finished-Lane cleanup
release unreachable payloads. Cold history queries may wait for projection, but
ordinary model Steps do not. Unique IDs come from the active writer's namespace.

Child Lane creation uses the parent's acknowledged execution view and native
writer before the child Run becomes runnable. It never queries an unprojected
parent prompt or allocates sequence directly in PG. Interrupted visible text
is a durable recovery input attached to its terminal, then materialized through
the current writer before the next Run. Cold administrative mutations require
a quiescent physical Session under the same PG lock used by Run claim.

All facts for a physical Pi Session use one Kafka partition key, including its
Lane UI events, Tool commands and seals. Transport and unified projection follow
[ADR-0163](0163-direct-log-and-unified-projector.md). A native writer
incarnation is identified by the first RunAttempt ID of that active ownership
period; this is log identity, not another lease/credential. Every member retains
its own existing ExecutionLease and Tool admission checks.

A verified drained logical stream may seal its Run independently, preserving
normal Child completion/cancellation. An unconfirmed stream or uncertain native
append retires the whole native writer incarnation: late data must not create
a hole in the shared native sequence while sibling Lanes continue. The first
writer-closing seal is the cutoff in the unified Projector and effect receivers.
Uncertain native publication stops that writer's other Lanes, not unrelated
Sessions. New ownership waits for all affected Run seals to be projected.
Existing in-flight arbitrary shell effects remain UNKNOWN and are not replayed.

Kafka must not age out an accepted but unprojected prefix. Broker automatic
time/size deletion is disabled for the new topic generation; a cloud reaper
deletes only below PG's safe replay floor and the configured retention grace.
PG outage stops reclamation. Queue/byte bounds and storage monitoring provide
backpressure, not silent data loss. No new broker/cache/scheduler is introduced.

Adopt the pinned Pi public ports, existing Kafka clients and Kafka's native
delete-records API. Do not import private Pi SessionState or restore lifetime
JSONL. Validate stable native metadata, bounded bootstrap, Child creation with
paused projection, clean versus uncertain closure, old-writer exclusion,
duplicate/lost ACK, Compaction, frontend snapshots and paid Cube coding.
Drain and fully project the old topic before deployment; existing PG semantic
history remains usable, with no dual runtime or old-protocol fallback.

The process-fault gate exposed a lock-order inversion during stream close and
Run settlement. Stream certificates lock Attempt before Lease; heartbeats lock
member Attempts before their writer anchor, then leases, and update Worker
capacity last. Lifecycle locks use NO KEY UPDATE because identities never change.
SQL-only lifecycle transactions retry PostgreSQL-certified rollbacks (40P01,
40001), never transport/COMMIT uncertainty, model calls or Tool effects. This
follows PostgreSQL's [lock ordering](https://www.postgresql.org/docs/17/explicit-locking.html)
and [complete-transaction retry](https://www.postgresql.org/docs/17/mvcc-serialization-failure-handling.html)
guidance; the Agent Loop is not executed again to retry settlement.

The same acceptance found a stranded expired lease on a still-healthy Worker.
Maintenance now retires expired leases independently of boot liveness, under
the same conditional lease/seal authority. Other Sessions on that Worker remain
active. Public Run completion waits for canonical seal visibility. This is cloud
reconciliation, not another Harness persistence barrier or model replay.
