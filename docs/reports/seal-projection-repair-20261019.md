# Session seal projection repair and delivery

Decision: [ADR-0261](../adr/0261-session-seal-projection-boundaries.md).
Review baseline: `450a1efd`. Source implementation is complete; full verification,
matched rollout and live acceptance are in progress. The serving release remains
`seal-publication-8d9e7bc2`. No schema or transport protocol version changes.

## Behavior

- Projection uses a Control Plane-owned direct-PG pool with 12 connections and
  30-second acquisition/checkout budgets, including cold boundary/replay reads
  and COMMIT response waits. SQL-local 2-second lock/10-second statement budgets
  remain. It reuses the existing checkout eviction adapter; ordered replay
  reconciles uncertain commits. API/publication/maintenance pools remain separate.
- Disposable native live views share the existing physical-Session writer
  incarnation. A confirmed duplicate closure prepares the same old-view cleanup
  as first closure. Cleanup runs after transaction success with generation and
  object checks. Historical old-writer replay cannot clear a newer writer's
  pending suffix. The same cleanup also covers already-closed normal completion.
- Latest native hash proofs use each document's existing replay lower bound
  and a backward Session/sequence lookup. Complete latest-value checks remain;
  no streaming body, checkpoint head or recovery authority is added to PG.
- Recovery reuses the initial locked Run and version through the existing
  transition helper. Trigger-enforced release ordering and transition CAS remain.

## Source evidence so far

The focused run executes 109 tests. It initially passes 107: one new terminal
fixture omits mandatory failure fields, and one new fixture inherits Vitest's
default five-second timeout despite requiring a migrated private database.
Adding the required fixture fields and using the same 30-second fixture budget
as its siblings yields a nine-test passing focused repeat. No product behavior
or safety assertion is relaxed. Control Plane and native-storage typechecks pass.

The one-live-document closure uses **19 business statements plus one budget
statement**, with one locked Run read instead of two. Lost-return recovery retires
the cached live body while preserving the exact PG checkpoint. New-lease writes,
old prefix/seal replay, rollback, bounded cold/locked SQL and delayed cleanup are
covered. Native conformance includes independent replay starts and rejected
missing, old-sequence and changed-body proofs across interleaved Conversations.

The controlled query fixture keeps one pending document/change at history sizes
1 / 1,000 / 10,000 / 50,000. The repaired query returns one proof and examines one
matching header in every case. At 50,000 historical headers the local warm query
is 0.067 ms, compared with 16.742 ms and 50,002 matching headers in the recorded
review. These separate samples establish query shape/growth, not production
latency or fleet capacity. The complete checkpoint includes additional SQL.

Original defect assertions remain in the review commit. Maintained regressions
and the current query-cost probe replace them; no compatibility implementation
is retained.

## Remaining delivery gates

- Full source/build/transport/fault checks and artifact scans.
- Maintained drained matched release with original configuration preservation.
- Native input/Stop/Worker and dual-process recovery, browser/Read, Tool-image
  cold recovery, child handoff, complete Control Plane outage and full Cube.
- Confirmed physical fixture cleanup and final configuration comparison.

The initial read-only deployment inventory has no active Run/writer/binding/VM,
all Pods Ready and approximately 400 GiB free. It records original account/model/
provider credential fingerprints privately. This is a baseline, not completed
deployment or acceptance evidence.
