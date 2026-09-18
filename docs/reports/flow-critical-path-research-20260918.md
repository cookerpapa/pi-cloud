# Startup and settlement critical paths — September 18, 2026

**Prioritize waking the terminal Outbox relay after commit.** An isolated PG
experiment consistently removed about 22–23ms of polling delay. Transaction-local
SQL consolidation is a smaller second opportunity. Moving the durable output-drain
boundary needs a separate failure-contract review, not a performance-only edit.

This is research, **not a deployed optimization**. Main `8a0e944e`, Worker
`aad78995`, Control Plane `5c9977fa`; existing resources, durability and model
settings unchanged. One test tenant/Session ran 32 real GPT-5.6 Luna Turns,
medium/Standard, all completed with the expected short replies. No Cube activated.

## Measured breakdown

The first 16 Turns used temporary content-free PG/Kafka timing hooks and one
persistent SSE connection. They had no capacity backlog. Startup median was
92.809ms, settlement tail median 94.118ms. This short-history workload is not a
matched comparison with the earlier long-context study: **no optimization was
applied to obtain these numbers**. Hooks also introduce unquantified overhead.

| Startup segment | Median |
| --- | ---: |
| Submission → claim starts, including input acceptance/notification | 14.000ms |
| Claim/lease/publication transaction | 24.866ms |
| Durable started transition | 10.276ms |
| Kafka opening ACK | 4.251ms |
| Durable running transition | 7.015ms |
| Parallel model/Session preparation span | 10.299ms |
| World State preparation | 0.085ms |
| Remaining preparation → provider dispatch | 17.518ms |

The last segment includes native operation+user append, separate `turn.started`
publication, sampling Record append and local dispatch. A representative trace
has three sequential Kafka receipts of 4.04/3.42/2.39ms there; concurrent CP
projection SQL is not a Worker wait for PG receipt. Model/Session preparation
already overlaps; do not propose parallelizing it as a new optimization.

| Provider completion → terminal received segment | Median |
| --- | ---: |
| Final native output publication before drain update | 9.486ms |
| Durable `native_output_drained` update | 11.228ms |
| Completion/lease release/seal-enqueue transaction | 25.400ms |
| Committed seal Outbox → next claim query starts | 21.786ms |
| Seal claim query/commit | 3.131ms |
| Kafka seal append ACK | 4.434ms |
| ACK → seal projection transaction starts | 1.833ms |
| Seal/terminal projection transaction | 7.347ms |
| Projection commit → SSE receipt | 1.497ms |

Separate medians are not additive; small inter-stage scheduling gaps remain.
Per-Turn boundary differences reconcile to its measured wall-time span. Clocks
have millisecond cross-process resolution, so sub-millisecond negative boundary
differences are measurement noise. SSE receipt is not browser paint. Model-route
time includes CLIProxyAPI; this is not a CPU-time or maximum-throughput benchmark.

## Commit tails propagate through a shared row

One initial-cohort tail reached **303.930ms**. The Worker's drain UPDATE took
**239.593ms**, overlapping a CP COMMIT of **193.217ms**. Timing overlap alone did
not establish the PG server wait cause, so a second 16-Turn diagnostic cohort
added approximately 5–7ms `pg_stat_activity` sampling. Its timings are not pooled
into the first cohort's table or treated as an optimization comparison.

That cohort observed transaction-ID lock waits on the drain UPDATE in all 16
Turns. In one 42.221ms update, six samples over 31ms showed the Worker waiting
on `Lock:transactionid`, while the overlapping 34.930ms Projector COMMIT sampled
`IO:WalSync`. A 19.972ms update similarly overlapped a 12.544ms WAL-waiting commit.
Both paths update the same Attempt row in the code. This supports the lock/WAL
wait-chain explanation; no `pg_blocking_pids` graph was collected, and the earlier
239ms incident was not independently reproduced with wait sampling. Do not call
all query wall time physical disk latency or claim its underlying device cause
has been resolved.

The separate drain write lives in `DirectExecutionLog.close`. It is not token
delivery: it influences whether a seal closes only one Run or its shared native
writer. Simply deleting the flag/write would change failure isolation.

## Isolated notification experiment

