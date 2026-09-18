# Per-Run startup attribution and SQL simplification — September 18, 2026

Instrumentation baseline `9433e22f`; optimized application `5c9977fa`. One Compose
Worker with four family/model slots; existing PostgreSQL/Kafka/Cube limits and
durability. No host power setting changed after the previous trial restored
Quiet hardware mode and the original Windows plan.

**Publication registration is consistently cheaper. Whole-startup measurements
remain variable; this is not a proven universal latency or concurrency gain.**

## Changes

Existing claim/preparation histograms now have corresponding content-free
per-Run records. They record start times and monotonic durations, not SQL,
prompts, credentials or Tool output. Shared preparation measurement replaces
duplicate timing wrappers. Diagnostic failures cannot change operation outcomes.
There is no per-token diagnostic, new PG query or new persistence barrier.

The publication lookup previously joined an authority view and then rejoined
three tables already present inside it. It now uses the view's existing identity
and writer fields plus two scalar primary-key reads for fields outside the view.
This reduces the main join graph from eight tables to five. All identity checks,
lease expiry, `accepting_effects`, writer failure/seal rejection and existing row
locks remain. No permission result is cached or trusted longer.

An interleaved read-only EXPLAIN probe used the old/new SELECT shapes against an
owned completed Attempt, twelve fresh connections per shape. Both returned zero
rows: this measures planning, not live admission execution or lock contention.
Planning medians were **16.757ms → 11.430ms** (ranges 14.722–22.379 and
10.005–16.600ms). It is consistent with the planner's documented
[join-search behavior](https://www.postgresql.org/docs/17/explicit-joins.html),
without changing global planner settings.

The started transition's already-locked Turn and Session updates now share one
CTE round trip instead of two. Both affected-row counts must still be one, or
the entire transaction rolls back. The number of durable commits is unchanged;
claim, started, running and Kafka boundaries are not collapsed or skipped.
This does not eliminate the [host WAL-storage tail](startup-wal-tail-20260918.md).

## Paid before/after measurements

Each cohort used two disposable tenants/four Sessions: eighteen sequential
GPT-5.6 Sol Turns, then two waves of four concurrent Turns. Medium reasoning,
Standard service, identical short reply prompts; no builds or test suites ran
during measurement. PG claim/settlement timestamps confirmed a peak of four
overlapping Runs in every cohort. All 78 timing Runs completed with their
expected replies.

Times below are API submission → model upstream dispatch, excluding provider
generation. Sequential statistics exclude each cohort's first Turn (17 samples);
concurrent statistics include eight samples. Medians average the middle pair
when sample count is even.

| Cohort | Sequential median / mean / max | Four-concurrent median / max |
| --- | --- | --- |
| Before | 125.533 / 148.799 / 274.642ms | 228.013 / 451.295ms |
| After | 126.630 / 131.833 / 183.422ms | 315.989 / 485.397ms |
| After, repeated | 105.275 / 121.543 / 227.412ms | 208.405 / 358.369ms |

First-Turn startup was 388.858ms before and 360.131ms on the first after-pass;
these are initialization observations, not a controlled cold-start benchmark.
The repeat used the surviving optimized processes. These small, non-randomized
cohorts do not establish a general percentile/SLO. In particular, the first
after-pass's concurrent result regressed, while the repeat improved; do not
claim a stable concurrency improvement or silently report only the best cohort.

Sequential stage medians, measured for those same Runs:

| Stage | Before | After | After repeat |
| --- | ---: | ---: | ---: |
| Full claim/admission transaction | 40.950ms | 34.662ms | 29.867ms |
| Publication registration, inside claim | 11.631ms | 5.677ms | 5.007ms |
| Durable started transition | 13.994ms | 11.802ms | 10.141ms |
| Kafka opening ACK | 4.590ms | 4.546ms | 4.388ms |
| Durable running transition | 9.563ms | 7.536ms | 8.012ms |
| Native Session open | 13.264ms | 13.117ms | 12.332ms |
| Model runtime setup, parallel with Session open | 1.090ms | 1.114ms | 0.930ms |
| Initial World State capture | 0.109ms | 0.111ms | 0.088ms |

Do not add nested/parallel spans or individual medians. The first-text Pi event
→ SSE client medians were 10.989/10.004/9.911ms; maxima 22.415/12.359/14.130ms.
These are client receipt, not browser paint. Local Model Gateway pre-upstream
processing was about 0.5ms in the before/first-after sequential cohorts; the
remaining approximately 20ms after World State includes native operation/input
and sampling appends plus SDK preparation, not a proven network-only cost.

## One actual timeline, not a sum of medians

The repeat cohort's third Turn took 105.275ms before model dispatch:

| Observed stage | Start relative to submission | Duration |
| --- | ---: | ---: |
| API acceptance and time until claim begins | 0ms | about 32ms |
| Claim | 32ms | 18.628ms |
| Durable started | 52ms | 8.793ms |
| Kafka opening | 61ms | 4.388ms |
| Durable running | 66ms | 8.948ms |
| Native Session open | 75ms | 13.724ms |
| Model setup, overlapping Session open | 75ms | 0.827ms |
| World State | 89ms | 0.065ms |
| Remaining native/SDK/local model-route work | about 89ms | about 16ms |

The API response reached the client at 33.119ms, after claim had already begun;
it is not another serial interval to add. Wall-clock start timestamps have
millisecond resolution; durations are monotonic. Small gaps/rounding are not
independent measured stages. Provider first text then took 2294.835ms; total
non-provider first-text time was 115.392ms. This preserves a concrete per-Run
breakdown without pretending every remaining millisecond is CPU or disk time.

## Correctness and cleanup

`npm run check` passed **1,073 tests**, with three existing opt-in checks skipped
(Kafka topic policy and two standalone Cube provider checks). All workspace
typechecks passed. A separate focused real-PG run passed 41 tests, including seven
new mismatched-scope/failed-writer/sealed-writer cases, a startup-write count check,
lease expiry while blocked, rollback, lost COMMIT acknowledgement, cancellation,
and native Parent/Child recovery with PG projection paused.
Application/image builds, repository formatting and documentation checks passed.
All [26 deterministic fault gates](fault-eval-latest.md) passed; those are not
a new full live-chaos or browser-interaction audit.

Real Cube acceptance wrote insertion sort, then read/preserved it and added
binary search. Bash ran the Python assertions across both Turns; product file
APIs retrieved both scripts and PASS markers. Seven file/shell Tools completed.
After actual Worker process replacement, the same conversation recalled its
marker. Two direct Subagent calls then produced a branch child returning that
marker and a fresh child returning 55. Both completed under the parent's physical
Session and lease, and the parent received both results. These four parent Runs
and two children are functional evidence, not part of the timing comparison.
Their parent startup times were 138.322/143.437/325.073/142.447ms; the third is
the first request after Worker replacement, not warm-session latency.

Total real work: **84 Runs, 92 native assistant responses; 89,636 input,
533,376 cache-read and 1,988 output tokens**. Native usage is not an independent
billing reconciliation. Seven test tenants, fifteen conversation views, thirteen
Workspaces and one Cube runtime were removed after API deletion, storage purge,
seal/projection verification and scoped PG cleanup. Original accounts, the
original live Session/Workspace and model configuration were preserved. Test PG
and its databases were removed. Temporary scripts/traces/logs were removed after
aggregation; shared Kafka/PG/formal logs keep their normal retention policy.

Remaining work: explain concurrent startup variability and the residual native
append/SDK interval with the same per-Run evidence. No architecture change is
justified by this sample, and no bounded-latency guarantee is claimed.
