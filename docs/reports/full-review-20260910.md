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

## Follow-up findings

The first long-context gate executed 16 coding rounds, two native Compactions,
early-marker recall and continued coding on another Worker. It also completed
GPT Fast hosted search, but the gate's final settings assertion failed: its own
submission helper forced `thinkingLevel=off`, overriding the desired `medium`.
That override is removed; the complete gate must be repeated. Recorded assistant
usage was 208,388 input, 8,705,024 cache-read and 187,910 output tokens, excluding
unrecorded Compaction usage. This is not a blanket gate pass.

The active native Session adapter returned newer custom state for a historical
anchor or moved Lane. It also used the wrong newest-first cursor direction and
treated an empty custom-type filter as absent. The corrected fast path is scoped
to current-leaf latest-state or newest-first bounded-context queries; broader
queries retain the native reader semantics. Differential tests compare 1,296
query combinations with pinned Pi, alongside its 29 backend conformance cases.

Increasing test capacity to 16 per Worker exposed two `assignment_lost` failures
in an 18-Run wave. A real PostgreSQL reproduction found a lock-upgrade deadlock:
repeated RunAttempt updates acquire FK `KEY SHARE` locks, then finishers requested
`FOR UPDATE` on the common Worker capacity row. Non-key state/counter mutations
now use `FOR NO KEY UPDATE`, which still serializes writers without conflicting
with key references. See PostgreSQL's [lock modes](https://www.postgresql.org/docs/current/explicit-locking.html)
and [referential-integrity checks](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/ri_triggers.c).
The deterministic real-PG test asserts two executions and exactly two settlement
attempts; the preceding implementation needed a third attempt after deadlock.

After this fix the 36-Run repeat passed with peak claimed-to-settled overlap 14,
balanced 18/18 Worker assignments and no new deadlocks. Latency still failed the
desired target: queue p95 7.061 s, text p95 9.580 s. Model transport timing confirms
substantial pre-model system time, not just slow model output. EXPLAIN isolated
about 103 ms planning versus 0.8 ms execution for the large Run-details JOIN.
Splitting core identity and fixed-ID configuration into smaller queries in the
same transaction reduced core planning to about 14 ms. Live retesting is pending;
no PostgreSQL-wide planner setting was changed.

The smaller-join rollout passed 36 Runs with peak overlap 18. After moving
validation/usage collectors out of the measured streaming window, queue p95 was
1.500 s and text p95 3.204 s on the original 1.5-CPU PostgreSQL quota. System-only
TTFT was still 1.488/2.088 s p50/p95, so this is not a blanket low-latency pass.
A temporary 4-CPU PG quota repeat gave system-only 1.267/1.998 s and provider-route
1.368/3.167 s p50/p95. An intervening sample failed the wall/monotonic clock
consistency check and is excluded; no benefit is claimed from that invalid run.

The real browser gate passed 92 recorded interactions, including model/reasoning/
Fast selection, copy/download, Tool-active Steer/Stop, prune, Fork, live directory
and terminal, named-machine create/pause/resume/release, folder selection, SSH
ticket copying and logout. Steer must now produce the replacement response in
canonical history, not merely an old-or-new response. Browser first text was
3.624 s for its GPT request; this includes provider time. This gate does not yet
cover playable Snake, actual SSH login, every optional integration or the later
multi-service/crash scenarios.

## Subsequent verification

- The corrected long-context gate passed: 15 coding rounds, two native
  Compactions (114,725 → 25,705 and 111,696 → 24,179 estimated tokens), early
  recall, continued coding on another Worker, then GPT Luna medium/Fast hosted
  search on a different Worker. Recorded assistant usage: 259,895 input,
  11,059,968 cache-read and 208,898 output tokens. These totals exclude
  unrecorded Compaction/retry requests.
- Real Snake acceptance passed authenticated host Preview and browser
  start/movement/pause/reset. Its GPT Run used 19 Tools, first assistant text
  was 3.734 s and the complete coding task took 410.734 s. The test machine was
  released, not retained as proof of a permanently available service.
- Two simultaneous Sessions used identical guest ports 3000/8000 without
  cross-Session content leakage; one Session added a 5173 service on its next
  Turn while retaining its original page.
