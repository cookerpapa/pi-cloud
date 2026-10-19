# Kafka seal → Projector → PostgreSQL review

Reviewed on 2026-10-19 (Asia/Shanghai).
Revision: `1d84ea59b49a517d41705fb5e4b15192c7d44382`.
Unchanged serving release: `seal-publication-8d9e7bc2`, schema 190.

Scope: consumption of an already-published `execution_seal`, native live
checkpoint materialization, old-writer closure, lease release, Run readiness and
duplicate delivery. The successor's complete Harness bootstrap/continuation is
the next hop; this review checks its PG admission boundary only.

This is a review, not a runtime repair or rollout. It adds documentation and
isolated characterizations. No production faults, native crash experiments,
provider requests or VM operations were performed. The previous publication
repair and its live acceptance remain unchanged.

## Current flow and assessment

1. The existing Session Projector reads the seal on the same Kafka partition as
   the old Worker's native commits. The preceding publication hop has already
   taken over the stable Session producer identity and revoked old Tool routing.
   A Kafka ACK alone has not released PG authority.
2. Ordered native projection has reconstructed pending `pi.live` documents in
   partition-owner memory. On restart, the replay floor includes unsealed Run
   positions and outstanding native live references. Already-projected headers
   do not mean the memory view is complete.
3. The closure transaction locks the root Run, its exact Session lease, then the
   physical native Session. It checks the persisted seal intent and immutable
   writer identity. A closure replay can recognize an already-closed old writer
   even after the same logical Run has acquired a different lease.
4. Before release, `checkpointLiveIn()` requires reconstruction through the
   projected native head and verifies the latest live values against stored
   commit hashes. It writes one current checkpoint for every pending document
   in the physical Session and clears those replay references. It allocates no
   new native sequence, runs no Harness and fabricates no Assistant Entry.
5. **In that same PG transaction**, it advances view cursors, stores the old
   writer's seal offset, marks its execution released and releases the eligible
   Session lease. A recoverable seal resets the existing Run to `queued`, clears
   its old assignment, preserves pending Stop and makes it eligible when its
   dependencies permit. A terminal seal materializes the persisted terminal
   decision instead. The partition projection cursor commits with these writes.
6. Only after COMMIT can another Worker claim the Run and receive the next PG
   lease epoch. Ordinary notifications are wake hints. After successful local
   delivery, the consumer advances progress; an exception pauses/retries this
   partition using the same record. Replay never grants arbitrary Tool replay.

The main atomic boundary is sound in the inspected paths. The isolated test
pauses after all closure SQL but before COMMIT: another Worker sees no claimable
Run and the old replay reference remains visible. After COMMIT it obtains epoch
2; a repeated old seal does not modify that grant. Rollback and lost-return
cases preserve the exact checkpoint/release relationship.

This still does **not** prove that an old Agent process or a Cube Tool process
has physically stopped. Writer authority, native recovery and physical resource
cleanup keep their existing separate meanings. Child Conversations share the
one physical Session checkpoint/lease; no RunAttempt or child lease is added.

## Findings

### SPJ-01 — P2: projection has SQL-local budgets but no outer PG I/O bound

`SessionProjector` receives the ordinary Control Plane pool: 12 connections,
without an acquisition/checkout timeout. The preceding ADR-0260 repair bounds
the **publication** pool; it does not cover this projection pool or cold boundary
reads. `projectionTransaction()` sets a two-second lock timeout and ten-second
statement timeout only after acquiring a connection and beginning a transaction.
These settings cannot bound connection acquisition or a missing client response.

An isolated real-PG test occupies the only connection in a pool with the same
unbounded configuration. A projection configured with a 60 ms statement budget
has not even entered its transaction body after 250.9 ms. Releasing the fixture
connection lets it complete. This proves the budget boundary; the absence of an
eventual application deadline is established by source, not a claim of an
infinitely observed outage.

A blocked seal keeps its partition behind it. The consumer also joins in-flight
handlers during assignment/disposal, so an unbounded PG wait can delay recovery
or shutdown beyond the SQL-local budgets. Correctly refusing successor admission
is not enough to ensure bounded progress.

Locations: `packages/control-plane/src/main.ts:135`,
`packages/runtime-core/src/session-projector.ts:143`,
`packages/runtime-core/src/projection-transaction.ts:10`,
`packages/event-log/src/kafka-log-consumer.ts:252`.

Repair direction: apply the existing bounded database facilities to projection
acquisition and entire checkout, including reads outside the SQL wrapper and
COMMIT response handling. Keep server-side lock/statement budgets. Expiry must
retire the connection and let the existing ordered replay reconcile PG; do not
race a timer while leaving the write alive, skip the record or introduce another
recovery authority. Pool composition and timeout sizing need measured tests;
the review does not prescribe copying publication's five-second budget blindly.

### SPJ-02 — P3: a lost seal COMMIT return retains already-checkpointed live text

`PostgresDurableCommitProjector.checkpointLiveIn()` prepares a post-COMMIT callback
that removes the old memory view. If PG commits but that return is lost, the
callback is not called. On replay, `#seal()` finds the durable old-writer closure
and takes an early duplicate branch. It does not reconstruct the cleanup action.
`releaseSettled()` only removes an already-empty live map, but this old map is
still nonempty precisely because the callback was skipped.

The reproduction uses one 1 MiB synthetic partial. PG has the exact checkpoint,
zero replay references and a released old lease; two duplicate seals succeed.
The old cached view still contains **1,048,821 serialized bytes**. A read-only
replay reaches that same retained instance. Projector reset removes it. The
ordinary prefix statistics are zero and do not expose this separate live map.

