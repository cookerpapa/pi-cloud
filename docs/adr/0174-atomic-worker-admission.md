# ADR-0174: Atomic Worker execution admission

Status: accepted, 2026-09-18.

Claiming a Run, binding its physical Session lease and recording its immutable
publication scope commit in one PostgreSQL transaction. API input acceptance
remains an earlier independent transaction. No model, Kafka or Cube work runs
inside execution admission. This uses ordinary PostgreSQL transactions, not a
new coordinator or distributed transaction protocol.

The existing ownership, expiry, cancellation, Lane ordering and family capacity
checks remain. Admission rejection rolls back the new Attempt, epoch and capacity
together. PostgreSQL-certified transaction aborts may retry; an uncertain COMMIT
must not create another Attempt. Only the exact committed admission can be
confirmed; otherwise the existing owner-expiry reconciler resolves it.

The local Runner is prepared after admission. Its durable `started` transition
must precede Kafka opening. Before `started`, no output can have been published
and normal pre-start requeue remains safe. After `started`, even an uncertain
opening requires the existing ordered seal before a successor. The later
`running` transition and native input/sampling ACKs remain separate. Tool UNKNOWN
and no-replay semantics do not change.

One committed publication is passed to the direct log; opening no longer creates
its own database transaction. A bound claimed Attempt cannot be stolen merely
because its shorter startup deadline elapsed. There is no legacy runtime path,
new public API, table migration, signature or per-record authority query.

Verification covers atomic rollback, capacity/ownership contention, cancellation,
lost COMMIT reply, lost opening ACK and owner loss before/after `started`, plus
matched real GPT startup timings. Report improvements only if measured.

Reference: [PostgreSQL transaction semantics](https://www.postgresql.org/docs/17/tutorial-transactions.html).
