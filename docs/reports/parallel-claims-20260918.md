# Two-way Worker claim acceptance — September 18, 2026

**Retain the bounded two-way claimant.** Matched serial/two-way comparisons
improved four-concurrent startup modestly and reduced the delay before admission.
They do not eliminate cold-start, client scheduling or WAL-storage tails.

## Implementation and boundaries

Serial application `5c9977fa`; comparison candidate `4852188e`; final Worker
`2ad75f8a`. Control Plane remained `5c9977fa`. One Worker, four family/model slots,
four Worker PG connections, 2 CPU/2GiB; existing PG/Kafka/Cube settings and host
power configuration unchanged. See [ADR-0175](../adr/0175-bounded-parallel-claims.md).

At most two claims are pending. Each unknown claim conservatively reserves a
possible new family and Lane occupancy before its committed identity is known.
The reservation releases exactly once on claim notification or unclaimed
completion/failure. Executions remain tracked through settlement. PG retains
atomic capacity/ownership, same-Lane FIFO, lease/fence and predecessor-seal checks.
No new pool, table, scheduler, runtime mode or increased model concurrency.

A separate deterministic test reproduced a queued-work notification arriving
while older empty probes were outstanding. The notification was consumed while
both probes were busy; their empty completion did not rescan until the periodic
poll. The message remained durable, but could wait an extra polling interval.
The final fix tracks new queued-work signals separately from capacity wakes.
Completion rechecks a newer signal without allowing empty probes to wake each
other indefinitely. Both PG NOTIFY and owned-child hints are covered. This fix
was applied **after** the four comparison cohorts, not mixed into their speedup.

## Serial / two-way / serial / two-way

Each cohort started a fresh Worker process from its saved immutable image and
created two tenants/four Sessions. Eight sequential Turns warmed one Session;
six waves of four concurrent Turns followed. All used GPT-5.6 Sol, medium,
Standard, and identical short reply prompts. No builds, profilers or test suites
ran during timing. All 128 comparison Runs returned the expected replies.

API submission → model upstream dispatch, **excluding model generation**:

| Cohort | Sequential median, excluding first (7) | Four-concurrent median (24) | Concurrent p95 | Concurrent maximum |
| --- | ---: | ---: | ---: | ---: |
| Serial 1 | 133.673ms | 200.381ms | 332.474ms | 344.291ms |
| Two-way 1 | 133.466ms | 183.493ms | 287.727ms | 288.371ms |
| Serial 2 | 140.586ms | 225.914ms | 374.486ms | 405.614ms |
| Two-way 2 | 130.481ms | 202.613ms | 298.486ms | 347.726ms |

Across the two cohorts per version, 48 concurrent samples each:

| Metric | Serial | Two-way |
| --- | ---: | ---: |
| Startup median | 213.499ms | 194.067ms |
| Startup mean | 219.831ms | 199.718ms |
| Startup p95 | 364.352ms | 296.482ms |
| Submission → claim-start median | 87ms | 44ms |
| Submission → claim-start p95 | 213ms | 101ms |

Startup median improved about **9%**, p95 about **19%** in these samples.
Both adjacent comparisons improved concurrent median/p95. Single-request
results do not establish a reliable improvement. PG timestamps confirmed four
overlapping Agent Runs in each cohort; correlated claim spans showed one versus
two overlapping admissions. The speedup is smaller than the reduction in queue
wait because claim transactions still contend on shared Worker capacity state.

These are small one-host cohorts, not a capacity benchmark or SLO. Percentiles
use nearest rank; medians average the middle pair. Client receipt is not browser
paint. First initialization and provider latency are not silently subtracted
from the concurrent samples or claimed as benefits of parallel admission.

## Final correctness checks

- Initial two-way candidate: all typechecks and **1,081 tests passed**, with
  three existing opt-in checks skipped. Final wake fix: Worker **71/71** and
  targeted actual-PG **41/41** passed; affected packages passed typecheck.
  Do not interpret those targeted reruns as another full-suite run on the final
  commit. The failing notification reproduction was rerun and passed.
- Actual PG integration holds two distinct admission connections before commit,
  then checks capacity two/third family queued, no consumed third Attempt,
  same-Session follow-up blocked with a free slot until the seal projects, and
  correct release on drain. Existing cases cover cancellation, owner expiry,
  lost COMMIT reply, rollback and lost Kafka opening ACK.
- All [26 deterministic fault gates](fault-eval-latest.md) passed. The report
  captured `4852188e` with a dirty worktree containing the already-written wake
  fix, subsequently committed as `2ad75f8a`; it is not a clean-checkout run at
  the former revision. No product source changed during those fault cases.
- Final deployed Worker: eight additional real GPT requests in two four-way
  waves completed. They intentionally started without the comparison warm-up;
  one cold startup reached **496.430ms**. This is not evidence of a fixed
  sub-200ms startup bound or the earlier wake-up race recurring.
- Real Cube coding wrote/tested insertion sort, then added/tested binary search
  while preserving the original file byte-for-byte. Product APIs retrieved
  scripts and PASS markers. A Worker process restart retained the marker.
  A Cube workflow used `runs.all` for inherited/fresh children; they returned
  the marker and 55, shared the parent's physical Session/lease, and overlapped
  for **2.423 seconds**. The parent received both results.

Total real work: **142 Runs, 148 native assistant responses; 110,454 input,
871,040 cache-read and 2,401 output tokens**. These are native usage fields,
not independently reconciled billing. The live restart was between coding Turns;
the remaining crash cases above are targeted fault tests, not a new distributed
chaos or full UI audit.

## Cleanup and remaining work

Eleven test tenants, twenty-three conversation views, twenty-one Workspaces and
one Cube runtime were removed after API deletion, Volume purge, execution release
and committed seal/projection checks. Two isolated test-PG containers and their
databases were removed. Original accounts, the original Session/Workspace,
provider credentials and production storage were preserved. Temporary scripts,
raw traces/test logs and the two comparison-image tags were removed; current
production images remain. Shared service logs/Kafka/WAL retain their normal policy.

The final deployment keeps two claims and the notification fix. Further tail
work should distinguish PG server I/O from Node callback/CPU scheduling and
cold initialization; do not relax durable ACKs or add middleware to conceal them.
