# ADR-0122: JetStream event authority and batched Run capability validation

## Status

Accepted on 2026-08-25. This replaces ADR-0116 and ADR-0119.

## Context

The Kafka-first path durably wrote every Worker event to a Raw topic, queried
PostgreSQL for the complete Run/Attempt/Lease/Fence identity, wrote the event a
second time to an Accepted topic, updated the Attempt watermark and made the
Worker poll PostgreSQL for acceptance. Every Control Plane replica then rebuilt
a Session-indexed memory projection because Kafka cannot subscribe by record
key. A terminal event could fold that projection before a connected SSE reader
had consumed the same broker batch.

The required boundary is simpler: stale Worker output must not become visible;
visible bytes need one durable ordered copy; complete Pi messages, not token
fragments, become canonical PostgreSQL conversation state.

## Decision

NATS JetStream is the only bounded hot event authority. The production Stream
uses file storage, three replicas, per-Session Subjects, time/size retention,
stable message IDs and committed RePublish.

Workers do not receive NATS credentials for browser-visible events. They send
their existing short-lived Run capability—Run, Attempt, Lease ID and Fencing
Token—to a service-authenticated Control Plane Event Ingest endpoint. The
ingestor groups up to 256 concurrent publications for at most two milliseconds.
One PostgreSQL transaction locks the affected Run, Attempt, Session, Turn,
command and lease authority rows, loads them with one set query, publishes
valid events in parallel and advances every accepted Attempt watermark with one
set update before commit. A replacement Attempt therefore cannot cross the
broker-write boundary while an older batch is in flight.
Each caller resolves only after its own JetStream PubAck. A retry reuses the
stable event ID and is absorbed by JetStream deduplication.

This is authorization batching, not a second durability queue. No timer or
application buffer acknowledges a publication before JetStream.

After a successful Stream write, JetStream republishes the event to a separate
Core NATS subject. Each Gateway replica holds one wildcard Core subscription
and only a bounded queue for its actual HTTP connections. It does not retain a
lifetime or per-Session replay projection. A broker disconnect triggers public
SSE resynchronization. Reconnect reads use a temporary exact-Subject ordered
consumer and the PiCloud logical Session sequence; cursors already replaced by
canonical PostgreSQL state receive HTTP 410 and reload the complete transcript.

Pi SessionStorage mutations use a separate Session-keyed JetStream Stream and
one replicated durable explicit-ACK Projector. The existing mutation result and
projection-barrier contract remains: a replacement Worker reads PostgreSQL only
after every preceding Session mutation is applied or fenced.

Terminal Run state and its generic outbox row still commit transactionally in
PostgreSQL. The relay publishes the terminal event to JetStream idempotently.
Arbitrary Tool effects remain non-replayable and may settle as `UNKNOWN`.

## Failure semantics

- Event Ingest unavailable: the Worker retries the same event ID and fails the
  Run closed after a bounded deadline; unseen bytes are never reported as ACKed.
- stale Attempt/Fence: the set authority query rejects it before JetStream, SSE
  and canonical projection.
- Event Ingest crash after Stream commit but before HTTP response: retry returns
  a duplicate PubAck and advances the same Attempt watermark.
- Gateway crash: JetStream retains the exact Session subject; a replacement
  Gateway does not need the previous process memory.
- Projector crash after PostgreSQL commit but before ACK: the durable consumer
  redelivers and PostgreSQL mutation IDs make the semantic effect idempotent.
- Stream Leader loss: R=3 elects a replacement; stable publish IDs make retry
  safe.

## Evidence and consequences

The production-shaped spike sustained 2,000 authenticated SSE connections with
one steady JetStream Consumer and 2,000/2,000 Session deliveries. On the named
single-host topology, transaction-scoped authority batching reduced 8,192
events to 32 authority transactions and reached about 1,380 events/s, versus
about 95 events/s for the same per-event boundary. Gateway, Projector and
Stream Leader loss recovered without duplicate canonical messages. The report is
[`jetstream-production-shape-latest.md`](../reports/jetstream-production-shape-latest.md).

Kafka services, native bindings, raw/accepted topics, Gateway memory projection
and Kafka-specific configuration are removed. Historical database migrations
keep their original names because a fresh database must replay history.

The single Stream Leader remains a write-scaling boundary. A future measured
need may shard Subjects across several deployment-owned Streams without
changing the public SSE or Pi Session contract.