One uniquely named schema on the same PG contained only a test Outbox, with no
production FK/data access. Both paths used the **existing relay claim/publish
implementation**, `batchSize=1`, and the same INSERT+transactional notification.
The polling path ignored notifications; the notified path reused the existing
`PostgresQueueWake`, scanning after LISTEN registration and retaining the same
50ms periodic safety scan. This was a test composition, not a product change.

The bus was **a fixed 4ms simulated ACK, not Kafka**. Measure commit-return to
completed claim and simulated append ACK, not broker throughput. Poll/notify/
poll/notify cohorts each had five warmups plus 40 measured inserts, staggered
by an identical repeating delay sequence. Source/schema connections were closed
and the isolated schema was dropped afterward.

| Cohort | Commit → completed claim median / p95 | Commit → simulated ACK median |
| --- | ---: | ---: |
| Poll 1 | 26.036 / 42.332ms | 30.177ms |
| Notify 1 | 3.022 / 4.046ms | 7.151ms |
| Poll 2 | 25.160 / 40.944ms | 29.330ms |
| Notify 2 | 3.031 / 5.241ms | 7.171ms |

Medians average the middle pair; p95 uses nearest rank.
Enqueue median remained 3.17–3.42ms. One deliberately suppressed notification
was recovered by the periodic scan in **57.152ms from INSERT start**. This checks
one missing-hint case, not reconnect storms or multi-replica fairness. Before
shipping, repeat with real Kafka/full E2E, rollback, reconnect, notification
arrival during scan and concurrent claims.

PostgreSQL delivers transactional notifications after commit; the table remains
the authority and the hint carries no transcript. A listener should register
first and then inspect current DB state, rather than assuming it received old
notifications. These are the documented [NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html)
and [LISTEN](https://www.postgresql.org/docs/17/sql-listen.html) patterns, already
used by the Worker queue. Retain recovery scanning; do not replace the Outbox
with notification-only delivery or a shorter busy-poll interval.

## Recommended sequence

1. **Commit-triggered seal-relay wake-up.** Keep the existing PG Outbox, claim
   CAS, Kafka ACK and seal projection. One listener per relay process, not per
   Session; use a hint plus authoritative scanning and missed-wake protection.
   The isolated result supports targeting roughly twenty milliseconds from the
   normal tail, not a guaranteed end-to-end reduction or removal of WAL tails.
2. **Reduce round trips within existing transactions.** Completion currently
   updates Turn and Session separately, and scope release re-reads lease metadata
   through nested helpers. Reuse immutable identity already read under the same
   transaction's locks; combine independent writes with exact row-count checks.
   Preserve lock order, decision-time expiry and fresh checks across transactions.
   Session bootstrap also serially loads metadata and Lane heads; a bounded batch
   read could help. Gains are unmeasured and likely smaller on this host than the
   polling change. Do not add another cache or remove ownership checks.
3. **Review, do not yet merge, the drain/completion commits.** Returning an
   acknowledged drain fact to the existing completion transaction could remove
   an autocommit, but cancellation/failure, lost reply, sibling Lanes and writer
   closure must retain their meaning. It would not automatically eliminate the
   Projector's row lock or underlying WAL stall. This requires owner agreement
   before changing the durable failure boundary. Likewise, started/running
   transitions are not removable just because they cost time.

The separate `turn.started` Kafka receipt is a small further consolidation
candidate, but binding it to a native append requires proving event ordering and
early-failure behavior; its few milliseconds do not justify an unreviewed Harness
change. No new middleware, disabled fsync or weaker ACK is proposed.

## Cleanup

All 32 real Runs sealed, released and projected beyond their seal offsets.
Native usage: 29,329 input, 193,536 cache-read and 597 output tokens. The test
account/Session/unused Workspace and scoped PG data (692 rows) were removed;
original 33 tenants, 35 users and one Session/Workspace remain. No guest or
development machine was created. The 181-row isolated trial schema and its
connections were removed. Both temporary inspector probes were restored and
listeners closed; private scripts/raw traces were removed after report validation.
Shared formal service/Kafka/WAL retention was not altered. Product source and
production configuration are unchanged; this is not implementation acceptance.
