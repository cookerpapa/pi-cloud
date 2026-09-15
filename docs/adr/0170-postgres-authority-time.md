# ADR-0170 — PostgreSQL decision time for execution authority

Status: accepted; implemented and deployed at `9f62b365`, with real-PG and paid
model/Cube acceptance. Wider repository audit remains in progress.

The audit reproduced a renewal sampled at t+2 s, blocked on a row until t+4 s,
and accepted after the old t+3 s deadline. Caller time cannot decide lease
validity after database waits. `now()` also freezes at transaction start;
PostgreSQL [`clock_timestamp()`](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)
and explicit [row locks](https://www.postgresql.org/docs/current/explicit-locking.html)
provide the existing platform's required primitives; no new authority service.

Execution lease/startup-claim issuance, renewal, expiry and executor admission use
primary PostgreSQL time. Lock the relevant identity/lifecycle rows before the
final check. A candidate scan is only a hint; waiting cannot renew an expired
lease or retire a lease that was renewed before expiry. Deadline-bearing writes
derive deadlines and check expiry in SQL, not from a timestamp supplied before
an await. Existing identity/Fence/closed-writer checks remain mandatory.

Worker observations translate database remaining lifetime into a conservative
monotonic local deadline, subtracting request elapsed time. They are cancellation
hints, not another authority. Ordinary native append/Step checks do not gain a
per-event PostgreSQL barrier. Wall-clock jumps on application nodes cannot grant
authority; the primary database clock must still be operated correctly.

Session-family ownership, Kafka opening/seal order, UNKNOWN Tool semantics and
no automatic Run/Tool replay are unchanged. This decision does not promise
atomic revocation of a Cube effect already admitted or a monotonic clock across
unvalidated PostgreSQL failover. Tests use real lock contention, explicit stored
expiry and local clock skew, not a production override of database time.
