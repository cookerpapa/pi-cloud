# ADR-0149: Bound message handoffs to their causal work

## Status

Accepted; implementation and acceptance are tracked in BACKLOG.md.

## Decision

Keep PostgreSQL Run/Lease authority, Kafka AcceptedFacts, Pi SessionStorage and
Cube execution. Reduce duplicate work within those boundaries:

- SSE heartbeats reuse the pending event read. Canonical conversation and its
  boundary come from one PostgreSQL repeatable-read snapshot before socket I/O.
- Session projection and its durable successful receipt commit together.
  Workers publish before checking receipts and use bounded, shared result
  checks instead of a 10ms query loop per mutation. A missing notification or
  lost connection never counts as a successful commit.
- A model Step uses one active-branch read for Compaction assessment and model
  context; changed context is refreshed after a real semantic mutation.
- A Tool still requires durable model output, validated intent and Broker
  effect admission. Complete results and related semantic entries can share
  a checkpoint. Guest temporary cleanup belongs to the same invocation.
- Service verification is explicit at Preview publication; ordinary Bash does
  not wait for an HTTP scan. Existing published services may be checked in the
  background. File operations combine local filesystem preparation with the
  remote operation while preserving Pi errors and edit conflict checks.
- Kafka processing is ordered per partition, bounded across partitions, and
  never commits offsets for unfinished handlers. Gateway tails use indexed
  sequence lookup and append directly on the ordered path.
- Browser Session snapshots initialize history once; presentation choices do
  not recreate the SSE subscription.

## Adopt-before-build evidence

PostgreSQL repeatable read provides a stable view across the history queries:
https://www.postgresql.org/docs/current/transaction-iso.html
PostgreSQL NOTIFY is a commit-delayed wakeup hint, not a durable receipt:
https://www.postgresql.org/docs/current/sql-notify.html
Use the existing PostgreSQL connections/Fact transport and pinned
`@platformatic/kafka` consumer rather than adding a broker or scheduler.
The package supports concurrent stream processing; PiCloud adds a small
partition-tail adapter so unrelated partitions run concurrently while manual
offset commits cover only completed handlers:
https://github.com/platformatic/kafka

## Acceptance

Verify idle SSE across several heartbeats, snapshot/settlement races, receipt
redelivery and rollback, bounded context reads, Pi backend conformance, Tool
errors/cancellation, partition ordering/replay, and real multi-round coding
with an interactive Cube-hosted Preview. Measure system work independently
from Provider sampling time. Release acceptance-only resources afterward.