This is retained memory, **not lost conversation data or premature release**.
Further native work or a reset can clear it. In an otherwise-idle Session it has
no expiry sweep, so repeated response-loss incidents across Sessions can retain
unnecessary bodies. No production heap exhaustion was demonstrated.

Locations: `packages/runtime-core/src/execution-stream-projection.ts:490`, `:500`,
`:674`; `packages/runtime-core/src/postgres-durable-commit-projector.ts:43`, `:231`.

Repair direction: after reconciling an already-committed closure, also retire
the corresponding old memory view. Make cleanup ownership-aware: blindly
deleting by physical Session could discard a successor's newer live suffix
during historical replay. Preserve the existing generation/object checks and
do not add durable receipts merely to manage disposable memory.

### SPJ-O1 — P3: checkpoint proof scans lifetime commit headers

The latest-hash query expands `current_hashes` from all commit headers belonging
to the physical Session, then selects the newest hash for each pending document.
It does not bound the lookup by that document's existing replay reference. This
is a header scan, not a full transcript/body read, but the work grows with
Session lifetime even when the pending suffix is tiny.

The isolated fixture holds pending work constant: one new live document with
one change. It bulk loads consistent no-op historical headers and captures the
actual query with `EXPLAIN ANALYZE`:

| Prior headers | Matching headers examined | Returned proofs | Query execution |
| ---: | ---: | ---: | ---: |
| 1 | 3 | 1 | 0.072 ms |
| 1,000 | 1,002 | 1 | 0.365 ms |
| 10,000 | 10,002 | 1 | 3.038 ms |
| 50,000 | 50,002 | 1 | 16.742 ms |

These are warm local samples with synthetic history, not a production timeout
or capacity benchmark. The concern is unnecessary growth while holding closure
locks; 50,000 headers did **not** time out in this test.

Location: `packages/pi-session-postgres/src/durable/postgres-projection.ts:658`.

Repair direction: use the existing per-document replay range to restrict latest
proof lookup and verify it uses the Session/sequence index. Every pending value
has an update at or after its protected `replay_seq`; older unrelated headers
are unnecessary. Keep exact newest-sequence/hash checks and test interleaved
Conversations and long-lived pending documents. A lifetime scan must not be
replaced by an unverified cache, periodic full-text PG snapshots or another
checkpoint authority. This reduces unrelated history work; a genuinely long
active suffix still has a cost that must be measured.

### SPJ-O2 — P3: recovery rereads a Run already locked in the transaction

`#seal()` locks and reads the Run at entry, then calls `transitionCurrentRun()`
when requeuing it. That helper locks and reads the same row again. The normal
`work_finished` path already uses `transitionLockedRun()` to reuse this
transaction-local state under ADR-0256; forced recovery has not adopted it.

The one-live-document fixture issues **21 client statements**: one budget-setting
statement and 20 business statements. Two are locked Run reads. BEGIN/COMMIT,
trigger-internal work and unrelated background traffic are excluded. This is
once per forced recovery, not once per streamed token.

Locations: `packages/runtime-core/src/execution-stream-projection.ts:460`, `:571`;
`packages/runtime-core/src/run-state.ts:21`.

Repair direction: include `row_version` in the first locked read and reuse the
existing locked-transition helper. Verify that intervening writes/triggers do
not change the transition snapshot. Preserve the transition CAS and the required
seal/release-before-assignment-clear sequence. Do not merge those writes blindly:
the maintained writer-handoff trigger intentionally checks the previous row.

## Verification, SQL and limits

- **175 existing tests in ten files pass**: the initial seven-file projection,
  seal/recovery/completion group has 45 tests; native Storage conformance,
  physical Session leases and atomic Worker admission add 130. These include
  missing replay rejection, native rollback, pending Stop, retained suffixes,
  child/live storage boundaries and lock/statement cancellation.
- **Five isolated characterizations pass**: closure rollback; actual COMMIT with
  lost return/cache retention; concurrent pre-COMMIT claim and stale seal;
  query-count tracing; held pool acquisition. Network response loss is modeled
  at the return boundary; the actual PG transaction is real.
- **Four query-cost cases pass**, including exact cold checkpoint contents.
  Historical headers are bulk-loaded; the real native projection/checkpoint
  and proof query are used. This does not measure ingestion or Harness throughput.
- Standalone strict type checking and formatting/documentation checks pass.
  The first type check found missing `this` annotations in two test spies; only
  those fixture annotations were corrected. No product behavior was changed.
- No full RF3 suite or live model/Cube acceptance was rerun for this review-only
  change. Existing release evidence is not relabeled as fresh review validation.
  Disposable PG fixtures are cleaned by the maintained helper.

The SQL trace groups as follows: budget configuration (1); Run/lease/native-Session
locks (3); native head/pending/hash reads (3); checkpoint and native index writes
(2); view cursor handoff (1); writer/execution release (3); temporary Run closure
(1); pending Stop restoration (1); repeated Run read (1); queued transition (1);
old-assignment clearing (1); Session update (1); projection offset (1); readiness
(1). The current architecture gives these operations different responsibilities;
the duplicate Run read is the concrete removable round trip identified here.

[Reproduction instructions](../../scripts/experiments/review-seal-projection-20261019/README.md)
and [structured evidence](seal-projection-review-20261019.json) accompany the report.
No new ADR is necessary for recording findings; an approved repair that changes
protocol/storage invariants must record its decision before implementation.

Next walkthrough: **new PG claim → replacement Worker → native Harness open and
continuation**, including what is loaded from the checkpoint and how interrupted
unsafe Tools avoid automatic replay. The model request/response branch follows.
