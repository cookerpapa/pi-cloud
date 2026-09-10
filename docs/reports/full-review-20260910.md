# Whole-repository review — in progress

Base revision: `cb7bdc9a`. This is a work-in-progress record, not a claim that
every source line or requested live scenario has passed. The wider campaign
includes Compaction, provider switching, UI, Cube, load and process-fault checks.

## First reviewed slice

- Updated the README's component/authority diagram before implementation.
- Removed unused demand-driven Kafka consumption and its subscriber-retention,
  per-partition live reset and offset-only notification APIs. The unified
  Projector still consumes independently of browsers, with both PG recovery
  floors and completed consumer delivery protecting restart.
- Reproduced and fixed stale unhealthy status after a transient seal-relay PG
  failure followed by successful empty polls.
- Reproduced and fixed a backpressured model response which kept waiting for
  `drain` after the Pi client disconnected. The existing cancellation signal now
  terminates that wait and releases the upstream response.
- Added one content-free model transport timing record per request, separating
  raw bytes, parsed frames, nonempty text, Tool preparation and hosted search.
  This does not add a database write or log record per token.
- Repaired obsolete Kafka test fixtures missing physical Session/writer identity.
  Removed the long-context script's old tenant-reuse workaround and fabricated
  HTTP/retry fields; its native usage totals explicitly exclude unrecorded
  Compaction/retry requests.

## Evidence so far

- Baseline full Vitest: 762 passed, 3 environment-gated tests skipped (432 s).
- Focused post-change checks: 27 Projector/seal/live tests, 2 seal-relay tests,
  15 model transport/search-observer tests passed. Both new defect regressions
  failed against the preceding implementations before the fixes.
- Real three-broker Kafka check: one stalled partition recovered all 513 records;
  another partition progressed in approximately 70 ms. Rebalance, older PG
  floor replay and post-PG/pre-delivery failure replay passed.
- Paid baseline model settings: GPT Luna Fast and DeepSeek Pro High completed
  in 7.706 s and 1.942 s respectively. These are full-Run durations, not TTFT;
  the runs preceded rollout of this review's changes.
- After rollout, 6 tenants × 3 Sessions × 2 rounds completed 36 DeepSeek Runs,
  with no context-marker leaks, rejected foreign-tenant reads and one Attempt
  each. Native assistant usage: 7,945 input, 200,448 cache-read, 6,464 output.
  This was a correctness pass, **not a latency pass**: queue p95 was 43.109 s.
  Both deployed Workers had capacity 4 with 3 reserved Child slots, while a
  long-context coding Run occupied one ordinary slot. A capacity-controlled
  follow-up measurement is still required.

The test script previously assumed two capacity-one Workers and incorrectly
required both to receive work in every small wave. It now reports actual
registered capacity/assignments and supports several independent Sessions per
tenant. It does not claim actual concurrency merely from simultaneous submission.

## Preservation and outstanding work

The fresh baseline contained one user Session with six completed Runs, one
Workspace and one running development machine. These are excluded from test
cleanup. Tests use separately identified resources. Final resource/database/log
cleanup, complete review coverage, UI/load/fault acceptance and resume update
are not complete yet.
