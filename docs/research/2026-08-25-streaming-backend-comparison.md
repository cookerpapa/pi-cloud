# Streaming backend comparison

## Question

Can PiCloud remove the accepted-Kafka-to-in-process replay projection while
preserving these invariants?

1. A browser never receives bytes that have not entered the configured durable
   hot-event authority.
2. Events for one Session remain ordered and resumable from an explicit cursor.
3. PostgreSQL receives complete Pi messages and terminal state through an
   idempotent projector, without storing token fragments.
4. Stale RunAttempt authority cannot become visible or canonical.
5. A Gateway restart does not require a lifetime conversation scan.

The browser cannot safely connect to any candidate broker directly. An
authenticated SSE/WebSocket Gateway remains mandatory; the comparison asks
whether that Gateway can be a stateless filtered reader rather than a custom
replay cache.

## Candidates

### Kafka

Kafka is the current bounded hot-event authority. Session-keyed production
preserves order within a partition and provides an efficient global projector,
but Kafka has no server-side per-key subscription. A browser Gateway either
scans interleaved partition records or maintains a Session-indexed projection.

### Valkey Streams

One Stream key per Session gives the simplest browser path: `XREAD BLOCK` can
resume directly from the last Stream ID. The tradeoff moves to the global
projector: it must discover and consume many dynamic keys, and multi-key reads
become shard-aware under Valkey Cluster. Persistence also depends on the chosen
AOF/RDB, fsync and replication policy.

### NATS JetStream

One file-backed Stream can capture Session-specific Subjects. A filtered
ordered consumer gives the browser one Session while a durable pull consumer
projects every Subject. This is the closest semantic match to one publication
with two parallel consumers, but introduces a less familiar broker and
per-connection ephemeral-consumer cost.

## Experiment

The isolated spike under `spikes/streaming-backend-comparison/` uses pinned
single-node brokers, identical payloads, Session counts and event counts. It
records publish acknowledgement latency, full projection drain, focused replay
scan amplification, ordering, restart recovery and implementation-state
requirements. Valkey is measured under both AOF `everysec` and `always`, since
an ordinary `XADD` acknowledgement under `everysec` does not prove the entry
was fsynced before browser visibility. Results must name the tested revision
and host; they cannot be used as replicated-failover claims.

No production decision is made by this note. Adoption requires measured
benefit large enough to delete the existing raw/accepted projection machinery,
plus a separate ADR covering authority validation, migration and rollback.
