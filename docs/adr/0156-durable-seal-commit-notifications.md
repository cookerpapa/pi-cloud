# ADR-0156 — Durable seal commit notifications

Status: accepted; implemented. [Acceptance](../reports/seal-commit-acceptance.md).

## Decision

Keep the in-band execution seal as the first accepted-output cutoff. Separate
that cutoff from its PostgreSQL commit acknowledgement. The canonical seal
transaction also inserts one immutable `execution_committed` notification into
the existing terminal Outbox. The existing Relay sends it to the same keyed
Kafka partition. No new service, broker, CDC deployment or browser cursor.

Gateway closes the old Attempt immediately on the seal without a database read.
It continues consuming (otherwise the later acknowledgement would deadlock).
Only that Session's subsequent public events wait behind the unresolved seal;
other Sessions/partitions continue. On the commit notification it publishes the
exact canonical terminal and releases covered memory, then releases queued
successor events in order. Duplicate notifications are idempotent. The next Run
still waits for PostgreSQL seal commit, not notification delivery or a browser.

The first seal position and terminal remain authoritative in PostgreSQL. A
duplicate seal re-arms the same immutable commit notification if already sent;
this covers a late duplicate seen by a freshly restored Gateway whose replay
floor no longer includes the original acknowledgement. A notification never
creates another notification. Outbox retries use the existing claimant CAS;
no transaction spans Kafka I/O. Only the trusted projector creates commit facts.

This removes Gateway per-seal SELECT/retry polling, not canonical transaction
I/O, recovery metadata reads, or initial conversation snapshot reads. Pending
display buffering is bounded; overflow resynchronizes from the existing durable
snapshot/replay path rather than blocking the partition that carries the ACK.
The protocol is deployed only after draining Runs, seals and the old Outbox,
using a fresh topic generation; existing conversation data is preserved.

## Adopt-before-build

Use the existing transactional Outbox and Kafka adapters. PostgreSQL
[LISTEN/NOTIFY](https://www.postgresql.org/docs/current/sql-listen.html) requires
state inspection after reconnect and cannot replace a replayable notification.
The [Debezium Outbox pattern](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
provides the same commit-before-publication contract, but deploying CDC solely
for one low-frequency message would duplicate infrastructure already present.

## Acceptance

Verify no Gateway SQL on seals/commit notifications, rollback atomicity,
commit-before-publish process loss, lost/duplicate ACKs, late old results,
successor events before confirmation, multiple Sessions and browser readers,
consumer restart/replay after the original seal, retention and bounded memory.
Compare query counts and seal-to-terminal latency against the former polling
path under normal and delayed canonical projection. Run real multi-round model
and Worker-handoff acceptance; keep model time separate from platform time.
