# ADR-0174: Atomic Worker execution admission

Status: accepted, 2026-09-18; startup/first-record boundaries now follow
[ADR-0178](0178-admission-and-first-record.md).

Claiming a Run, binding its physical Session lease and recording its immutable
publication scope commit in one PostgreSQL transaction. API input acceptance
remains an earlier independent transaction. No model, Kafka or Cube work runs
inside execution admission. This uses ordinary PostgreSQL transactions, not a
new coordinator or distributed transaction protocol.

Ownership, expiry, cancellation and Lane ordering remain; capacity is local under
ADR-0180. Admission rejection rolls back Run binding and owner epoch together.
PostgreSQL-certified transaction aborts may retry; an uncertain COMMIT
must not create another execution. Only the exact committed admission can be
confirmed; otherwise the existing owner-expiry reconciler resolves it.

The local Runner is prepared after admission. Running state is part of that
transaction; admitted failure requires closure even before a first append.
Native input/sampling ACKs remain; Tool UNKNOWN and no replay are unchanged.

One committed publication is passed to the local direct-log writer. There is no
task startup lease, independent Attempt, signature or per-record authority query.

Verification covers atomic rollback, capacity/ownership contention, cancellation,
lost COMMIT reply, lost first-append ACK and owner loss after admission, plus
matched real GPT startup timings. Report improvements only if measured.

Reference: [PostgreSQL transaction semantics](https://www.postgresql.org/docs/17/tutorial-transactions.html).
