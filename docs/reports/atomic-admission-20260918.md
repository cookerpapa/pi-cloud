# Atomic Worker admission — September 18, 2026

Follow-up: [matched WAL-wait evidence and storage-only reproduction](startup-wal-tail-20260918.md).

Baseline code: `167400e5` (runtime unchanged from `86d8a057`). Implemented and
deployed: `ff51e21d`. One Compose Worker, four family/model slots, unchanged
PostgreSQL/Kafka/Cube resources, model routes and durability settings.

**The admission segment is faster and has fewer partial failure states. Overall
single-Session startup and tail latency are not demonstrably solved.**

## Change and failure contract

Worker claim, Session lease binding and publication registration now commit in
one PG transaction instead of three. API input acceptance remains independent.
The existing durable started transition precedes Kafka opening; all network,
model and guest work remains outside admission. Later running/native ACKs stay.

Failed admission rolls back Attempt, epoch and capacity together. A lost COMMIT
reply can continue only the exact confirmed admission; transport errors never
become another blind claim. Lease-bound claims cannot be stolen on their shorter
startup deadline. Before started there can be no Kafka output, so safe requeue
remains possible. After started, a lost opening ACK requires an ordered seal.
Lease/fence, cancellation and Tool UNKNOWN/no-replay contracts are unchanged.

Fault injection also found a real pool bug: `pg` handles idle-client errors, but
a checked-out connection could emit an unhandled error between SQL statements.
The adapter now latches that failure, rejects subsequent SQL/COMMIT and evicts
the socket. It does not retry SQL or affect unrelated clients. A subprocess
test kills idle, checked-out-between-SQL and actively querying PG connections.

## Paid GPT comparison

Four cohorts ran in old/new/old/new order. Each used GPT-5.6 Sol, medium reasoning,
Standard service, twelve sequential Turns including a twelve-second idle gap,
then two four-Session waves. There were no concurrent builds, profilers or test
suites during these measurements. Both CP and Worker were switched together.
The return-to-baseline images were rebuilt from the exact baseline source;
the final deployment is the new version.

Numbers below measure API submission to local Model Gateway upstream dispatch,
**excluding remote model generation**. They are not browser-paint measurements.
Each sequential cohort excludes its first Turn from the follow-up median.

| Cohort | Follow-up median (11 Turns) | Four-Session median (8 Turns) | Follow-up maximum |
| --- | ---: | ---: | ---: |
| Old, first | 118.3ms | 262.9ms | 142.4ms |
| New, first | 112.4ms | 259.5ms | 182.4ms |
| Old, repeated | 147.4ms | 273.9ms | 196.7ms |
| New, repeated | 131.5ms | 205.4ms | 327.5ms |

Across both cohorts, follow-up medians are **126.9 → 125.4ms** and four-Session
medians **262.9 → 225.9ms**. Variation is material and samples are small;
do not turn this into a general throughput or tail-latency guarantee.
The first Turn ranged from 175.7 to 256.7ms across these different warm/cold
process conditions, so this is not a controlled cold-start improvement claim.

For the non-overlapping claim + lease + publication/opening spans, summed
histogram means fall **63.4 → 52.8ms**, then **73.7 → 61.0ms** (about 17% in each
pair). New claim timing includes the merged lease/registration work; comparing
the old and new claim histogram alone would be misleading. These sums exclude
the still-separate started/running transitions, restore and native appends.

Pi text-event emission to SSE client receipt has pooled medians **10.7 → 10.2ms**.
Provider-route first-text medians varied **2.18s → 3.81s**; this variation is
excluded from the startup comparisons, not counted as a platform regression.

The 327.5ms outlier remains open. Its persisted relative times were input queued
12.6ms, Attempt claimed 88.9ms, provisioning 253.0ms and running 278.0ms. That
cohort also contains one admission `finish` observation in the 100–250ms bucket;
the other nineteen are at most 10ms. Finish includes COMMIT and client callback
delivery. There is no matching per-query wait trace proving fsync versus Worker
scheduling, and this report does not label it a solved storage problem.

## Correctness verification

- 12 new real-PG admission tests: invisible partial state, rollback after lease
  or publication, lost COMMIT reply, connection death before commit, certified
  SQL abort/retry, cancellation-state rejection, preparation requeue/capacity
  release, concurrent Lanes, duplicate claims/capacity, lost Kafka opening ACK,
  and owner-expiry recovery without stealing a bound claim.
- All package tests plus acceptance helpers: **1,061 passed**, three opt-in
  checks skipped. Control Plane was rerun from frozen source: 201/201 passed.
  An earlier sweep overlapped an export rename and cached incompatible test
  modules; that failed sweep is not counted as a pass. The no-external-PG
  PGlite socket driver also failed an extended-query/duplicate-key case; the
  maintained CI real-PG configuration passes that gate.
- Typecheck/build, formatting/docs, runtime policy, image closure and the 26
  deterministic fault gates passed. High-severity dependency gate passed;
  two existing moderate Vitest development-dependency advisories remain.
- A separate paid functional Session wrote/tested insertion sort and binary
  search through real Cube write/bash tools. Both PASS files were fetched via
  the product API. Worker restart retained the conversation verification word.
  A Cube workflow launched branch/fresh children, which returned AMBER/55 under
  the same physical Session, lease and epoch. These functional timings were
  collected during regression load and are excluded from the comparison above.

Total real work: **87 Runs, 94 native assistant responses; 99,821 input,
530,304 cache-read and 2,043 output tokens**. Usage is native provider accounting,
not an independent billing reconciliation. The 80 timing Runs were pure chat.

## Cleanup and remaining work

The 23 conversation views (including two child Lanes), 21 Workspaces, one Cube
and six test tenants/credentials were removed. No development machine was
created. API deletion and Volume purge preceded scoped PG cleanup; all test
publications were sealed and PG recovery progress covered them. The original
live Session, account credentials and model configuration were retained.
Temporary test PG, baseline worktree/images and private test traces are removed.
Shared Kafka/formal service logs retain their normal deployment retention policy.

Next latency work should trace the remaining COMMIT/client-handoff tail and
attribute the residual startup costs. Do not claim that fewer transactions alone
eliminate scheduling, query planning, restore or transient storage stalls.
