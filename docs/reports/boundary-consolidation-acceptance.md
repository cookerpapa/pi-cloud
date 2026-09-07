# Execution boundary consolidation acceptance

2026-09-07; ADR-0153, working tree based on `b0339148`. Tests below cover the
implementation in this change, not an unchanged baseline commit.

## What changed

Fact Stream close drains pending publication and progress before releasing its
authority, including a disconnected Worker whose admission finishes late.
Terminal Outbox claims are bounded, publish outside PostgreSQL transactions,
and use claim-version CAS for late ACK/error handling. Per-Session terminal
order is retained while other Sessions can progress independently.

Sampling start shares a mutation with its Step Record; Tool completion shares
one with the native Tool Result. Complete model output and validated Tool
intent remain two distinct pre-effect durability barriers. Append receipts
return only server-assigned stamps, while replay reconstructs results from the
immutable log. Latest-entry recursion stops at the requested matching limit.

Pure chat no longer depends on Broker readiness or eagerly binds an owned
machine. Elastic browsing reads Volume bytes without Cube initialization;
owned-machine browsing reads the selected VM directory, including `/opt`.
Reviewed model capabilities now have one catalog. Canonical projection is an
optional independent process, not an additional default service.

## Verification

All package suites ran sequentially to bound WSL resource use: 670 automated
tests passed across 19 packages, including Pi's native storage conformance.
Three opt-in live tests remain skipped in the default suite; the separate paid
and Cube acceptances below were run explicitly. Type checking, formatting,
build, documentation, installer contracts, Helm, image closure and runtime
time-budget checks passed.

Targeted assertions include delayed ACK during close, failed delivery, duplicate
close, disconnect during admission, independent Outbox claimers on a one-connection
pool, lost ACK, expired-claim updates, receipt loss, metadata migration round-trip,
empty Volume browsing, owner authorization and symlink boundaries. An
`EXPLAIN ANALYZE` test confirms a latest-entry query over a 32-entry ancestry
produces one recursive row rather than traversing the full branch.

## Real user paths

Both deployment compositions were exercised. Paid coding and multi-tenant tests
ran with the independent canonical projector and embedded projection disabled;
the default embedded role was restored and checked afterward.

| Path | Result |
| --- | --- |
| DeepSeek write + run algorithms, then edit + rerun | 14.03 s / 11.52 s total; animated preparation visible, browser refresh recovered it, tests passed |
| Owned Cube, files under `/opt`, public HTTP preview | directory/file APIs passed; stopping the HTTP process did not stop the machine |
| Broker stopped, same owned-machine Session chats | 1.07 s total; no Sandbox Tool required |
| Broker restored, second coding Run | root file, existing Python service and Preview survived; insertion sort and binary search passed; zero reset markers |
| GPT, 3 tenants × 2 rounds, 2 Workers | 6/6 completed, correct history restored, foreign reads denied, no cross-tenant marker leakage |
| Default embedded projector, new empty elastic Workspace | empty directory read; chat acceptance 37 ms, first text 1.374 s, completion 1.827 s, terminal SSE observed |

Successful paid acceptance groups consumed 25,099 uncached input, 6,468 output
and 189,824 cache-read tokens, excluding the final smoke chat and an earlier
test-script retry. Input/cache counters are reported separately, not equated
with billable cost. Raw transcripts and credentials are not included.

The 3-tenant test's queue p95 was 6.493 s. Each local Worker has four slots with
three reserved for Subagents, leaving one parent slot. The third simultaneous
parent therefore waits for capacity; this is not a 6-second PostgreSQL claim.
These numbers include Provider latency and are not a before/after speedup claim.

One initial machine test failed when Compose `start` also restarted an old
database-bootstrap container. The bootstrap container was recreated from the
current image; the test now restores only Broker with `up --no-deps`. The full
machine acceptance was rerun successfully.

## Isolated throughput, without models

PostgreSQL: 512 Sessions, 2,048 complete 1-KiB messages, concurrency 32, one
transaction for the entry and compact receipt. All persisted, zero failures;
917.93 messages/s, p50/p95 32.32/47.57 ms, about 5.4 KiB WAL/message. Log replay:
6,027 Sessions/s. This measures the storage portion, not Worker/Gateway end-to-end
throughput, and differs from the former two-transaction benchmark.

Kafka: 3 local brokers, RF=3, `acks=all`, 256-byte text payload. The 1,024-Session
case delivered 262,144 events in 3.84 s: 68,191 events/s, ACK p95 22.99 ms. This is
a short producer-to-Kafka regression test, not a long soak or an Agent capacity
claim; the producer implementation was not changed in this review.

## Cleanup and limits

Acceptance Sessions were removed through product APIs. Test Workspaces and
both test machines' Volumes were verified purged, including root-owned `000`
files. Test login/API credentials were deleted. The benchmark database/container
and Kafka topic were removed. Normal bounded database audit/tombstone rows and
production Kafka retention remain; no shared log or user history was truncated.
The optional projector test process was removed and normal services are healthy.

No host power loss or arbitrary network-partition proof is claimed. Draining a
live ingress does not fence an already-dead publisher's late Kafka delivery.
Each SSE Gateway still rebuilds its retained live tail; tail sharding is not part
of this change. New Providers still require adapters and capability tests.

Follow-up validation found a reproducible late-publisher handoff failure; see
[the counterexample](late-publisher-findings.md). The passing checks above do
not establish safe replacement of a paused ingress publisher.
