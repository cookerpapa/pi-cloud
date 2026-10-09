# Projection SQL and replay-write verification

Date: 2026-10-09. Baseline: `387c6807`, schema 183. Scope: the approved Run
projection optimization in [ADR-0239](../adr/0239-projection-query-and-replay-writes.md).
This report describes source verification while production still served
`native-input-a71a4807`. The subsequent [matched release](projection-release-20261009.md)
deploys these changes and records live acceptance.

## Implementation and bounded measurements

Native projection combines the Run and writer reads into one statement. A
materialized locking Run CTE supplies the lease read; both retain
`FOR NO KEY UPDATE`. Native Session locking and fresh-snapshot fingerprint,
sequence and record checks remain in the existing Storage adapter.

The existing query-budget test measures 10 application SQL statements for each
of two fixtures: the first conversation/entry batch and a subsequent task
batch. Each previously needed the extra separate lease read (11 statements).
The count includes transaction-local timeout configuration, excludes the
driver's BEGIN/COMMIT, and is not an end-to-end latency or throughput result.
Different native batches can require different indexing/image-reference work.

Display coverage still checks the current writer and referenced native commit
under the Run lock. The UPDATE executes only if at least one coverage field
advances. Native/seal projection now shares the same conditional partition
progress upsert. Tests compare PostgreSQL `ctid` and `xmin` before/after replay:
neither the Run nor the progress row gets an unchanged new tuple. Row locking
and conflict checking still occur; this is not a claim of zero replay I/O.

No table, field, public protocol, native Storage format, index or dependency
changed. Exact-byte commit identity and the first recovery floor are preserved.

## Concurrency and failure evidence

- A blocked Run read does not already hold the shared writer lock. A separate
  NOWAIT writer lock succeeds, proving the retained acquisition order.
- After waiting for either the Run or writer lock, a newly committed cutoff
  rejects the native append and leaves native rows, first position and PG
  partition progress untouched.
- Concurrent higher display coverage survives a waiting replay without a new
  tuple. Either cursor can advance independently; neither regresses.
- Already-covered display replay still fails when its native commit is absent.
- The existing same-Run recovery test now retains a real native prefix and an
  old Projector's OPEN cache. After a new grant, old native writes are ignored
  and old display coverage is rejected even though the native commit exists.
  This passes with Stop before closure, after closure, and without Stop.
- The deletion test sends a delayed append after quiescent deletion; it cannot
  recreate history or advance progress. Existing cancellation/SQL-abort,
  native lock-timeout, first-floor atomicity and changed-byte replay cases pass.

The reason to retain PG authority locking is these in-flight transaction
boundaries. Kafka order and memory admission do not cancel already-started SQL.
Collapsing all locking onto the native parent would require changing lifecycle
lock ordering; this slice has no evidence that such a rewrite is necessary.

## Verification

Real PG cases ran in isolated disposable containers using the repository's
pinned test image. Completed repository gates:

- `npm run typecheck`: all 22 workspaces pass.
- `npm test`: 253 passing files, 1,652 passing tests across all 22 workspaces;
  7 files / 9 existing environment-gated tests skipped, no failures.
- `npm run test:acceptance-helpers`: 15 files, 64 tests pass.
- `node scripts/run-with-test-postgres.mjs -- node scripts/run-fault-eval.mjs --output /tmp/pi-cloud-projection-faults.json`:
  all 220 registered cases pass across 71 file groups, 526,817 ms wall time.
  This includes the five new cases in `eval/fault-cases.json`.
- `npm run format:check`, `npm run docs:check`: pass.

The fault report names baseline `387c6807` with the source patch present,
not an already-deployed release. These are deterministic source/PG checks;
no new live RF3 or fleet-throughput measurement is claimed.

This source verification performed no live model requests, VM changes or
production-data cleanup. The subsequent release above includes the commentary
animation UI. The walkthrough checkpoint remains PG initial-input acceptance.
