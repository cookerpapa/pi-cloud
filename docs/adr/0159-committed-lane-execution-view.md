# ADR-0159: committed Lane execution view

Accepted and implemented, 2026-09-08. [Acceptance and barrier assessment](../reports/committed-lane-view-acceptance.md).

Keep Kafka publication and PostgreSQL projection/receipt as the write boundary.
Cache only the bounded active branch for one Run/Lane; do not introduce another
SessionStorage implementation or an optimistic conversation authority.

The Run-scoped mutation publisher observes successful PG receipts, including
confirmed Entry IDs and server-assigned parents, sequence and timestamps. Both direct
Session API writes and combined checkpoint writes pass through that publisher.
It incrementally updates a materialized Lane path. New Steps read a private copy
of this path rather than querying PostgreSQL again. Compaction replaces the path
with its native summary/retained-tail Entry. Other Lanes and operation Records
do not mutate this Lane's context. A move or unexpected parent invalidates the
view; reads racing a commit reload before returning a snapshot.

Cold Run start, cache invalidation and Worker replacement read PostgreSQL. End of
Run drops retained context. No failed/unacknowledged mutation updates the cache;
no Tool starts before its existing durable intent barrier. Model/provider
transforms cannot mutate cached committed entries. Ordinary SessionStorage queries
and backend conformance remain unchanged.

Use Pi's public [SessionStorage/Entry/Lane contract](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/session/types.ts)
and existing mutation receipts. A small read materialization is preferable to
replaying writes into a second in-memory Session backend with independently
assigned metadata. Validate branching, Compaction, Steer, retry/interruption,
failed commits, ownership replacement and clone isolation. Compare storage reads,
bytes and model-free read latency, then real paid coding. Evaluate removing PG
barriers separately; do not infer that a read cache makes asynchronous projection
correct by itself.

Broker sharding is a separate decision: current Session-keyed partitions do not
match Workspace-owned runtimes when Sessions share or switch Workspaces. A shared
consumer group plus owner routing adds an internal RPC and needs explicit approval.
