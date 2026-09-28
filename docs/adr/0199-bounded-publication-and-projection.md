# ADR-0199: bounded publication failures and projection work

Status: accepted for implementation, 2026-09-28.

## Context

The owner approved polishing the existing writer/Projector and reducing measured
SQL exchanges. An isolated current-code probe rejected an append before calling
the Kafka port, yet poisoned the shared native writer and rejected a sibling
Lane. Current publication timing also combines attachment preparation and Kafka
waiting. Cold projection waits independently poll the same Session, and several
transaction-local reads/writes repeat data or exchanges.

Keep ADR-0161's single writer, ADR-0183's monotonic dispatch commit and ADR-0198's
combined Tool invocation. This work does not introduce Agent Team/Graph, another
consumer group, new storage authority, per-Step receipts or effect retries.

## Decision

- A trusted in-process publication port may explicitly reject an append as
  **not submitted**. Only code which proves it never handed this record to the
  transport may make that assertion. Ordinary errors, lost/mismatched ACK and
  failure after ACK remain uncertain/fatal. The native writer restores its
  uncommitted Lane view after a proved rejection, keeps the next sequence, and
  lets the caller fail or settle that operation without poisoning siblings.
  A failed restoration still retires the writer. No external Tool is retried.
- Local queue/size rejection does not latch an execution writer's transport
  failure. Capacity remains bounded; saturation is a definite rejection rather
  than a new unbounded retry queue. Permanent record size and transient pending
  capacity have distinct errors. Prior acknowledged records must still drain.
- A physical writer shares projection-progress reads and retains only its
  observed monotonic position. Waiters retain independent cancellation and the
  existing ownership checks. A cancelled waiter cannot cancel siblings. This is
  disposable read coordination, not a second durable cursor or commit receipt.
- Separate native queue/preparation/apply, attachment preparation, publication
  and Kafka confirmation timing. Instrument Projector stages and stalled-record
  identity with bounded metrics and payload-free diagnostics. Existing partition
  ordering and cross-partition concurrency remain intact.
- Bound projection transaction lock/statement waits with PostgreSQL's local
  transaction settings, before authority/native locks. Confirmed SQL rollback
  retains the original record for replay. No client-only timeout may release a
  still-running query or pretend an uncertain COMMIT rolled back.
- Reduce SQL exchanges within existing responsibilities: combine native Lane
  head/counter writes; co-write Run and partition progress; reuse the current
  conversation node; join environment validation in its snapshot; batch Entry
  and Record reads using index-compatible branches; check Broker and execution
  authority together after acquiring the runtime lock. Preserve lock ordering,
  database-time decisions, and the fresh snapshot after the Session lock.
- Keep completion/release authorization checks when their decision-time or lock
  contract differs. Do not trade those checks for a cross-transaction cache.

## Adopt before build

Reuse the pinned Pi public backend, Kafka clients and their existing queue bounds,
PostgreSQL transactions/CTEs and the current metrics registry. A short shared
Promise/position inside one writer needs no scheduler/cache framework. PostgreSQL
[data-modifying CTEs](https://www.postgresql.org/docs/17/queries-with.html)
combine writes to distinct rows/tables after validation; they do not replace the
separate lock-then-read snapshot boundary. Its
[transaction-local timeout settings](https://www.postgresql.org/docs/17/runtime-config-client.html)
bound server work without a second cancellation/commit protocol. Kafka's
[delivery semantics](https://kafka.apache.org/41/design/design/#message-delivery-semantics)
do not justify classifying a transport exception as proof of non-publication.

## Acceptance and rollout

Require sibling continuation after proved rejection, exact sequence restoration,
fatal ACK/local-apply uncertainty, callback cleanup, independent waiter cancel,
ownership loss and delayed projection, actual PostgreSQL query counts/plans,
lock-timeout rollback and replay, scope/fence expiry and fork/history equality.
Compare controlled phase timings with provider time excluded; distinguish
business SQL from BEGIN/COMMIT and timeout-configuration exchanges.

Use matched local application rollout and real GPT-6 Luna/Cube acceptance. Preserve
existing native history and clean only owned test resources. No database schema,
Kafka record format or Guest contract change is intended. Rollback uses matched
application binaries after drain; native history/export remains unchanged.
