# ADR-0161: Kafka-native Session commit

Accepted and implemented, 2026-09-09; replaces the PG receipt/cache boundary.
[Validation matrix](../EVALUATION.md).
Image bytes are externalized under [ADR-0192](0192-session-image-attachments.md).
PG log plus retained S3 objects reconstructs the exact native records; only the
storage representation changes, not the writer or acknowledgement boundary.
The earlier isolated experiment (archived in Git before this production cutover)
proved the append boundary but is not the production implementation.

The retained invariant is one native writer for every active physical Pi Session
and Kafka acknowledgement before adopting a write. The original direct producer
and `SessionStorage` implementation were replaced under ADR-0209/0229; current
publication and closure follow [ADR-0247](0247-session-work-and-tool-dispatch.md).
The Worker stamps Durable atomic batches through Pi's public `Storage` port
and publishes directly with a stable physical-Session Kafka producer identity.
All native Conversations share its ordered writer. PG materializes those
exact batches asynchronously; no ordinary model Step waits for a PG receipt.

Current bootstrap reads the selected native head/Compaction and suffix, and indexed
native task/document recovery state. There is no separate unfinished-Tool operation
ledger and no lifetime JSONL replay. The bounded acknowledged Storage overlay is
disposable; canonical IDs and commit sequence remain stable across projection.

Child Conversation creation uses the parent's acknowledged execution view and native
writer before native child execution starts. No child cloud Run is created. It never queries an unprojected
parent prompt or allocates sequence directly in PG. Interrupted visible text
is a durable recovery input attached to its terminal, then materialized through
the current writer before the next Run. Cold administrative mutations require
a quiescent physical Session under the same PG lock used by Run claim.

All facts for a physical Pi Session use one Kafka partition key, including its
Lane UI events, Tool commands and seals. Transport and unified projection follow
[ADR-0163](0163-direct-log-and-unified-projector.md). A native writer
incarnation is identified by its Session lease ID (ADR-0180), not a first task.
Members share one
physical-Session owner lease and carry separate task references for admission,
as specified by [ADR-0167](0167-session-family-capacity.md).

Native child completion/cancellation does not seal a writer. Normal root work
publishes `work_finished` after its native family settles. An uncertain native
append retires the whole native writer incarnation: late data must not create
a hole in the shared native sequence while sibling Lanes continue. The first
writer-closing seal is the cutoff in the unified Projector and effect receivers.
Uncertain native publication stops that writer's other Lanes, not unrelated
Sessions. New ownership waits for its one ordered Session closure to project.
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

Run settlement and projection lock the Run before its shared owner evidence;
heartbeats lock the Session lease, without touching task or Worker-capacity rows.
Lifecycle locks use NO KEY UPDATE because referenced identities never change.
SQL-only lifecycle transactions retry PostgreSQL-certified rollbacks (40P01,
40001), never transport/COMMIT uncertainty, model calls or Tool effects. This
follows PostgreSQL's [lock ordering](https://www.postgresql.org/docs/17/explicit-locking.html)
and [complete-transaction retry](https://www.postgresql.org/docs/17/mvcc-serialization-failure-handling.html)
guidance; the Agent Loop is not executed again to retry settlement.

The same acceptance found a stranded expired lease on a still-healthy Worker.
Maintenance now retires expired leases independently of boot liveness, under
the same conditional lease/seal authority. Other Sessions on that Worker remain
active. Public Run completion waits for projected work-finished or forced-closure evidence. This is cloud
reconciliation, not another Harness persistence barrier or model replay.
