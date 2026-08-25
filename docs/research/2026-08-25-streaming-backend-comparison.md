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
production decision yet. That follow-up is implemented under
`spikes/streaming-backend-comparison/production-shape/`: three NATS nodes with
an R=3 file Stream, an authenticated SSE Gateway, PostgreSQL canonical
projection and forced Leader/Projector/Gateway loss. It also creates up to
2,000 sustained Session-filtered SSE connections. Its measurements are kept
separate from the transport-only table above.

The current Kafka raw-to-accepted boundary cannot simply disappear. It prevents
a stale RunAttempt from making events visible. A JetStream cutover must either
retain a stateless authority-validating ingest boundary before the sole durable
Stream or prove an equivalent attempt-scoped publish capability and revocation
contract. Only then can PiCloud compare the resulting code and operational
surface with the corrected Kafka projection.

## Production-shape result

Revision `5dd15883ae5b96c63b9df9453574daa43044db2e` ran a three-node NATS
cluster with an R=3 file Stream, a PostgreSQL-backed authority-validating Event
Ingest, a durable explicit-ACK PostgreSQL Projector and an authenticated HTTP
SSE Gateway.

The first design assigned one filtered ordered JetStream Consumer to every SSE
connection. It reached 2,000 connections at about 158.5 MiB Gateway RSS, but
created 2,001 broker Consumers and needed about 29.3 seconds to publish and
deliver one event to every Session. A preceding run also left one of 2,000
connections waiting until its cursor was replayed. This model was rejected.

The corrected design uses JetStream `RePublish`: after a successful Stream
write, NATS republishes the committed event onto a separate Core NATS subject.
Every Gateway replica needs only one wildcard subscription and routes those
messages to its local authenticated SSE connections. A temporary filtered
ordered Consumer exists only while a reconnecting browser catches up from its
durable Stream sequence. NATS documents RePublish specifically for high-scale
live delivery where a dedicated Consumer per subscriber is too expensive:
<https://docs.nats.io/nats-concepts/jetstream/streams#republish>.

Under that shape:

- 2,000/2,000 sustained SSE connections received their Session event;
- the only steady JetStream Consumer was the PostgreSQL Projector;
- Gateway RSS was 78.48 MiB at 250 connections and 117.54 MiB at 2,000;
- 2,000 publishes completed in 2,624.2 ms and buffered browser reads completed
  in another 85.37 ms, or 737.42 end-to-end events/s for this synchronous
  authority-query plus R=3 PubAck workload;
- the p95 time to establish the final 1,000 connections was 75.14 ms;
- killing the Stream Leader elected a replacement, preserved the existing SSE
  delivery and restored all replicas; publish plus delivery took 4,307.67 ms
  during that forced election;
- killing the Gateway preserved two missing events and replayed them in order
  from the browser cursor;
- killing the Projector after PostgreSQL commit but before broker ACK caused
  redelivery and still produced exactly one canonical message row;
- an event carrying the superseded Attempt/Fence was rejected before entering
  the browser-visible Stream;
- PostgreSQL stored the complete Assistant message and terminal record, not
  the three preceding text fragments.

This validates the event topology, not a production cutover. The measured
737.42 events/s burst is bounded primarily by one PostgreSQL authority query
and one synchronous R=3 PubAck per event. A 2,000-active-Agent target can
produce substantially more than that if each model emits several coalesced
updates per second. The next gate is therefore Session/Attempt-scoped batch
validation and asynchronous bounded PubAck collection, followed by multiple
subject-sharded Streams if one Stream Leader remains the write bottleneck.
TLS, NATS accounts/permissions, multi-Gateway fanout, retention expiry,
canonical-cursor reload and Kubernetes failure-domain placement also remain
production work.

The full result is in
[`jetstream-production-shape-latest.md`](../reports/jetstream-production-shape-latest.md)
and its JSON companion.

The generated measurements are in
[`streaming-backend-comparison-latest.md`](../reports/streaming-backend-comparison-latest.md)
and its JSON companion.
