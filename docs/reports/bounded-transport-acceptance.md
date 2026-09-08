# Bounded transport acceptance

2026-09-08, candidate based on `e8cd9a73` with a modified working tree.
[Decision](../adr/0158-bounded-transport-backpressure.md).

## Changes and limits

Producer lanes respect Node Writable drain without serializing all Sessions on
PubAck. The count/encoded-byte budget includes queued and submitted-unacknowledged
Facts. Capacity rejection occurs before enqueue; Gate does not retain rejected
payloads in its transport-retry loop. Close drains accepted writes or reports
failure within its budget. No new batching timer, queue service, message authority
or native Session commit bypass was introduced.

Broker has distinct execution, HTTP-reader, sending-byte and completed-cache
limits. Reader abandonment removes callbacks without killing the command. Seals
reject pending old readers; responses already transmitting remain subject to the
canonical Kafka cutoff. A send timeout starts only after a result exists. Result
delivery failure is UNKNOWN, not permission to repeat a command. Limits account
for application buffers, not whole-process RSS; deployments need V8/native/input
and metadata headroom. The one-host profile defaults to eight operations, while
standalone/Helm defaults to 32. HTTP readers default to 128, sending bytes to 32 MiB.

Producer capacity loading is shared by embedded/standalone projection roles;
Broker's single-service Topic override was removed. Compose and Helm expose the
limits, and the optional projector now receives its metrics credential. Docs
distinguish two native semantic checkpoints from command PubAck and PG admission.

## Verification

Full `npm run check`: 708 tests passed, three existing environment-gated skips.
Build, formatting, docs, installer, image closure, runtime budgets, Helm/distributed
values and security audit passed. Web build retains its prior large-bundle advisory.

New tests cover independent producer lanes, Writable drain, count/byte overflow,
ACK-only reclamation, close/error during drain, no outer overflow retry queue,
shared config, command capacity, abandoned readers, pending-read seal rejection,
HTTP finish cleanup and actual slow sockets hitting send bounds/timeouts. The first
full run caught a fixture expecting the removed Broker Topic field; that fixture
was updated to the new capacity contract before the passing full rerun.

## Real Kafka overload and command flow

`PI_CLOUD_LIVE_BACKPRESSURE_CHECK=1 node scripts/run-kafka-backpressure-check.mjs`
used a private R=3 topic and Kafka quota only on one randomly named test producer.
No production Kafka node was paused and no other client's quota was modified.

- Offered: 6,000; acknowledged and consumed: 4,096; rejected before enqueue: 1,904.
- None of the rejected IDs appeared in Kafka.
- Peak encoded pending bytes: 3,832,749, below the configured 4,194,304-byte budget.
- Actual Writable drain was exercised twice; pending count/bytes returned to zero.
- Total test elapsed: 6.934 seconds including deliberate throttling/recovery.

This is an overload correctness experiment, not unthrottled Kafka capacity.
[Raw evidence](transport-backpressure-acceptance-latest.json).

The command regression probe additionally exercised 1/16/128/1,024 simultaneous
synthetic Sessions and 250 sequential 96 KiB results inside an unsealed Run. It
performed 3,759 counting effects with zero duplicates, survived consumer process
loss without replaying old bindings, rejected post-seal work and ended with zero
result bodies/readers. Its small-response HTTP fixture explicitly allows 2,048
readers; this is not a claim about production defaults or 1,024 real KVMs.
At the largest burst it measured 1,021.1 commands/s, p50/p95 25.18/2,459.77 ms, with
receipt publication included in throughput. Both consumers read all 7,523 Facts:
the known replica read amplification remains and was not replaced with unsafe
consumer-group-only routing. [Evidence](tool-result-retirement-acceptance-latest.json).

## Real DeepSeek / Cube / browser

Two coding Runs used the browser/API to write sorting/search algorithms and tests,
then read/edit the same file and rerun tests. Native Bash results verified `OK`
for eight and eighteen tests. Write/edit generation activity and refresh recovery
worked. Total Run times including model/Tool work were 18.962 and 14.837 seconds.
Six raw operations retired through native Kafka results; HTTP readers, sending
bytes and cache bytes returned to zero. Pi usage: input 4,180, output 3,651,
cache-read 64,000 tokens. [Evidence](tool-preparation-acceptance-latest.json).

Across those two Runs, fresh Worker metrics recorded 32 semantic submissions:

| Stage | Total | Mean per submission |
| --- | ---: | ---: |
| Kafka publication | 0.271299 s | 8.48 ms |
| subsequent PG receipt wait | 0.904364 s | 28.26 ms |

Receipt wait includes notifications, scheduling and receipt queries; it is not
SQL execution time alone. These are measured await stages, not a subtraction of
overlapping model/network durations. This small workload does not justify removing
the PG read-your-writes barrier or replacing it with a second working-state system.

## Multi-tenant timing and cleanup

Three tenants × two rounds completed on both Workers, restored all three markers,
denied foreign API reads, leaked no markers and did not invoke Tools. Final client
first-text p50/p95: 1.591/5.169 seconds; queue wait p50/p95: 20/4,049 ms with two
parent slots. These are six samples, not a capacity claim.

The timing probe was corrected to stop at observed SSE terminal rather than after
its audit queries, and to measure queue time to claim separately from preparation.
It records per-Run client monotonic/wall and server times and rejects inconsistent
samples. One earlier batch had incomparable durations; its cause was not established
and its latency numbers are excluded, not presented as a performance gain. Repeated
sampling passed the consistency checks (wall/monotonic differences at most 1 ms).
[Final evidence](multi-tenant-model-load-latest.json).

The original and two diagnostic reruns all passed conversation correctness. Their
nine tenant fixtures plus the coding fixture were deleted only after API resource
release, Volume purge and seal completion. Original counts were restored: 35 users,
52 Sessions. Test topics, quota and temporary containers/browser profiles were
removed; shared production logs keep normal retention. Reports contain no credentials
or full transcripts. Broker sharding and Kafka-only hot execution state remain
separate, unimplemented architecture decisions.
