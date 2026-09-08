# Kafka ACK-only native Session append experiment

2026-09-08; baseline `ecbd1a59`, ADR-0160. **Experiment passed; production has
not switched SessionStorage protocols.** The normal Worker still uses PG
projection receipts. The separately fixed Compaction safety check is suitable
for the maintained path.

## What ran

Pinned Pi 0.84.1 `Session` and public `InMemorySessionStorage` construct native
Entries/Records, parents, sequence and timestamps. A backend-neutral adapter
serializes append within one physical Session and returns only after Kafka ACK.
Readers cannot observe unacknowledged changes. A potentially accepted append
with a lost response stops that writer; it does not roll memory back and reuse
the sequence. Different Sessions remain concurrent.

The isolated sink uses the existing Platformatic/Confluent dependencies, a
private eight-partition Kafka topic with R=3 / minimum ISR 2 / `acks=all`, a
2-CPU/1-GiB sink container and a separate 2-CPU/1-GiB PostgreSQL container. The
prototype's PG tables project fully materialized records; they are not the
production schema. An authenticated loopback endpoint adds the same HTTP hop to
both variants. No model requests occur during the latency comparison.

## Writer latency, not a Kafka capacity claim

Each Session appends twenty roughly 1-KiB semantic records and one seal. Both
variants use identical Pi state, Kafka publication and PG work. The `pg` variant
additionally waits for a post-commit PG notification; `fast` returns at Kafka
ACK. The normal PG sample has no injected delay. Slow-projection samples add
25 ms per consumed Fact to model a delayed downstream.

| Sessions | Injected projection delay | Wait-PG p50 / p95 | Kafka-ACK p50 / p95 | Writer acknowledgements/s, PG → Kafka |
| --- | --- | --- | --- | --- |
| 1 | 0 ms | 18.03 / 19.77 ms | 6.06 / 6.75 ms | 42.0 → 134.9 |
| 16 | 0 ms | 76.89 / 148.12 ms | 18.70 / 28.43 ms | 181.2 → 701.2 |
| 1 | 25 ms | 39.20 / 41.57 ms | 3.00 / 3.75 ms | 22.5 → 323.7 |
| 16 | 25 ms | 213.73 / 365.13 ms | 18.14 / 28.44 ms | 64.9 → 746.4 |

The test drains PG **outside** the fast writer measurement before starting the
next case. This is not a claim that PG can ingest 746 Facts/s indefinitely or
that Kafka's maximum throughput is this low. Removing the wait allows a bounded
burst to advance ahead of projection; sustainable capacity still depends on
the consumer, and retention/backpressure remains necessary. Delaying projection
also changes CPU contention, so the slightly faster ACKs under injected delay
must not be interpreted as slow PG making the whole system faster.

## Correctness and real process failure

- With no projector process running, forty Facts (39 native items plus seal)
  were acknowledged across main, inherited Child and fresh Child Lanes while
  PG contained zero projected items. Starting projection produced the exact log.
- A real `SIGKILL` stopped the projector. Another process resumed from PG-stored
  Kafka positions, restored exact native metadata and did not reapply duplicates.
- A delayed old-writer Fact after its seal was excluded, including after a new
  writer continued from the recovered prefix.
- The sink deliberately dropped an HTTP response **after** real Kafka ACK. The
  caller failed and stopped its writer; PG later contained the one accepted
  entry, with no automatic repetition or sequence reuse.
- Six adapter tests cover ACK-gated reads, concurrent Lanes, uncertain append,
  recoverable validation failure, atomic batch publication, seal and exact replay.

These fixture cutoffs are not a replacement for production ExecutionLeases,
the Authority Gate or Cube's final execution checks.

## Paid model and real Cube

The accepted run used DeepSeek V4 Flash and a disposable Cube development
machine. Pi ran in the test process; file/shell operations crossed the existing
authenticated terminal API into Cube, never into the host shell. This exercises
the proposed persistence boundary, not a production Worker/Broker/SSE cutover.

The projector was stopped throughout all four Agent Runs:

| Run | Work | Elapsed, including model |
| --- | --- | --- |
| 1 | Implement insertion sort, binary search and tests | 10.090 s |
| 2 | Read existing files, add heap sort and regression tests | 7.487 s |
| 3 | Receive a long auxiliary-vector message as a normal user turn | 9.302 s |
| 4 | Continue after Compaction, inspect and run all tests | 22.151 s |

Seven actual Cube Tool calls, four native Compactions, 22 generated tests and
an independent 100-random-array check passed. Every summary and the final reply
retained the initial project marker. After projection restarted, every native
record matched the acknowledged in-memory log exactly.

Native usage Records for this accepted trial reported **83,666 uncached input,
6,882 output and 93,824 cache-read tokens**. Earlier failed trials/probes are not
included in those totals. The model retained its real 128,000-token window;
the experiment advanced the compaction threshold to about 16,000 tokens via
the reserve setting. This is not a near-128K capacity benchmark. A large retained
user message can remain large after compaction; no bounded-import claim follows.

## Failures found and corrected

Early fixture runs incorrectly reduced the model's declared context window to
force Compaction. Pi also uses that value to clamp output tokens. A captured
response had input plus cache near 31K, only 16 output tokens and `stopReason=length`
against a declared 16K window. Such responses cannot demonstrate completed
coding or storage loss. The fixture now keeps the real window, configures the
reasoning capability/Off mapping consistently, adjusts only compaction policy,
and rejects length-limited coding completions. Long test input is a normal Run,
not an uncompleted user message injected between Runs. Diagnostic comparisons
now compare raw user text rather than searching escaped JSON for a multiline prompt.

Separately, pinned Pi accepts empty/length-limited summarization as a success.
The maintained Cloud adapter now rejects those summary responses before a
Compaction Entry can replace the active branch. Regression tests cover empty,
thinking-only and truncated summaries: no compaction is committed, no subsequent
sampling uses it, and the original context remains available.

## Why production was not switched

The final negative control reproduces a real remaining ownership conflict:

```text
Worker's last native sequence = 1
PG-side repair inserts sequence 2
Worker prepares sequence 2 and receives Kafka ACK
Projector expects sequence 3: conflict, partition stops
```

This is expected test evidence, not a deployed incident. Today's Child Lane
creation and seal-time interrupted-prefix repair can write the native PG log
outside the active Worker. Child startup also queries the parent's prompt in
PG. Those paths must share the same ordering contract before production can
stop waiting on per-Step projection. The prototype additionally keys by the
physical Session, whereas deployed Facts are keyed by product Session.

Next cutover work: unify all native writers and their lifecycle boundaries;
add bounded compaction-aware bootstrap instead of fixture full-log replay;
integrate physical-Session ordering with existing per-Run seals/Tool commands;
protect unprojected accepted data against retention expiry. This does not
require another database or making Pi's Agent Loop know about Kafka/PG.

## Reproduce and cleanup

Full `npm run check` passed: 733 tests, three environment-gated integration
tests skipped. The six experiment tests and its separate TypeScript check also
passed. The Compaction protection was deployed to both existing Workers without
enabling the experimental backend or changing Cube templates.

See [the experiment README](../../experiments/kafka-session-append/README.md).
Private topics, sink/projector/PG containers, all six trial machines and their
Volumes, and their test identities were removed. Existing production totals
returned to 35 users / 52 Sessions. No user data reset or shared Kafka/log purge
was performed. Only this redacted report is retained.
