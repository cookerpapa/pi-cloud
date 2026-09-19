# ADR-0174: Atomic Worker execution admission

Status: accepted, 2026-09-18; startup/first-record boundaries now follow
[ADR-0178](0178-admission-and-first-record.md).

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

The local Runner is prepared after admission. Running state is part of that
transaction; admitted failure requires closure even before a first append.
Native input/sampling ACKs remain; Tool UNKNOWN and no replay are unchanged.

One committed publication is passed to the local direct-log writer. A bound Attempt cannot be stolen merely
because its shorter startup deadline elapsed. There is no legacy runtime path,
new public API, table migration, signature or per-record authority query.

Verification covers atomic rollback, capacity/ownership contention, cancellation,
lost COMMIT reply, lost first-append ACK and owner loss after admission, plus
matched real GPT startup timings. Report improvements only if measured.

Reference: [PostgreSQL transaction semantics](https://www.postgresql.org/docs/17/tutorial-transactions.html).
