# ADR-0177: Terminal wake hints and transaction-local SQL consolidation

Status: accepted, 2026-09-18, following the approved first two
[critical-path proposals](../reports/flow-critical-path-research-20260918.md).

The existing seal Outbox INSERT emits an empty PostgreSQL notification in the
same statement/transaction. Each Projector's relay owns one LISTEN connection.
Notifications only wake the existing bounded, CAS-protected claim path; PG
Outbox rows and Kafka seals remain authoritative. Registering/reconnecting a
listener forces another scan. Generation-based wake-up prevents a hint arriving
during an empty scan from being lost. Periodic 50ms scanning and publication
backoff remain, including when the hint connection fails. No transcript or secret
is sent in the notification. Reuse node-postgres and the Worker queue's wake
primitive, not a new broker or queue. PostgreSQL documents
[commit-time delivery](https://www.postgresql.org/docs/17/sql-notify.html) and
[LISTEN-then-scan](https://www.postgresql.org/docs/17/sql-listen.html).

Combine already-locked Turn/Session completion writes into one SQL round trip
with exact changed-row checks. Reuse lease identity during scope release only
under the same transaction's identity and physical-Session locks. Do not reuse
expiry decisions across transactions or skip peer-Lane/capacity reconciliation.

Drained-output proof, completion and seal projection retain separate durability
boundaries. Startup consolidation is specified separately in ADR-0178.
No network operation enters a PG transaction. Drain/completion merging remains
unapproved. Preserve cancellation, UNKNOWN, ordered closure and lost-ACK handling.

Acceptance covers notification rollback/loss/reconnect/scan races and shutdown,
concurrent relays, claim CAS retries, shared-family release and transaction
rollback. Compare real Luna startup/settlement on unchanged resources, then
verify real Cube coding and clean all owned test resources.
