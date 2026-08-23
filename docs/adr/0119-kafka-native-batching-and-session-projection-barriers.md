# ADR-0119: Kafka-native batching and Session projection barriers

## Status

Accepted on 2026-08-23. This refines ADR-0116 without changing its three
authorities: PostgreSQL owns Run and canonical Pi Session state, Accepted Kafka
owns the bounded hot browser stream, and the persistent Cube Volume owns
Workspace bytes.

## Context

After the Kafka-first cutover, the Worker still placed each event publication
behind an application queue with eight shards, a four-millisecond timer and a
64-publication group. The native Kafka producer already uses `linger.ms`,
idempotent production, compression and `acks=all`; its accumulator combines
concurrent sends by partition. Keeping a second group-commit scheduler added
queue limits, retry splitting and shutdown flushing without creating another
durability boundary.

Pi Session mutations have a different requirement. A replacement Worker must
not restore PostgreSQL SessionStorage while an earlier Worker's broker-acked
mutation is still waiting in the Session-mutation topic. Waiting for every
Kafka consumer is both unnecessary and incorrect: the browser Gateway and the
canonical PostgreSQL projector have independent recovery duties.

## Decision

### Before Kafka

- Adjacent Assistant text remains coalesced for at most 100 ms or 4 KiB. This
  is event-rate and rendering control, not durable group commit.
- A Worker calls the native Kafka producer directly. Kafka owns linger,
  partition batching, LZ4 compression, retries and replicated acknowledgement.
- The retired `event.publish_batch` wire shape and application
  `GroupedDurableEventIngestor` are removed. One public publication has one
  Session identity and one logical sequence.
- Raw records still pass the PostgreSQL authority projector before entering
  Accepted Kafka. A raw broker ACK alone never makes stale Worker output
  visible.

### Canonical Session recovery barrier

Every active Run receives a scoped Pi Session mutation publisher. Before a
Worker reads SessionStorage, it appends a `projection_barrier` marker using the
same Session key as native Pi mutations and waits for the PostgreSQL projector
to acknowledge that marker.

Kafka preserves order within the marker's partition. Therefore, when the
marker completes, every earlier record for that Session has reached a terminal
projection outcome: it was applied idempotently or rejected by its stale
execution fence. The new Worker then rechecks its own authority and reads
PostgreSQL. A stale Worker cannot make a later mutation valid merely by
arriving after the marker because every mutation is independently fenced.

This is a projection barrier, not an attempt to drain the whole topic, wait for
the browser, or expose Kafka offsets through the product API.

### After Kafka

- The PostgreSQL Session projector commits its consumer offset only after the
  idempotent mutation result is durable. On restart it resumes from that
  committed offset.
- Every Control Plane Gateway maintains its own Accepted-Kafka consumer and
  rebuilds a bounded recent suffix before becoming ready. Gateway failure does
  not alter canonical Pi state or Worker recovery.
- The conversation response includes one PiCloud logical
  `replayAfterSequence`. The browser renders canonical PostgreSQL Turns, then
  resumes SSE after that sequence. Kafka topic/partition offsets remain an
  internal transport coordinate.
- A failed Run may have Accepted text without a complete Pi `message_end`.
  Terminal reconciliation projects that bounded visible prefix plus one abort
  fact into Pi context. Arbitrary Tool effects remain `UNKNOWN` and are never
  inferred from stream records.

## Crash rules

```text
Worker loss
  -> expire and fence the old connection/Attempt authority
  -> best-effort physical stop; a dead endpoint cannot block logical retirement
  -> settle the interrupted Run and return the Session to idle
  -> next Run appends Session projection barrier
  -> all older Session mutations are applied or rejected
  -> recheck new fence
  -> read PostgreSQL SessionStorage

PostgreSQL projector loss
  -> Kafka retains Session mutations
  -> consumer restarts from committed offset
  -> idempotent mutation IDs absorb redelivery

Gateway loss
  -> replacement seeks the retained Accepted suffix
  -> rebuild before readiness
  -> browser reconnects with PiCloud logical sequence
```

## Consequences

- Kafka has one batching layer instead of an application scheduler plus its
  native accumulator.
- Worker recovery waits only for the state it will read, not unrelated
  presentation consumers.
- Once the heartbeat and execution lease are expired, inability to call a dead
  Worker's management endpoint does not keep a Session permanently running.
  The durable fence is the correctness boundary; the old process is never
  adopted or trusted again.
- The public cursor contract becomes one logical Session sequence over a
  canonical PostgreSQL prefix and an Accepted-Kafka suffix.
- The Session marker adds one low-frequency Kafka/PG round trip per Run. This
  is accepted because it replaces an ambiguous recovery race, while token
  deltas no longer incur application group-commit scheduling.
