# Isolated consumption / bounded handoff acceptance

2026-09-07, candidate based on `c8472665` (working tree modified),
[ADR-0155](../adr/0155-isolated-consumption-and-bounded-handoffs.md).

## Implemented

Kafka and its Platformatic producer remain. The Confluent 1.10.0 consumer owns
bounded native queues, per-partition pause/seek, background offset commits and
group assignment. The global promise queue and its unused recovery-mode switch
were removed. Rebalanced/stale batches cannot issue late seek/resume operations.

Seals persist their Kafka position: PG running ahead no longer suppresses valid
pre-seal events. Semantic outcomes/seals co-commit a compact partition checkpoint;
restart begins at that checkpoint or the oldest unsealed start, whichever is
earlier. The Gateway subscribes on demand, discards stale OPEN caches on resume,
and waits for the target partition before creating a cursor-free snapshot. API
startup does not await closed-history replay. Unrecoverable partitions remain
blocked rather than making up missing context.

Native append batches now lock Lane heads, allocate one sequence range, validate
the shared Entry/Record namespace under the Session lock, and bulk-write the
log/projections. A formerly rejected mutation cannot later succeed just because
its short receipt expired. Worker probes are bounded by queue kind, not free
Slot count; successful claims fill capacity immediately. Warm Tool/Volume work
uses the verified Cube data handle without a control-plane GET per operation.
Lifecycle/recovery inspection and Broker Lease/Fence/operation admission remain.
Hosted-search display normalization moved to the lightweight protocol package.

## Measured, without model latency

| Check | Result |
| --- | --- |
| Block partition A with 513 records, continue B | B progressed in 56.7 ms; all 513 A records recovered after release |
| Consumer group rebalance | both partitions continued |
| Explicit recovery floor | read only two selected records instead of the full test history |
| No browser subscription / one subscribed partition | no idle delivery; only subscribed partition delivered; release paused consumption |
| 5,000 closed Attempts, two interleaved passes | 5,000 metadata reads, not the former 10,000 (white-box cache test) |
| Two-item production semantic projection | 21 → 13 SQL statements, including the added recovery checkpoint, excluding BEGIN/COMMIT |

Kafka evidence: [consumer isolation](kafka-consumer-isolation-latest.json).
An initial native-client test took about 960 ms for B; tuning librdkafka's
`fetch.queue.backoff.ms` from its 1-second default to 5 ms removed that wait.
No new text aggregation delay was added.

[Storage ABBA comparison](session-batch-ablation-latest.json): isolated PostgreSQL
with 2 CPU / 768 MiB on the shared WSL host; each arm uses 128 new Sessions × four
two-item atomic appends, concurrency 16. Historical source is loaded only as an
acceptance fixture, never as production compatibility code.

| Arm | SQL/batch in storage layer | Batches/s | p50 / p95 |
| --- | ---: | ---: | ---: |
| Before A | 17 | 294.9 | 39.7 / 98.6 ms |
| After B | 8 | 463.0 | 19.1 / 73.9 ms |
| After B | 8 | 506.7 | 16.8 / 73.2 ms |
| Before A | 17 | 339.5 | 29.7 / 74.9 ms |

This is roughly 1.5× storage throughput, not an Agent capacity or end-to-end
speedup claim. A separate real-PG race held the Session row until two different
Lanes reached sequence allocation: exactly one could claim the same Entry/Record
ID. Both arms replayed their ordered logs correctly.

## Real model / browser / Cube

* Repeated actual DeepSeek Worker-handoff tests passed with REST admission,
  native Pi SDK, consumer restart during an unsealed prefix, SIGSTOP ingress,
  SIGKILL Worker, replacement claim and a deliberately late old mutation.
  The replacement received the visible prefix; late data changed neither PG
  head nor SSE. The last browser also disconnected mid-prefix: its cache was
  released, reopening reconstructed exactly the same prefix, and subsequent
  recovery still passed. [Latest fault report](worker-handoff-probe-latest.json).
* Deployed browser coding: DeepSeek wrote algorithms/tests, executed them in
  Cube, then read/edited the same file and reran tests. Refresh during write
  generation recovered the live indication. Final Bash test outputs contained
  `OK` with no nonzero-exit marker. Total round times were 15.646 / 13.663 seconds;
  Tool preparation appeared at 1.366 / 2.651 seconds.
  [Browser evidence](tool-preparation-acceptance-latest.json).
* A prior coding repetition took 60.885 / 20.784 seconds: the model needed
  13 / 5 sampling steps, with sampling windows totaling 54.400 / 18.838 seconds,
  and corrected failing tests itself. These windows include small protocol/
  projection overhead and are not pure provider-compute timing. Variable model
  work must not be confused with platform throughput.
* Three tenants × two rounds on both deployed Workers: 6/6 completed, three
  restored markers, three foreign API denials, zero cross-tenant marker leaks,
  no unexpected Tools and one Attempt per Run. Acceptance p50/p95: 23/28 ms;
  observed first text: 2.103/7.127 s. Queue p95 was 6.086 s while coding ran
  concurrently: each local four-slot Worker reserves three Child slots, leaving
  one ordinary parent slot. [Load evidence](multi-tenant-model-load-latest.json).

## Deployment, cleanup and limits

Migration 128 and topic generation v3 were deployed after confirming zero active
Runs, terminals and pending seals. User data was preserved. The native addon is
explicitly rebuilt in CI/image installation after script-disabled npm install.
Build, type checking, native backend conformance, installer, Helm, time-budget
and dependency-closure checks were exercised along with package regression tests.
The full package run passed 678 tests, plus an Admin reconnect regression;
three existing environment-gated tests
remain skipped in the default suite, with paid/Cube checks run separately.

All acceptance Workspaces were API-deleted and Volume purge confirmed. The five
exact acceptance tenants/accounts were then removed; original counts returned to
35 users, 52 Sessions and one live Workspace. Private fault/benchmark containers,
topics, groups and temporary baseline source were removed. Shared production
Kafka keeps bounded test records until normal retention; no shared log was reset.
No credentials or full provider request/response bodies are included here.

Demand-driven consumption is not exclusive global Gateway sharding: replicas
with viewers on the same partition may both consume it. Large-cluster routing
and multi-node HA require separate measurement. The change does not promise
physical Cube fencing, exactly-once Shell effects or recovery beyond retention.
