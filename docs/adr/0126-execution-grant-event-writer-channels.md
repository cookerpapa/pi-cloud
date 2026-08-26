# ADR-0126: ExecutionGrant event-writer channels

## Status

Superseded by ADR-0127 on 2026-08-26. This file records the event-only channel
step that removed the Agent-event microbatch; it is not the current ingress
contract. The maintained path uses one FactChannel and one Authority Gate for
both Agent events and Pi Session mutations.

## Context

The first JetStream production path sent one authenticated HTTP request per
Agent event into a process-global two-millisecond Authority queue. One flush
locked up to 256 PostgreSQL Grant rows, published every accepted event with its
own R=3 PubAck, advanced the watermarks and committed before the next flush
could start. On the named single-host benchmark this exact Worker path sustained
about 579 one-KiB events/s. Increasing HTTP concurrency beyond 64 raised ACK
tail latency without increasing short-run throughput.

Application microbatching is not the desired default remedy. It deliberately
waits for more bytes, fragments the same policy across Worker, Gateway and
broker boundaries, and makes low-latency streaming depend on queue occupancy.
The invariant that actually requires serialization is narrower: events under
one ExecutionGrant are ordered, while independent Grants may publish in
parallel.

Three maintained alternatives were considered:

- direct NATS clients in Workers remove the HTTP hop but give every Worker a
  broker credential and route, weakening the existing trusted-ingest boundary;
- a new gRPC service provides a mature streaming transport but adds a second
  RPC schema/toolchain where PiCloud already operates bounded WebSocket
  transports;
- the existing Fastify WebSocket and `ws` stack can provide one authenticated,
  backpressured channel per active Grant without adding infrastructure.

The third option is the smallest fit. JetStream remains the durable event log;
the channel is transport and live writer ownership, never another event store.

## Decision

Every active Run opens one `EventWriterChannel` after PostgreSQL issues its
opaque ExecutionGrant and before Pi starts. The service-authenticated WebSocket
is bound to exactly one Grant, Session and Turn. Opening it performs one exact
PostgreSQL authority check and records a short writer lease on the same
`execution_grants` row.

The writer lease contains a random connection ID, the owning Control Plane
instance, and an expiry shorter than the Run Grant. It is renewed independently
of event frequency. A current, unexpired writer prevents Grant release or
replacement. Normal Run settlement closes the writer and advances its
PostgreSQL watermark before terminal state releases the Grant. Gateway or
Worker loss leaves only the short lease; after it expires the ordinary Grant
retirement path may continue.

Within a channel:

```text
validate local Grant binding and contiguous Session sequence
→ publish one accepted event to the Session JetStream Subject
→ wait for that event's R=3 PubAck
→ return its Event ACK on the same socket
```

There is no intentional Gateway batching delay and no process-global flush.
Each channel permits one ordered event in flight, while channels for different
Grants publish concurrently. JetStream and the operating system may perform
transparent group commit; that does not delay an event to fill an
application-owned batch.

The accepted JetStream envelope contains no bearer Grant. On initial open or
reconnect, the Gateway compares the PostgreSQL watermark with the last retained
message on the exact Session Subject. This reconciles a PubAck that survived a
Gateway crash before the periodic or closing watermark update. A retry with the
same Event ID is acknowledged through JetStream deduplication; a gap or a
different Event at an already durable sequence is rejected.

Pi Session mutations remain low-frequency semantic operations on their
separate accepted log. Their projection barrier and set-oriented PostgreSQL
Authority are not coupled to the browser text transport.

## Failure semantics

- stale or expired Grant at channel open: reject before JetStream;
- old writer still live: refuse another writer and do not replace the Grant;
- Gateway loses PostgreSQL: stop the channel before its local writer deadline;
- Gateway dies after PubAck: reconnect reads the exact Session tail and safely
  acknowledges or retries the same Event ID;
- Worker dies: its socket closes; cleanup advances the observed watermark and
  clears ownership, with writer-lease expiry as the crash fallback;
- cancellation races an Event: terminal release waits for channel close or
  expiry, so the newer generation never overlaps the older writer;
- JetStream Leader loss: the channel retries the same stable Event identity
  within its bounded delivery deadline.

PostgreSQL unavailability prevents opening or renewing writers, matching its
role as the sole Run authority. An already acknowledged JetStream event remains
durable and browser-replayable.

## Consequences and acceptance

The hot path no longer performs a PostgreSQL transaction per event or per
two-millisecond microbatch. PostgreSQL work follows active writer lifetime and
heartbeat instead of token-fragment frequency. The Gateway holds one small
state object and WebSocket per active Run; cold Sessions consume neither.

This changes takeover behavior intentionally: an unconfirmed old writer may
delay replacement until its short lease expires, rather than allowing two
generations to overlap. Writer count, renewal failures, lease expiry, PubAck
latency and reconnects must be observable.

Acceptance requires protocol and migration contracts, stale-writer and
reconnect fault tests, unchanged `V implies J`, and a repeated exact Worker →
R=3 JetStream benchmark on the same topology used by ADR-0122.
