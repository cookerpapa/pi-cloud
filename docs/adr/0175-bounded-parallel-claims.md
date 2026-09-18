# ADR-0175: Bounded parallel Worker claims

Status: accepted, 2026-09-18, following the approved serial/two-way comparison.

An operator-approved trial raises each Worker's pending Run claims from one to
at most two. This overlaps preparation inside the existing PostgreSQL admission
path; it adds no scheduler, connection pool, lease or durable state.

Until a claim has committed and its physical Session is known, it conservatively
reserves one possible new family and one possible Lane in each active family.
Recompute admission before launching each probe. PG still makes the final atomic
capacity/ownership decision, enforces same-Lane ordering and predecessor closure,
and binds claim/lease/publication together (ADR-0174). A local reservation is a
bounded scheduling hint, not a second authority. Database pool limits do not grow.

Release a pending reservation exactly once: on committed claim notification or
on unclaimed completion/failure. Track executions before invoking the executor.
Successful claims and completed tasks wake admission; empty/failed probes do not
self-wake into a polling storm. Shutdown joins pending claims and active tasks;
draining can admit owned children but no new families beyond already-issued work.
Track queued-work signals separately from capacity wakes: a notification arriving
during an older empty probe must be rechecked when that probe finishes, without
letting two empty probes recursively wake one another.

Validate bounds, one-slot capacity, Lane limits, failure/idle accounting,
readiness, cancellation, drain, concurrent real-PG admission, lost COMMIT and
ordered closure. Compare serial/two-way/serial/two-way real GPT workloads with
unchanged resources, provider configuration and durability. Retain only if the
measured benefit justifies the change; do not preserve an alternate scheduler.

This reuses PostgreSQL's documented [queue-style SKIP LOCKED](https://www.postgresql.org/docs/17/sql-select.html)
and [single-client transactions](https://node-postgres.com/features/transactions),
not a custom locking protocol. Exclusive authority-row locks can still serialize
part of admission; two probes do not imply a twofold speedup.
