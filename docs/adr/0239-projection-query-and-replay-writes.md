# ADR-0239: Fewer projection round trips and replay writes

Status: accepted and implemented in source, 2026-10-09. The owner approved
reducing redundant Run writes and investigating native projection lock
consolidation. [Source verification](../reports/projection-sql-20261009.md) passes;
deployment remains pending.

## Boundary and decision

Keep the existing two core Session/Run tables. Ingress and the Projector's
ordered memory boundary continue to reject ordinary closed-scope messages.
They cannot revoke a PG transaction already started by a displaced Projector.
Native materialization therefore still checks the Run's writer and cutoff and
the shared writer's cutoff inside the append transaction. Expiry alone must
not discard an already accepted pre-seal commit.

Combine the two control-row reads into one SQL statement: a materialized
locking Run CTE feeds the locking lease read. Keep the order Run, shared lease,
then native Session. Do not replace this with an unconstrained locking join,
an unlocked join snapshot, or a cached OPEN decision. Read native commit
fingerprints and sequence continuity in a fresh statement after the native
Session lock. This saves one client/database round trip per native batch;
it does not remove row locks or claim to remove contention.

Using only the native Session lock would require redesigning the other
lifecycle transactions: Run closure/rebinding and writer closure currently
take their control locks before reaching the native parent (sometimes through
the unsealed-Run trigger). Moving append locking first to that parent could
reverse the acquisition order. That broader rewrite is not justified by a
measured contention bottleneck and is not part of this slice.

At a display/native coverage boundary, lock and validate the current Run and
the referenced native commit in one statement. Advance either coverage field
only when necessary; an authorized already-covered replay succeeds without a
new Run tuple. A missing native commit, missing Run or changed writer is still
an error, including when the numerical coverage is already high enough.

Use the shared PG partition-progress helper for both native batches and seals.
Its conflict update advances only to a larger offset. Replays retain their
transactional guards but do not rewrite unchanged progress. The native body,
first recovery floor and actual progress still commit atomically.

## Adopted mechanisms and limits

Reuse PostgreSQL's existing transaction, row-lock and conditional-upsert
mechanisms; add no store, scheduler, authority cache, schema or protocol.
PostgreSQL documents [row locking and consistent lock order](https://www.postgresql.org/docs/17/explicit-locking.html),
[updated-row rechecks after waiting](https://www.postgresql.org/docs/17/transaction-iso.html),
and [materialized/data-modifying CTEs](https://www.postgresql.org/docs/17/queries-with.html).
These primitives fit the current PG adapter without a new dependency.

This is a source-only SQL change on schema 183. Rollback uses the preceding
application version; there is no data conversion or compatibility path. The
existing native storage export/recovery and Kafka replay contracts remain.

## Acceptance

Use isolated real PostgreSQL tests to measure query count and tuple versions,
and to exercise lock waits in both directions. Require native replay/exact-byte
checks, cutoff rejection after a wait, stale-writer rejection after recovery,
Session deletion, Stop settlement (including SQL rollback), native parent-lock
timeout, and first-floor/commit atomicity. Display replay must not hide a
missing commit or changed writer, regress either cursor, or overwrite progress
advanced by a concurrent transaction. Verify partition progress is monotonic
and unchanged replay causes no tuple rewrite. Existing Projector handoff tests
must retain commit-before-effect and lost-owner suppression.
