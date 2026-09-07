# ADR-0155 — Isolated consumption and bounded handoffs

Status: accepted; implemented. See [acceptance](../reports/isolated-handoffs-acceptance.md).

## Decision

Keep PostgreSQL business/Pi authority, Kafka AcceptedFacts, Cube Volumes and
the two pre-Tool durability barriers. Address the measured handoff costs without
adding a broker, scheduler, resident guest controller or browser cursor.

* Persist the first Kafka seal position with Attempt closure. Live readers must
  distinguish records before and after that position even when PG projection is
  ahead of them. A currently-closed boolean cannot classify historical records.
* Use a maintained consumer with partition-local flow control. Platformatic
  2.9/2.11 exposes whole-stream pause but no public partition pause/seek contract.
  Adopt Confluent's pinned JavaScript consumer (MIT, with librdkafka) behind the
  existing consumer adapter; retain the already-tested Platformatic producer.
  Kafka owns bounded per-partition buffering, assignment and flow control.
  Remove the global 256-promise queue rather than making it unbounded.
  Resolved consumer offsets are committed in the native background thread for
  monitoring; they add no ACK to the processing path and never replace PG recovery floors.
* Record a compact per-partition canonical recovery position with semantic/seal
  commits, never per text delta. Recovery starts at the minimum of this position
  and recorded unsealed Attempt starts. Capture Kafka end positions before reading
  PG recovery state; do not skip unobserved in-flight records. Retention gaps fail
  closed. Gateway startup must not replay every closed historical execution.
* Keep API/ingest availability separate from projection/tail replay readiness.
  A Session stream waits for its required replay before snapshot creation.
  Live partitions are retained only while browser subscriptions need them;
  reopening seeks the current recovery floor and reconstructs an immutable
  snapshot. This avoids idle full-topic consumption without adding a routing tier.
* Batch already-present native append items at the SQL level: lock Lane heads,
  reserve a sequence range, check IDs/operation attribution and insert log/query
  projections atomically. Preserve native ordering, rollback and idempotency.
  This adds no batching delay and no cross-Run transaction.
* Bound Worker claim probes by queue kind rather than free Slot count. Keep
  same-Session order, shared physical Session ownership and reserved Child slots.
* Separate verified Cube data-plane execution from repetitive control-plane
  inspection. Retain instance/token binding and verify on creation/recovery;
  do not silently redispatch an uncertain mutating operation.
* Move pure hosted-search presentation normalization out of the Agent Runner
  dependency path; retain all existing user-visible capabilities.

## Adopt-before-build evidence

[Kafka consumer flow control](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html)
defines partition pause/resume. The installed Platformatic public Consumer and
MessagesStream interfaces were inspected together with its
[upstream documentation](https://github.com/platformatic/kafka/blob/main/docs/consumer.md).
Confluent provides [partition-concurrent consumption and seek/pause](https://docs.confluent.io/kafka-clients/javascript/current/overview.html)
with bounded native buffers and background heartbeats. Reimplementing a Kafka
fetch/group protocol or adding one consumer service per partition was rejected.
This is a client adapter replacement, not another message system.

## Acceptance

Reproduce a stalled partition with more than 256 successors while another
partition progresses; delayed live consumer after canonical seal; late result
rejection; consumer restart/reassignment with unsealed prefix and short-lived
receipts; bounded recovery start; native Session backend conformance and append
rollback/ID collisions; empty Worker claim counts; warm Cube operations while
control inspection is unavailable; real multi-round coding, browser refresh and
Worker/ingress failure tests. Report actual SQL counts and timings separately
from model latency. Preserve user data and remove only acceptance resources.

The protocol cutover is drained, not mixed-version rolling. No claim of physical
Cube fencing, automatic Shell replay or infinite-outage recovery is introduced.
