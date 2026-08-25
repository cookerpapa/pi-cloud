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

## Single-node result

Revision `5d84c5ae9738b06b91abefc222d2874766294e1a` ran 64 Sessions with 32
events each (2,048 logical events), a 256-byte target payload and 256 idle
per-Session Gateway readers on the same 32-logical-CPU, 15.46-GiB WSL2 host.
Every backend preserved Session order and recovered the acknowledged sentinel
after its broker process was killed with `SIGKILL` and restarted on the same
persistent Volume. This was not a host-power-loss or replicated-failover test.

| Backend | Acked publish | Ack p95 | Projection p95 | Focused replay scan |
| --- | ---: | ---: | ---: | ---: |
| Kafka | 821.83/s | 225.17 ms | 503.57 ms | 47.56x |
| Valkey AOF everysec | 31,606.65/s | 3.41 ms | 153.65 ms | 1x |
| Valkey AOF always | 4,378.98/s | 18.83 ms | 1,146.50 ms | 1x |
| NATS JetStream | 15,625.37/s | 6.79 ms | 8.51 ms | 1x |

The absolute Kafka result includes a new single-node topic and is lower than a
separate warm production-topic acceptance run; it must not be used as a Kafka
capacity claim. The 47.56x focused-read amplification is the more useful
structural observation: Kafka can order a Session key within one partition but
cannot ask the broker to return only that key, which is why the current Gateway
builds a per-Session projection.

Valkey provided the fastest direct Session read. Its simple path used one
Stream key and one blocking connection per reader: 256 readers added 256
connections, about 4.5 MiB of broker memory and roughly 488 ms of setup time.
The same key-per-Session design makes a horizontally sharded global projector
less natural. Under the stronger local `appendfsync always` setting, publish
throughput fell by about 86% from the `everysec` result, and the benchmark's
multi-Stream projector became the slowest projection path.

JetStream was the best semantic fit in this experiment. One file-backed Stream
accepted all Session Subjects; a global ordered consumer projected every event,
while an exact Subject filter replayed 32 focused events after scanning exactly
32. Creating 256 ephemeral filtered consumers took about 71 ms. Account-level
memory counters did not expose their metadata cost, so a sustained 2,000+
connection test is still required.

## Current conclusion

JetStream is the leading candidate for a second, production-shaped spike—not a
production decision yet. The next experiment must use three NATS nodes with an
R=3 file Stream, a real authenticated SSE Gateway, PostgreSQL canonical
projection and forced leader/projector/Gateway loss.

The current Kafka raw-to-accepted boundary cannot simply disappear. It prevents
a stale RunAttempt from making events visible. A JetStream cutover must either
retain a stateless authority-validating ingest boundary before the sole durable
Stream or prove an equivalent attempt-scoped publish capability and revocation
contract. Only then can PiCloud compare the resulting code and operational
surface with the corrected Kafka projection.

The generated measurements are in
[`streaming-backend-comparison-latest.md`](../reports/streaming-backend-comparison-latest.md)
and its JSON companion.
