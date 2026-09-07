# ADR-0153: consolidate execution boundaries without changing authorities

Accepted and implemented, 2026-09-07.

Keep PostgreSQL Run/Lease and semantic Session authority, Kafka AcceptedFacts,
Pi's public APIs, and Cube-only untrusted execution. Implement the architecture
review as independently tested slices; do not remove product features.

## Sequence and contracts

1. Closing a Fact Stream stops new submissions but drains its accepted in-flight
   publication (including progress accounting) before final progress/authority
   release. Concurrent close calls share the same result. Continue renewal while
   draining. Unknown delivery must fail close, never manufacture a successful
   drain. This does not by itself fence a publisher after hard process loss or
   an arbitrary network partition: those cases require explicit fault evidence.
2. Terminal Outbox uses bounded atomic claims, no Kafka I/O under a database
   transaction, compare-and-set confirmation and retry backoff. Preserve Session
   terminal ordering. Stable Fact IDs make lost ACK redelivery idempotent.
3. Co-commit sampling-start with its step Record, and complete Tool result with
   its reviewed public completion. Keep complete model output and validated
   Tool intent as two distinct pre-effect barriers. Reduce redundant queries
   only where a stronger existing atomic boundary performs the same check.
4. Keep native SessionStorage conformance and the self-contained log, while
   replacing duplicate mutation-result bodies with immutable references and
   making hot branch/latest-state reads bounded.
5. Separate ingest, live-tail and canonical-projection composition roles before
   splitting deployment processes. Expose stalled consumers; never skip an
   accepted semantic Fact merely to report healthy progress.
6. Make optional Tool infrastructure a dependency of actual Tool work, not all
   model-only Runs; keep authoritative Broker effect admission fail-closed.
7. Separate initialized persistent-Volume reads from running full-VM reads.
   Normal browsing must not reinitialize storage or require Cube allocation.
8. Centralize reviewed model capabilities and factor responsibility-oriented
   internal modules without inventing more production services.

## Adopt-before-build

Use PostgreSQL's existing `FOR UPDATE SKIP LOCKED`/CTE/conditional UPDATE and
the pinned Kafka client rather than another scheduler or event system.
`executeTakeFirst()` is not SQL LIMIT; claims must explicitly bound selection.
See [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html).
Kafka enqueue, durable delivery, flush and producer fencing are different
contracts; a timeout or closed application socket does not retract an already
sent record. See [Kafka Producer](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/producer/KafkaProducer.html).

## Validation

Delayed delivery during close/disconnect, repeated close and failed delivery;
multiple Outbox claimers, lost ACK, stale claimant and transient Kafka failure;
native Pi conformance, bounded branch plans, public API/browsing, model settings,
multi-round paid coding and refresh during streamed Tool preparation. Report
platform-only measurements separately from Provider latency. Clean up only
acceptance-owned resources. Current progress lives in BACKLOG.md.

Results and limitations: [boundary acceptance](../reports/boundary-consolidation-acceptance.md).
