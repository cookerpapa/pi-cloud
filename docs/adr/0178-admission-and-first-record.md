# ADR-0178: Execute after admission; recover from the first actual record

Status: accepted, 2026-09-19. Supersedes the separate started/running/opening
boundaries in ADR-0174 and ADR-0163; other ownership and closure rules remain.

The API still commits input independently. Worker admission commits Run binding,
Session lease, publication scope and running Turn/Session state together. The
Worker then prepares the local Runner and native context without another started
or running transaction. Running means admitted, including context preparation;
it does not prove a provider request or Tool has begun.

After admission, even a failure before local preparation requires ordered
closure. Remove output-free pre-start requeue: uncertainty must not create a
second execution or bypass a seal. An uncertain admission COMMIT can confirm only
its exact current admission; otherwise owner reconciliation resolves it. Keep
positive exit evidence, cancellation, family ownership and Tool UNKNOWN/no replay.

Remove `execution_opened` and its Kafka ACK. The PG-issued publication scope
still attributes each fact. The first real record establishes the recovery floor:
native mutation and first-offset metadata commit together; a first display/command
record must persist its floor before visibility/effects. A seal with no prior
output closes an empty execution. On replay, preserve the first position and
reject a missing unsealed prefix or partition change. Never cache success from
an uncommitted floor. No per-delta authority query or browser cursor is added.

Drain proof, completion, seal relay and terminal projection are unchanged. The
protocol cutover drains old executions and switches to a fresh code-owned Kafka
topic; do not accept historical opening records through a compatibility parser.
Preserve user conversations and Volumes. Remove the obsolete opening column and
phase adapter only after the drained deployment is stopped.

Verification: atomic admission rollback/lost COMMIT, capacity/cancellation races,
crash before first append, lost first ACK, first projection rollback/lost reply,
empty-output seal, retention/rebalance recovery, stale post-seal facts and shared
Lane closure. Then real model/Cube multi-round tests and matched latency samples.
This reuses existing PG transactions, Kafka ordering and recovery-floor metadata;
it adds no coordinator, framework or state authority.
