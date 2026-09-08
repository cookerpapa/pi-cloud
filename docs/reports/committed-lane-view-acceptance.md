# Committed Lane view: acceptance and PG barrier assessment

2026-09-08. Baseline: `f248f428`; implementation: ADR-0159. Same Pi 0.84.1,
PostgreSQL SessionStorage, Kafka AcceptedFact path and Cube guest protocol.

## Scope and correctness

The Worker now loads a bounded branch once per Run/Lane, then updates a private
view from successful PG mutation receipts. Model Steps receive copies, so a
Provider transform cannot corrupt the committed view. The view is discarded at
Run completion. Compaction replaces its prefix; cold Runs and replacement
Workers still restore from PG. General SessionStorage queries are not cached.

42 targeted tests cover the original and cached runtime paths, concurrent
branched Lanes, global sequence gaps, native Compaction/retained Harness facts,
replacement Runtime recovery, product follow-up, model retry, visible interrupted
text, UNKNOWN Tools, failed writes, duplicate receipts, invalidation races and
clone isolation. A delayed Tool-intent receipt prevents the effect from starting;
a rejected intent becomes Pi's normal error Tool Result without invoking the
Tool. It need not fail the entire Run if the model can subsequently answer.
The upstream backend conformance suite remains unchanged.

Final `npm run check` passed: 730 tests, three explicitly environment-gated
integration tests skipped. Build, formatting, documentation, Helm/distributed
values, runtime time budgets and image dependency closure checks also passed.
The paid Cube/browser check below is separate from those skipped integration
gates; it is not a claim that every physical failure scenario was rerun.

## Model-free ablation

Reproduce with `node --import tsx scripts/run-lane-view-ablation.ts`.
The script creates and removes a private PostgreSQL container (2 CPU, 1 GiB),
uses 16 connections, and makes **zero model or Kafka requests**. Both paths await
the same durable PG append on every Step. It compares real native branch reads
with committed in-memory snapshots, including the latter's cloning cost.

Every Session runs 12 Steps. Synthetic context uses compressible ASCII payloads;
these are byte sizes, not token counts or a production capacity guarantee.
Two passes reverse variant order to expose warm-cache effects. Final cached
Entries are compared against the real PG branch, including native metadata.

| Context / concurrent Sessions | PG branch reads, old → new | Read p50 ms, old → new | Read p95 ms, old → new | Read + durable-append Steps/s, old → new |
| --- | --- | --- | --- | --- |
| 64 KiB / 16 | 192 → 16 | 17.0–17.5 → 0.078–0.090 | 78–113 → 12.6–14.0 | 159–174 → 383–418 |
| 1 MiB / 16 | 192 → 16 | 116.6–117.7 → 0.432–0.499 | 198–205 → 125–155 | 67.5–71.5 → 188–240 |
| 8 MiB / 4 | 48 → 4 | 305–307 → 2.70–2.83 | 395–475 → 313–342 | 9.2–9.8 → 41.7–45.7 |

The new p95 still includes cold reads: one of twelve samples per Session is a
storage load. There is no claim that all reads become sub-millisecond. Estimated
materialized JSON bytes per pass fall from 202,634,800 to 16,823,136 in the 1 MiB
case. These are not packet-capture network bytes. Throughput includes durable
append, fixture bookkeeping and final consistency verification, not Agent Loop
or Kafka capacity. Fewer downloads also reduce contention for writes; this does
not show that the PG write protocol itself became faster.

The tradeoff is an additional active branch retained per Lane plus transient
snapshot copies. This is not a cross-Run hot cache, and it does not eliminate
authority, Record, lane-head or projection-receipt queries.

## Real paid coding and browser path

Reproduce with
`PI_CLOUD_LIVE_TOOL_PREPARATION_CHECK=1 node --import tsx scripts/run-live-tool-preparation-check.mjs`.
Updated both existing Workers; did not restart Cube or change guest templates.
DeepSeek V4 Flash ran two coding rounds through browser/API, native Pi, Kafka,
Broker and real Cube KVM:

| Round | Result | PG context loads / memory reads | Observed completion |
| --- | --- | --- | --- |
| Create insertion/merge sort, binary search and tests | 20 tests passed | 1 / 2 | 17.868 s |
| Read existing code, edit in heap sort and regression tests | 29 tests passed | 1 / 3 | 11.750 s |

Browser showed animated write/edit preparation, restored preparation after a
refresh, and replaced it with execution/completion. Six raw Tool operation
results were retired through native Kafka acknowledgements; result cache,
pending HTTP readers and sending-byte reservations returned to zero.

Across 32 native semantic submissions, Kafka publication averaged **7.345 ms**;
subsequent PG projection/notification/receipt wait averaged **22.724 ms**, totaling
0.727 s. Receipt wait is not a database query-only measurement. End-to-end times
include the model and are a correctness smoke test on the shared development
host, not a matched before/after model-latency benchmark.

Actual usage: 2,914 uncached input, 2,991 output, 65,536 cache-read tokens across
seven completed model responses. Compaction/fault variants above are deterministic
tests; this paid two-round check did not trigger native Compaction.

The test conversation, Workspace/Volume and acceptance identity were purged.
Existing 35 users and 52 Sessions remain; only redacted measurement reports are
retained. The private PG benchmark container was removed. Shared service/Kafka
history follows normal retention, not a destructive global purge.

## Can the PG barrier be removed?

**Not as an await-removal optimization under the current contract.**

1. A Kafka PubAck confirms a durable accepted mutation request, not successful
   application to the canonical Pi Session. The projector can return a final
   rejection, and post-seal requests cannot update the old Lane.
2. The successful receipt confirms the Entry identity and supplies its actual
   parent, Session sequence and timestamp. The memory view uses that metadata;
   it does not speculate about a concurrently advancing multi-Lane log.
3. Complete model output and validated Tool intent retain their before-effect
   durable boundaries. Successor claim still waits for the old execution seal
   and interrupted prefix to be projected before loading context.

Removing the active-path PG wait is possible only with a separately approved
write contract that defines canonical acceptance and deterministic metadata
before returning to Pi, plus failure/seal/recovery tests. Otherwise an SDK call
could appear successful locally but fail in PG after a dependent effect starts.
Keep the present write boundaries: this sample's 0.727 s receipt wait across
29.618 s of paid coding does not justify that authority-model change. This is a
measured decision for the tested workload, not proof of unlimited PG scalability.

## Broker sharding decision is still pending

No consumer-group-only switch was made. Session-keyed Kafka partitions do not
match Workspace-owned runtimes: multiple Sessions can use one Workspace, and a
Session can later rebind. A shared consumer group therefore needs approved
owner routing, durable binding routes and ordered seal/result retirement across
that forwarding boundary. This adds an internal RPC for some commands. That
architectural tradeoff was raised for user confirmation; the memory-view change
does not pretend to solve Broker read amplification.
