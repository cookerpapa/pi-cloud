# ADR-0160: Kafka-native Session append experiment

Experimental, 2026-09-08. **Not the deployed SessionStorage protocol.**

The proposed boundary is a backend-neutral Harness append which completes on
Kafka replication ACK, without waiting for PostgreSQL projection. A single
physical Session writer owns all Lane heads and native metadata. It publishes
fully materialized native records; PostgreSQL applies those records without
assigning different parents, sequence numbers or timestamps. Reads see only
acknowledged state. An uncertain append poisons that writer, rather than rolling
back memory and reusing an uncertain sequence. Recovery closes the old writer
and waits for its projection before admitting a replacement.

Use Pi 0.84.1's public `InMemorySessionStorage` and `Session` APIs in an isolated
experiment, not a fork of its Agent Loop or an import of private SessionState.
Its public in-memory backend has no bounded snapshot-import API; experimental
recovery replays the small fixture log through public methods and preserves the
original stamps. This is not a production full-history download fallback.

Adoption evidence: the pinned Pi public memory implementation and backend
conformance suite define one Session sequence across Lanes. Kafka documents
[producer acknowledgement separately from consumer progress](https://kafka.apache.org/41/design/design/#message-delivery-semantics).
Existing Platformatic and Confluent transports are sufficient; no additional
broker, state store or scheduler is introduced.

The production cutover also needs a single ordering contract for direct PG
writers: Child Lane creation, tree pruning and seal-time interrupted-prefix
repair. A Child's repair can currently allocate a Session sequence while its
Parent is still active. Subagent startup also looks up the parent's prompt in
PG. Do not enable the experiment for ordinary users until those paths, bounded
bootstrap and recovery across owners share the same committed prefix.

The experiment must compare identical workloads with and without projection
wait, excluding model latency; stop/restart projection; reject uncertain
append continuation; exercise multiple native Lanes and Compaction; retain
tool intent before effects. Production stays on ADR-0159 during this test.
