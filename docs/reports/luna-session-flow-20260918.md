# One growing Luna Session — September 18, 2026

**History growth did not multiply per-Turn PG commits.** Normal first-text
platform overhead was median **126.715ms**, p95 **249.934ms**, maximum
**455.350ms**. The study also exposed a real context-limit failure; it is not an
all-pass acceptance or a saturation benchmark.

## Scope and method

One disposable tenant, one Session, one elastic Workspace, one existing Worker.
Repository `2e3f4590`, deployed Worker `2ad75f8a`, Control Plane `5c9977fa`.
GPT-5.6 Luna, medium reasoning, Fast off; **1,000,000 configured context and
900,000 automatic-compaction threshold unchanged**. No product code, model
threshold, host power setting, pool size or persistence guarantee changed.

Public frontend APIs submitted 71 sequential Turns over 17.49 minutes:
69 completed, two context-limit failures. All successful native responses name
Luna. Three real provider-backed native Compactions completed. Four coding Turns
created and then extended insertion-sort/binary-search tests: 18 Tool results,
no Tool error, four Bash results containing PASS. Product file APIs confirmed
both scripts and their final six/seven assertions. Marker and file-name recall
passed after every Compaction. Native usage records total **5,344,361 input,
29,483,008 cache-read and 8,814 output tokens**, including summary generation;
these are reported usage, not a reconciled invoice.

Growth used inert SHA-256/base64 fixture lines in ordinary user messages,
normally 92,137–92,139 characters (about 62k actual tokens). They were not written
directly into storage. Fixed short recall probes and approximately 600-word
streaming replies separated history size from current-input/output size. After
the observed overrun, increments above 840k actual input were reduced to 24,139
characters; **the production compaction threshold was not reduced**.

One frontend SSE connection stayed open across each testing phase. Three total
connections were intentional: initial phase, failed-request diagnosis, continued
phase. No automatic reconnection occurred. Measurements end at the frontend
SSE client's receipt, **not browser paint**. One active Run means no slot-capacity
backlog; normal notification/admission delay remains included. Worker payload
cache stayed enabled: this is not a cold multi-Worker restore comparison.

Temporary bounded in-memory probes observed PG query/transaction boundaries and
Kafka append receipts in CP, Worker and Broker. They retained no SQL bindings or
provider credentials. No trace overflow occurred. Instrumentation adds some
unquantified client overhead; results are instrumented observations, not an SLO.
Provider route timing includes CLIProxyAPI. Overlapping intervals are not added
twice. Terminal timing uses the recorded SSE callback, not the test loop's
100ms completion poll.

## What is actually written

For an ordinary one-model-Step chat Turn without a new World State fact,
the code path and traces reconcile to approximately **14 business PG commits**:

| Responsibility | Explicit transaction or autocommit |
| --- | ---: |
| Accept user input | 1 |
| Atomic Run/lease/publication admission | 1 |
| Started and running transitions | 2 |
| Project Kafka execution opening | 1 |
| Project operation+user, sampling, assistant+usage, operation completion | 4 |
| Mark Worker output drained | 1 |
| Settle execution and enqueue seal | 1 |
| Claim and acknowledge seal outbox delivery | 2 |
| Project seal/terminal | 1 |

This excludes renewals and background maintenance. The identity-attributed probe
directly counts 10 explicit write transactions plus one autocommit. Opening
projection and two seal-relay writes are reconciled separately from their SQL
shapes and source: those paths use identifiers the conservative probe did not
attribute. Empty outbox scans are **not** counted as dirty commits. New World
State facts, Tools and extra sampling Steps add work. A one-summary Compaction
added two native-projection transactions, not a rewrite of the entire history.
These commits overlap with execution; they are not fourteen serial startup
barriers. About 163 attributed SQL calls per normal Turn include reads, locks,
BEGIN/COMMIT and renewal checks; they are not 163 disk synchronizations.

