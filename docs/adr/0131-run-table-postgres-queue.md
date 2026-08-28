# ADR-0131: Run is the PostgreSQL execution queue

Status: accepted

## Context

PiCloud currently represents one user message with a `Turn`, an execute
`Command`, a `Run`, a `RunAttempt` and an execute `Outbox` row. The Worker
scans the Outbox but all execution ownership, retries, leases, fences and
terminal state already live on Run/RunAttempt. The execute Command and queue
Outbox therefore duplicate the same lifecycle and make Claim update six rows
before model work starts.

The Outbox table has a second, non-duplicate responsibility: a terminal Run
and its terminal AcceptedFact commit in one PostgreSQL transaction, after which
the fact is retried into Kafka. That transactional cross-authority boundary
must remain.

PostgreSQL explicitly supports `FOR UPDATE SKIP LOCKED` for queue-like tables.
Graphile Worker and pg-boss validate the same job-table, partial-index,
LISTEN/NOTIFY-hint and polling-fallback pattern. Adopting either framework as a
second job authority would duplicate PiCloud's RunAttempt, ExecutionLease,
fence, cancellation and unknown-effect semantics, so PiCloud adopts the
database pattern rather than another runtime state machine.

## Decision

- `runs` is the sole execution queue and durable execution request.
- A Run stores its Session mailbox position, request hash and next eligibility
  time. A partial ready index supports queued or expired pre-ACK claims.
- Workers claim Run rows with `FOR UPDATE SKIP LOCKED`, create one RunAttempt
  and update that Run in one synchronous PostgreSQL transaction.
- Same-Session FIFO is expressed by Run mailbox positions. Turn remains queued
  until the Worker durably acknowledges that the Agent Loop started.
- PostgreSQL `LISTEN/NOTIFY` wakes Workers after a Run becomes immediately
  eligible. Polling remains the correctness path for lost notifications and
  future retry timestamps.
- Remove execute Commands and execute queue Outbox rows. `runId` replaces
  `commandId` throughout leases, Tool Broker assignments, terminal facts and
  Worker protocols.
- Cancel and Steer become typed `turn_control_requests`. Cancellation requests
  contain their own attempts and `available_at` fields and are claimed only by
  the Worker that owns the current RunAttempt. Steer remains a persisted direct
  delivery to that Worker.
- The generic Outbox remains only for terminal AcceptedFacts crossing from the
  PostgreSQL terminal transaction to Kafka.
- Keep RunAttempt transitions for this cutover. Their diagnostic/public API
  value and possible removal are a separate decision.
- Remove the unused tenant `last_scheduled_at` ordering. The maintained queue is
  global FIFO subject to Subagent priority and same-Session causality; tenant
  fairness is not claimed without measured starvation and an explicit policy.

## Destructive cutover

There is no dual-read, dual-write or compatibility path. Deployment drains
Workers, removes all conversation, Workspace and execution data, applies the
new schema and starts only the new binaries. Tenant/user identity, administrator
role, credentials and platform model settings remain. Conversations,
Workspaces, development machines and their Cube runtimes are deliberately
released rather than adopted through a compatibility identity.

## Consequences

The Claim critical path no longer updates Command, Turn and queue Outbox rows.
Turn changes to running only at Agent start, which is also a more accurate
product state. KEDA and operational metrics read the Run partial index.

The queue is intentionally domain-specific. A generic PostgreSQL job framework
would be appropriate for unrelated background work, but not for a Run whose
Attempt and execution fence are already PiCloud's external side-effect
authority.

References:

- <https://www.postgresql.org/docs/current/sql-select.html>
- <https://www.postgresql.org/docs/current/sql-notify.html>
- <https://worker.graphile.org/docs/sql-add-job>
- <https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md>
