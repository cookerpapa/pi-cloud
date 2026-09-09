# Tool Broker sharding acceptance

Date: 2026-09-09. Tested working tree based on `f23800a4`; this report accompanies
ADR-0162's implementation commit. Production schema 133; Cube/guest templates
unchanged. Aggregate evidence is retained; private test transcripts are not.

## Result

Broker replicas now share a consumer group **within one Sandbox Domain**, retaining
physical Pi Session Kafka keys. A new partition owner restores immutable binding
routes from PostgreSQL. Small positioned records go to the exact owning Broker
boot; Worker raw-result reads go directly to that owner. Deltas do no routing SQL
or forwarding. First binding/route discovery and seal routing still use PG;
this does not reintroduce per-Step native projection receipts.

Two real production Broker replicas each owned 16 of the existing topic's 32
partitions. The temporary replica was removed after acceptance; normal deployment
is back to its original one Broker. Increasing replicas now partitions consumption,
but does not migrate VMs, remove effect authority checks or add arbitrary shell replay.

## Verification

- Full suite: **751 passed**, 3 explicit environment-gated skips. Updated schema
  inventory to 133. Replaced two fixed-sleep Subagent queue tests with bounded
  observation of actual dispatch readiness; the sequential suite no longer leaks
  a queued Child into subsequent capacity tests.
- Type checks, installer contract, image closure, Helm, documentation and runtime
  time-budget checks passed.
- Unit/PG/HTTP contracts cover immutable Attempt/boot routes, multiple Attempts
  using one machine binding ID, cross-tenant route isolation, writer-wide lookup,
  discarded deltas, slim result notifications, credential separation, stale boots,
  lower-offset suppression and large owner-direct results.
- Real Kafka: two OS-process routers, two owner HTTP servers, RF3. Their steady
  partition assignments were disjoint. Each run exercised **3,762 effects with zero
  duplicates**, including 1,024 concurrent logical Sessions. Killing the router
  after the owner admitted a command but before offset resolution preserved
  deduplication and result retirement after reassignment. Lost HTTP ACKs, duplicate
  commands, seals, long-running work and 250 successive 96 KiB results passed.
  Final retained result bytes were zero. Largest forwarded control record: 721 bytes.

[Four-partition evidence](tool-command-sharding-acceptance-latest.json) and
[32-partition evidence](tool-command-sharding-p32-latest.json) use a **counting
executor**, not Cube. Route discovery is an IPC fixture, not production PostgreSQL.
Both real Kafka and HTTP paths run within a 3-CPU/2-GiB test container. The final
32-partition repeat, after other acceptance workloads stopped, reached about
**1,026 commands/s at 1,024 logical Sessions**; single-Session p50 command round trip
was 11.4 ms. This is not full Agent throughput or Kafka's capacity limit. A prior
run overlapping the full test suite and paid model/Cube work reached only 421
commands/s, demonstrating shared-host contention. Do not infer a controlled
speedup over older full-log consumption reports from these different workloads.

## Real user/API and Cube checks

[Production acceptance](cubesandbox-production-acceptance-latest.json): GPT-5.6
Terra made 19 real provider calls (36,053 input, 2,382 output, 166,656 cache-read
tokens). Pure chat created no Cube. Coding, Preview, later edits and a background
process shared the warm VM. A separate 1,025-file Workspace was restored in a
fresh Cube and continued to 1,026 files. Cross-tenant access was denied.

[Forced remote-owner check](tool-command-sharding-live-latest.json): a new browser
account used the same Web API/SSE client as the UI. Its Session was selected in
the second Broker's partition assignment while its Cube remained on the primary.
Two DeepSeek Flash coding Runs used read/write/edit/bash and completed their tests.
Seven provider calls consumed 1,909 input, 1,989 output and 58,240 cache-read tokens.
The live metrics confirmed **15 remote deliveries, mean owner-admission latency
3.73 ms**, excluding Cube execution. Run elapsed times were 9.85/7.26 seconds;
first visible text was 9.11/1.86 seconds (the first Run generated Tool work before
its answer). Those first-text values include model generation and are not RPC latency.

## Reproduction and cleanup

`PI_CLOUD_LIVE_TOOL_COMMAND_CHECK=1 PI_CLOUD_TOOL_COMMAND_PARTITIONS=32 node
scripts/run-kafka-tool-command-check.mjs` runs a private Kafka/HTTP fixture and
deletes its topic, group and containers. The process fixture is test-only, not a
second deployment service.

The local Compose live probe requires two Ready Broker replicas in the same
domain, with the same Broker-only dispatch secret and distinct advertised URLs.
Set `PI_CLOUD_TEST_BROKER_CONTAINER` to the temporary replica and run
`PI_CLOUD_LIVE_TOOL_SHARD_CHECK=1 node scripts/run-live-tool-sharding-check.mjs`.
It reads actual group assignment, uses real model tokens, and releases the test
conversations/Workspace through the product API. Its API-created account and
archived transcript are intentionally available for inspection until explicitly
purged by the operator; this acceptance purged them as requested.

All four generated Workspace Volumes were confirmed `storage_purged_at` before
removing the test database graph. Every database FK was checked before committing
cleanup. All 311 retained production-topic records were verified to belong solely
to the two generated tenants before their ranges were deleted. Original **35 users
and 52 Sessions** remain, with no active test lease. The temporary Broker, private
Kafka topics/groups and cleanup scripts were removed. Existing user data and Cube
templates were not deleted.