Kafka receives one opening, four native appends, a Turn-start event, text-delta
records and one seal in the ordinary case. A short marker reply produced **10
Kafka facts**; a 600-word reply produced **270**, including 263 text deltas.
Both had the same 10+1 directly attributed PG writes. Five streaming probes
produced 187–270 facts each, with unchanged directly attributed business commits.
All **1,981 append receipts** acknowledged; there were no duplicate fact IDs
within a Turn. Native history ended at 510 log records, not token-chunk rows.

Logical commits, records, network batches and physical syncs are different units.
PG remained `fsync=on`, `synchronous_commit=on`, `wal_sync_method=fdatasync`.
Normal-chat measurement windows observed **13–40 cluster-wide WAL syncs**, median
21. The idle baseline was five syncs in ten seconds. Windows include a 1.5-second
statistics-settling allowance and background activity; they are **not exact
per-Session fsync attribution**. PG cumulative statistics can lag and one sync
can serve several commits. [PostgreSQL statistics documentation](https://www.postgresql.org/docs/17/monitoring-stats.html#MONITORING-PG-STAT-WAL-VIEW).

Kafka remained RF=3, `acks=all`, idempotent, four producer lanes, 128-record/2ms
network batching. The study counted logical records/receipts, not network packets
or per-broker fsyncs. Replica acknowledgement must not be reported as one forced
disk flush per record; Kafka's flush policy is separate. [Kafka broker configuration](https://kafka.apache.org/40/configuration/broker-configs/).

## Latency and bottlenecks

Normal successful chat, excluding the four coding Turns and three Compaction
Turns, **62 samples**:

| Span | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| API submission → first provider dispatch | 118.196ms | 243.875ms | 445.629ms |
| Claim/admission transaction | 22.953ms | 32.869ms | 67.195ms |
| Native Session preparation | 15.758ms | 23.720ms | 24.410ms |
| Pi text event → SSE client | 8.728ms | 10.071ms | 12.100ms |
| First text, subtracting matching provider-route wait | 126.715ms | 249.934ms | 455.350ms |
| Last provider response end → terminal received | 95.822ms | 213.061ms | 447.746ms |
| Entire Turn, subtracting provider-route intervals | 216.380ms | 388.264ms | 564.801ms |

Same short recall probe at 317k, 626k and 894k input had respectively
100.564ms, 109.238ms and 121.508ms non-provider first-text time. This small,
single-Worker sample shows modest preparation cost, not a history-proportional
explosion in disk barriers. It does not prove that cold restore or thousands of
Sessions cost the same.

The 210.527ms and 260.781ms startup observations included 100–109ms and
162.504ms COMMIT spans. Another startup reached 445.629ms with multiple long
commit spans. This corroborates the existing commit-tail investigation, but
client query duration alone cannot isolate SSD latency from Node scheduling or
lock waits. Do not attribute every millisecond to storage without server waits.

Kafka append-to-ACK median was **3.908ms**, p95 **4.808ms**, maximum **177.506ms**.
Eight receipts exceeded 30ms; three exceeded 100ms, without overlapping observed
Worker GC. Their exact broker/OS cause remains unproven. Thus Kafka was not the
usual single-Session bottleneck, but it did not have a fixed sub-5ms bound either.
Terminal settlement has a separate 50ms seal-relay polling cadence plus PG work;
it must not be confused with token delivery or model generation.

| Compaction | Pi estimated tokens before | Next actual model input | Summary interval | Whole-Turn non-provider time |
| --- | ---: | ---: | ---: | ---: |
| 1 | 901,436 | 71,877 | 20.389s | 311.014ms |
| 2 | 909,986 | 101,067 | 25.984s | 273.291ms |
| 3 | 915,925 | 71,234 | 22.683s | 271.141ms |

Those large wall-time pauses predominantly belong to real model summarization,
not repeated PG round trips. The complete compaction Turns had 13 directly
attributed PG writes and 13 Kafka records each. Stored entry/log JSON totals are
not physical table/index sizes; PG WAL growth also includes indexes, full-page
images, native-log/projection payloads and current-input copies.

## Actual failure and follow-up

After a successful 873,996-token response, a 92,139-character high-density input
was estimated at about 23k additional tokens by Pi's character-based estimator,
while earlier identical-sized fixtures actually added about 62k. The estimated
total remained below 900k, so no compaction ran before dispatch. Upstream then
returned an SSE `context_too_large` error inside HTTP 200. A further short prompt
failed for the same reason. The UI exposed only `Model request failed`.

The mismatch is confirmed; the provider did not return a numerical usable limit,
so this report does **not** claim to know its exact reserved-output budget or to
have proved that all one-million-token requests are accepted. Configured window
size is not itself evidence of usable provider capacity.

An ordinary low-density test message then crossed the estimator's 900k boundary.
Native Compaction completed in the **same Session**, retaining the failed inputs
and interruption history; no pruning, DB history editing or threshold change was
used. Smaller near-boundary growth increments allowed two more cycles. This is
a controlled experiment continuation, **not a shipped automatic recovery fix**.
The failures remain failures, not successful retries. Five other fixture replies
acknowledged the preceding batch number; marker/file recall and coding passed,
but exact fixture-number instruction following was not perfect.

Next priorities: preserve actionable provider errors and decide how to budget
unseen high-density input safely; then profile/remove only demonstrably redundant
startup round trips and continue attributing commit/ACK tails. Do not weaken
Kafka/PG durability, remove seals, or infer a new middleware requirement from
this single-Session experiment. No maximum aggregate throughput was measured.

## Cleanup

All 71 executions were sealed, released and projected past their seal offsets.
The test conversation, Workspace/Cube Volume, Cube runtime, tenant/account and
scoped database history were deleted. Original 33 tenants, 35 users and one
Session/Workspace remain. All temporary prototype hooks were restored and all
three container-loopback inspector listeners closed. Temporary scripts, private
credentials, raw traces and generated files were removed after report validation.
Shared Kafka/WAL/service logs retain their normal retention; no shared topic or
production log was erased to pretend individual test records had vanished.
The 14 timing/helper tests, documentation check and diff whitespace check passed.
CP, Worker and Tool Broker readiness returned 200 after probe removal/cleanup.
No product source changed, so this was not another full repository test-suite run.

## Per-Turn measurements

¹ Input includes cache reads, excludes generated output; a compaction row shows
the subsequent ordinary request, not the summarizer's input. Failed requests
returned no usable token count.

² Directly identity-attributed successful business write transactions plus
autocommit writes, excluding heartbeat transactions. Conservative lower bound:
the separate opening/seal-relay writes discussed above are not silently included.

³ Cluster-wide observation window, not Session-specific disk writes.

⁴ Provider-route intervals through the matching first text are subtracted.
Coding rows can still include Tool execution if text followed earlier sampling;
they are not included in the normal-chat percentile cohort.

| Turn | Workload | Input tokens¹ | PG attributed commits² | Kafka facts | Cluster WAL syncs³ | Startup ms | Restore ms | First-text internal ms⁴ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | baseline-1 | 6508 | 12 | 10 | 18 | 124.5 | 17.4 | 134.3 |
| 2 | baseline-2 | 6552 | 11 | 10 | 21 | 94.2 | 14.1 | 104.5 |
| 3 | stream-short-history | 6595 | 11 | 270 | 24 | 88.2 | 14.7 | 98 |
| 4 | coding-before-growth | 7921 | 28 | 38 | 49 | 89.5 | 7.6 | 2045 |
| 5 | growth-1 | 69816 | 12 | 11 | 24 | 140.9 | 16.6 | 149.7 |
| 6 | growth-2 | 131721 | 11 | 9 | 14 | 103.3 | 10.4 | 114.4 |
| 7 | growth-3 | 193571 | 11 | 9 | 24 | 210.5 | 9.5 | 220.2 |
| 8 | growth-4 | 255267 | 11 | 9 | 21 | 260.8 | 11.4 | 270 |
| 9 | growth-5 | 316949 | 11 | 9 | 14 | 106.9 | 10.8 | 116.7 |
| 10 | recall-history-5 | 316984 | 11 | 10 | 23 | 91.9 | 15.2 | 100.6 |
| 11 | growth-6 | 378809 | 11 | 9 | 26 | 99.8 | 14.9 | 108.2 |
| 12 | growth-7 | 440667 | 11 | 10 | 24 | 123.7 | 14.6 | 132.9 |
| 13 | growth-8 | 502528 | 11 | 9 | 19 | 111.1 | 15.9 | 119.6 |
| 14 | growth-9 | 564264 | 11 | 9 | 20 | 130.6 | 12 | 140 |
| 15 | growth-10 | 625879 | 11 | 9 | 25 | 121.1 | 15.6 | 130.2 |
| 16 | recall-history-10 | 625914 | 11 | 9 | 18 | 100.4 | 17.1 | 109.2 |
| 17 | stream-history-10 | 625967 | 11 | 238 | 35 | 90.4 | 11.3 | 98.7 |
| 18 | growth-11 | 688468 | 11 | 10 | 23 | 153.6 | 23.7 | 163.6 |
| 19 | growth-12 | 750332 | 11 | 9 | 15 | 118.2 | 24.4 | 126.2 |
| 20 | growth-13 | 812166 | 11 | 9 | 24 | 243.9 | 15.5 | 249.9 |
| 21 | growth-14 | 873977 | 11 | 9 | 18 | 139.5 | 24.2 | 148.3 |
| 22 | growth-15 **FAILED** | — | 12 | 8 | 24 | 120.8 | 16 | — |
| 23 | diagnostic-after-large-input **FAILED** | — | 12 | 8 | 17 | 147.1 | 28.6 | — |
| 24 | boundary-recovery | 71877 | 13 | 13 | 33 | 178.4 | 37.3 | 209.5 |
| 25 | recall-after-compaction-1 | 71932 | 11 | 16 | 16 | 107.6 | 14.9 | 117 |
| 26 | coding-after-compaction-1 | 72940 | 38 | 59 | 67 | 104.7 | 10.1 | 112.8 |
| 27 | growth-16 | 134967 | 12 | 10 | 22 | 130.2 | 17.3 | 139 |
| 28 | growth-17 | 196746 | 11 | 10 | 19 | 120.3 | 13.3 | 128.7 |
| 29 | growth-18 | 258625 | 11 | 9 | 21 | 445.6 | 10.5 | 455.4 |
| 30 | growth-19 | 320452 | 11 | 9 | 22 | 138.6 | 24.1 | 149.6 |
| 31 | growth-20 | 382248 | 11 | 9 | 29 | 190.6 | 18.9 | 199.8 |
| 32 | recall-history-20 | 382284 | 11 | 9 | 22 | 103.3 | 15.1 | 113.1 |
| 33 | stream-history-20 | 382337 | 11 | 187 | 26 | 90.7 | 14.8 | 99.2 |
| 34 | growth-21 | 444829 | 11 | 9 | 20 | 110 | 12 | 118.5 |
| 35 | growth-22 | 506554 | 11 | 9 | 20 | 124.1 | 19.5 | 133.3 |
| 36 | growth-23 | 568277 | 11 | 9 | 27 | 118.4 | 14.9 | 127.9 |
| 37 | growth-24 | 630098 | 11 | 9 | 22 | 125.8 | 16.3 | 136.6 |
| 38 | growth-25 | 691920 | 11 | 9 | 24 | 114.1 | 17.9 | 126.1 |
| 39 | recall-history-25 | 691960 | 11 | 11 | 21 | 113 | 20.1 | 121.5 |
| 40 | growth-26 | 753954 | 11 | 9 | 16 | 133.2 | 21.5 | 142.1 |
| 41 | growth-27 | 815817 | 11 | 9 | 22 | 144.6 | 21.9 | 153.8 |
| 42 | growth-28 | 877644 | 11 | 9 | 30 | 118.1 | 23.7 | 128.4 |
| 43 | growth-29 | 893799 | 11 | 9 | 20 | 119.2 | 19.6 | 128.4 |
| 44 | growth-30 | 909956 | 11 | 9 | 18 | 105 | 15.2 | 113.3 |
| 45 | recall-history-30 | 101067 | 13 | 13 | 40 | 163.9 | 18.3 | 197 |
| 46 | stream-history-30 | 101121 | 11 | 242 | 28 | 120.9 | 18.6 | 129.4 |
| 47 | growth-31 | 163660 | 11 | 9 | 19 | 118.2 | 16.9 | 126.1 |
| 48 | recall-after-compaction-2 | 163708 | 11 | 15 | 17 | 104.5 | 17 | 113.5 |
| 49 | coding-after-compaction-2 | 164746 | 38 | 50 | 62 | 107.2 | 10.5 | 116 |
| 50 | growth-32 | 226547 | 12 | 10 | 40 | 290.4 | 8.9 | 299.4 |
| 51 | growth-33 | 288306 | 11 | 9 | 19 | 102.9 | 12.2 | 111.1 |
| 52 | growth-34 | 350078 | 11 | 9 | 23 | 139.4 | 21.6 | 147.4 |
| 53 | growth-35 | 411861 | 11 | 9 | 14 | 116.5 | 18.2 | 125.6 |
| 54 | recall-history-35 | 411897 | 11 | 12 | 22 | 105.5 | 15.7 | 113.5 |
| 55 | growth-36 | 473890 | 11 | 9 | 21 | 103.4 | 12.3 | 112.1 |
| 56 | growth-37 | 535821 | 11 | 9 | 21 | 97.1 | 11.8 | 108.4 |
| 57 | growth-38 | 597550 | 11 | 9 | 13 | 126.5 | 14.5 | 134.9 |
| 58 | growth-39 | 659280 | 11 | 9 | 34 | 138.5 | 16.4 | 148.5 |
| 59 | growth-40 | 721013 | 11 | 9 | 15 | 129.7 | 18.7 | 137.9 |
| 60 | recall-history-40 | 721049 | 11 | 10 | 25 | 112.8 | 20.7 | 121.1 |
| 61 | stream-history-40 | 721102 | 11 | 235 | 22 | 95.7 | 16.1 | 104.3 |
| 62 | growth-41 | 783697 | 11 | 9 | 13 | 117.8 | 15.6 | 125.5 |
| 63 | growth-42 | 845498 | 11 | 9 | 33 | 140.2 | 14.9 | 149.5 |
| 64 | growth-43 | 861580 | 11 | 10 | 21 | 125.1 | 23.1 | 134.5 |
| 65 | growth-44 | 877698 | 11 | 9 | 22 | 118.3 | 16 | 127.2 |
| 66 | growth-45 | 893795 | 11 | 9 | 17 | 107.9 | 16.4 | 117.9 |
| 67 | recall-history-45 | 893840 | 11 | 10 | 19 | 113 | 13.9 | 121.5 |
| 68 | growth-46 | 909871 | 11 | 9 | 17 | 110.4 | 16.5 | 117.8 |
| 69 | growth-47 | 71234 | 13 | 13 | 44 | 136.7 | 18.4 | 164.5 |
| 70 | recall-after-compaction-3 | 71282 | 11 | 12 | 16 | 94.7 | 9.7 | 102.9 |
| 71 | coding-after-compaction-3 | 72319 | 38 | 60 | 69 | 96.7 | 16.9 | 105.5 |
