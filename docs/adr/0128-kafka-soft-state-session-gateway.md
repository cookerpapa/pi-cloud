# ADR-0128: Kafka accepted-fact log and soft-state Session Gateway

## Status

Accepted on 2026-08-26. This supersedes the JetStream transport, replay and
browser-cursor portions of ADR-0111, ADR-0122, ADR-0125, ADR-0126 and ADR-0127.
ADR-0127's single PostgreSQL ExecutionLease Gate and lease-free AcceptedFact
boundary remain current.

## Context

The prior browser protocol exposed a logical event cursor through
`Last-Event-ID`. A Gateway reconnected by constructing temporary per-Session
JetStream consumers and replaying from that cursor. This was correct, but made
the broker responsible for both accepted-fact durability and browser-specific
replay semantics.

The product needs a simpler public contract: a browser asks for the current
Session view without supplying a cursor. It first receives PostgreSQL canonical
messages plus any incomplete Assistant/Tool tail, then receives only facts that
arrive after that snapshot. Refresh replaces the view from a new snapshot
instead of replaying characters from an old browser watermark.

## Decision

One Kafka topic keyed by opaque Session ID is the only AcceptedFact durable
append log. It carries Agent events and complete Pi Session mutations. The
Authority Gate publishes one lease-free AcceptedFact and acknowledges the Worker
only after Kafka `acks=all`. Kafka partition order, stable Fact IDs and consumer
idempotency are downstream concerns. No application microbatch precedes Kafka;
the maintained client may use its native producer aggregation.

Gateway replicas run two projections:

```text
accepted-facts topic
├── canonical projector consumer group
│   └── complete Pi mutations / terminal facts -> PostgreSQL
└── replica-local live consumer
    └── ordered incomplete Session tail -> in-memory soft state -> browser SSE
```

The canonical projector group distributes each Kafka partition to one replica.
PostgreSQL writes are idempotent by Fact identity. Its transaction advances the
Session canonical boundary and emits a small PostgreSQL notification after
commit. Every Gateway uses that committed boundary to unload covered live
fragments. A missed notification is harmless because connection open and a
periodic sweep reconcile against PostgreSQL.

Each Gateway replica receives the accepted-fact feed into a replica-local live
cache. This multiplies broker reads by the small Gateway replica count, but lets
any replica answer any authenticated Session request without Session routing.
The cache contains incomplete active Turns only; it is not an authority.

The public SSE request has no cursor header or query parameter. Under a
Session-scoped short mutex the Gateway registers the live subscriber and takes
an immutable snapshot of the current tail. It releases the mutex before network
I/O. The first SSE frame replaces the browser view with:

```text
PostgreSQL canonical conversation
+ materialized incomplete live tail
```

Later frames carry new events. The connection keeps a private transient
subscription boundary, but the browser neither sends nor stores it. Kafka
offsets and Pi event sequence numbers remain internal because ordering, replay
after process loss and deduplication are impossible without them.

Cache unloading uses pointer replacement rather than a long-lived read lock.
An open request owns its immutable snapshot and every connection owns a bounded
send queue. Advancing the canonical boundary removes covered fragments from the
Session index; existing snapshots remain valid until JavaScript garbage
collection reclaims them. A slow connection that exhausts its queue is closed
and obtains a fresh snapshot on reconnect instead of pinning shared memory.

## Recovery semantics

- Worker failure before Kafka ACK: the Fact is not visible and may be retried
  with the same identity.
- Worker failure after Kafka ACK: Kafka retains the Fact; projectors resume from
  their committed offsets.
- canonical projector failure: PostgreSQL idempotency absorbs redelivery before
  the Kafka group offset advances.
- Gateway failure: the browser reconnects without a cursor; PostgreSQL supplies
  canonical messages and the Gateway rebuilds the active tail from Kafka after
  the stored canonical Kafka boundary.
- browser failure: reconnect returns a replacement snapshot, not an animated
  replay of the previously displayed prefix.
- Kafka unavailable: the Authority Gate cannot return a durable receipt, so the
  browser cannot observe the uncommitted output.

## Consequences

The Gateway is operationally stateful but durably stateless: memory contains
reconstructible soft state and active sockets, while Kafka and PostgreSQL remain
the authorities. The frontend loses `Last-Event-ID`, cursor-expiry and replay
code. JetStream Streams, RePublish, exact-Subject replay consumers and their
deployment topology are removed rather than retained as compatibility paths.