- Control Plane SIGKILL after visible text: Workers retained their boots,
  appended another 35 Kafka records while the Projector was down, and finished
  with one Attempt. One Kafka broker SIGKILL also passed with one Attempt;
  its reconnected/live result exactly matched canonical history and preserved
  the visible pre-failure prefix.
- Owned-machine acceptance passed actual SSH login before/after Tool Broker
  restart, root-filesystem and background-process continuity, pause/resume,
  shared-Workspace Subagent coding, conversation deletion without releasing
  compute, and explicit release with native Volume metadata/byte purge.
  The test's obsolete single-hop Preview client initially mistook the current
  303 Cookie exchange for failure; it now uses the common isolated-origin client.
- Frozen full Vitest: 779 passed, 7 environment-gated cases skipped. A separate
  real PostgreSQL run passed all 35 selected cases, including official backend
  conformance, concurrent settlement, long-ancestry plans and advisory-lock
  connection loss. Typecheck, Helm/config/install checks passed. The dependency
  audit has no high/critical findings; two moderate test-only Vitest findings
  remain (this is not a zero-vulnerability claim).

Additional repairs preserve the current architecture:

- Native ancestry follows strictly decreasing parent sequence with exact-key
  lookups, rather than building an ever-growing visited-ID array and repeatedly
  scanning the Session. On an analyzed isolated 1-CPU PG fixture, 2,000 entries
  took about 26 ms SQL versus 2,716 ms before; 10,000 took about 160 ms. Fresh
  un-analyzed statistics still produced a slower first query; these are not
  unconditional latency guarantees.
- Volume Gateway keeps advisory locks on dedicated direct PG connections, not
  PgBouncer transaction pooling; uncertain unlock sessions are discarded. Helm
  now mounts the configured direct endpoint for this process.
- Live directory enumeration skips entries removed between listing and stat,
  without swallowing unrelated filesystem errors.
- SSH output uses a backpressured stream and explicit disconnect/readiness
  failure. Snapshot reconnects jump to the already-visible text prefix; React
  StrictMode no longer leaves animation cancelled. First-use sidebar sizing and
  cancelled/unmounted drag cleanup have real-browser regressions.
- Removed the old Markdown localhost-to-Preview rewrite; formal Preview Tool
  results remain the application-link authority.
- Retired the unused ACK-only experimental backend/sink and its obsolete
  production-cutover guidance. Production NativeSessionWriter/Projector tests
  retain ACK isolation, uncertain append, concurrent Lanes, Compaction and
  replay coverage; the earlier prototype remains in Git history.

The normal fact-and-citation hosted-search gate passed on DeepSeek Pro → GPT
Luna: 9 and 2 native search/open-page activities, matched live start/completion
pairs, persisted native items/citations and a successful context handoff. The
old marker-only prompt did not reliably induce real search; it is not used as
proof of that capability. Flash returned no search items even in direct
official-endpoint probes with an explicit search choice. That route remains
unverified; the Pro result must not be generalized to Flash.
Whole-repository coverage, remaining pressure/fault/integration scenarios, final
cleanup and resume update are still outstanding.

The last remote CI failure was isolated to the Web image's transitive gRPC-Go
dependency (`CVE-2026-84445`), not TypeScript/tests or the other image gates.
The Caddy build now pins 1.83.2, the upstream
[security patch](https://github.com/grpc/grpc-go/releases/tag/v1.83.2), rather than
adding a vulnerability exclusion. Image rebuild and remote verification follow.

The model-free Worker→Kafka test sustained 22,789/38,488/35,794 records/s with
256/512/1,024 logical Sessions respectively (RF=3, `acks=all`, 256-byte text).
This excludes Projector/PG/Cube/model execution and is not a claim of that many
simultaneous real Agent Loops. An isolated 2-CPU PG test projected 8,000 complete
1-KiB semantic entries at 292.61 messages/s, with no errors and about 4,578 WAL
bytes/message; its 256-way offered concurrency includes connection-pool queue
time. The two measurements are different stages and must not be combined into
an end-to-end throughput claim.
