# ADR-0240: Reuse input admission reads inside their transaction

Status: accepted on 2026-10-09; implemented in source on 2026-10-10. The owner
approved removing duplicate input-acceptance reads before introducing any
additional caching. [Verification and rollout](../reports/input-admission-20261010.md)
are tracked separately.

## Decision

The ordinary HTTP intake currently executes nine business SQL statements.
QueuedInputService locks the Session and reads the initial Run's idempotency
record, then ControlPlaneStore reads those same facts again when it enqueues a
new Run or returns an earlier acknowledgement.

Let ControlPlaneStore own a callback-scoped input-admission transaction. Read
the full required Session selection once under the existing row lock, then read
the idempotency record in a separate statement. Give the input router the
locked Session, whether an initial request already exists, and a bound action
for accepting that exact initial request. That action reuses the captured
facts only inside the same transaction; it cannot be invoked after the
callback ends. The direct transactional Store entry used by internal initial
submissions remains supported without routing them through native follow-up.

The router keeps its native-submission and current-Run checks. Worker delivery
still occurs after the intake transaction and obtains fresh execution authority.
Do not carry this snapshot across that boundary or use it for subsequent HTTP
requests. Keep Workspace/environment locks, model validation, request
fingerprints, uniqueness constraints and atomic Run/Session writes.

Keep the fresh idempotency read after the Session lock: a concurrent request
may commit a new Run while this request waits. Combining that lookup with the
initial locking SELECT can retain a pre-wait joined snapshot. Reusing facts
already read under a retained lock does not have that problem.

This removes one duplicate combined Session/Run query. The ordinary initial
intake target is eight business statements, and an initial-input retry needs
two. Authentication, BEGIN/COMMIT and follow-up execution are separate counts.
No cross-request cache, infrastructure dependency, table or public protocol is
introduced. PG remains the control authority; Kafka views do not decide intake.

## Existing primitives and acceptance

Reuse the existing PostgreSQL transaction and row-lock adapter. The relevant
semantics are [READ COMMITTED statement snapshots](https://www.postgresql.org/docs/17/transaction-iso.html)
and [row locking](https://www.postgresql.org/docs/17/explicit-locking.html).
This is a bounded query/lifetime refactor, not a new storage protocol or queue.

Require real PG checks for the query budget, two replicas submitting the same
key while one waits for the Session lock, a changed payload under the same key,
model changes on either side of admission, unavailable Workspace rejection,
rollback/retry, and rejection of an escaped admission callback. Retain native
input/Stop/recovery, attachment and tenant-isolation acceptance. Verify the
direct Store and Worker claim query budgets remain unchanged. Deploy through
the maintained matched procedure with owned GPT-6 Luna/Cube/browser fixtures.
