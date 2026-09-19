# Atomic admission and first-record acceptance — September 19, 2026

Implemented and deployed under [ADR-0178](../adr/0178-admission-and-first-record.md).
Runtime revision: `4c7ff326`; migration 143 and execution-log topic v9.

## Change

Worker claim, Session lease, publication identity and running state now commit
in one admission transaction. Local preparation follows that commit immediately.
The separate started/running commits and standalone Kafka `execution_opened`
append/ACK are removed. Running includes preparation, not proof of a model or
Tool invocation. A failure after admission requires a seal, not a pre-start retry.

The first actual native append co-commits its recovery position with semantic
state. A first display/control record anchors recovery before visibility or
routing. An empty execution can close with only a seal. API input acceptance,
output-drain proof, completion and ordered closure remain distinct. No per-token
authority query, compatibility decoder, weaker durability or new service was added.

The drained cutover preserved user history and Volumes. A cold-topic startup
failure exposed a redundant consumer offset lookup used only to count partitions.
The Projector now reuses producer-verified metadata; the existing bounded metadata
retry also recognizes the native client's transient local metadata miss. Permanent
errors still fail. Five isolated real RF3 fresh-topic startup/delivery checks passed
in 1.25–1.54 seconds; their topics/groups were removed. Deployment then started
without the original startup crash.

## Real Luna comparison

Before: deployed compiled-validation runtime `5d6114ba`, topic v8. After:
`4c7ff326`, topic v9. Each cohort used one Session, 15 sequential GPT-5.6 Luna
medium/Standard Turns and one persistent SSE connection. The first three Turns
were warm-ups. No build, unit suite or load test ran during measurement.

Same one-host WSL deployment: one Worker with four family/model slots (2 CPU,
2 GiB), Control Plane (1.5 CPU, 768 MiB), PostgreSQL (4 CPU, 768 MiB) and three
Kafka brokers (4 CPU, 2 GiB each), RF3/min-ISR2/acks-all. No host tuning was changed.

| 12 measured Turns per cohort | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| API acceptance | 16.10 / 22.37 ms | 18.56 / 23.32 ms |
| Submit → provider dispatch | 96.00 / 128.93 ms | 90.01 / 121.45 ms |
| Provider route → first text | 2,344.08 / 5,127.67 ms | 2,549.62 / 5,796.00 ms |
| Pi text event → SSE receipt | 7.82 / 8.85 ms | 7.86 / 8.55 ms |
| First text latency excluding provider route | 103.83 / 137.98 ms | 98.85 / 129.10 ms |
| Whole Turn excluding provider route | 163.01 / 202.78 ms | 163.70 / 211.78 ms |
| Provider response complete → terminal SSE receipt | 66.85 / 94.48 ms | 76.53 / 90.49 ms |

Startup median improved about 6 ms in this small comparison; whole-Turn internal
latency did **not** materially improve. The established benefit is fewer startup
boundaries and a simpler lifecycle, not elimination of settlement or host-storage
tails. Provider-route duration includes CLIProxyAPI. These are API/SSE receipt
measurements, not browser paint or a latency SLO. Independent medians cannot be
added; with 12 observations, nearest-rank p95 is the maximum. All real checks used
the normal frontend API client, not direct model requests bypassing PiCloud.

For the same 12 candidate Turns, Worker stage logs measured admission at 37.64 ms
median, native Session opening at 14.22 ms, model-runtime preparation at 0.96 ms,
World State preparation at 0.10 ms and local writer construction at 0.034 ms.
These spans are not a complete additive decomposition of the 90 ms startup.

## Functional and process-fault acceptance

- Pre-cutover Session resumed on the replacement Worker and recalled its marker.
- Two real Cube coding Turns wrote and tested insertion sort and binary search;
  four Tool completions succeeded, both files were readable, and the second Turn
  preserved the first file byte-for-byte.
- User cancellation produced a cancelled terminal; the next Turn completed.
- One Cube workflow created parallel inherited-context and fresh-context Lanes.
  Both children completed; their actual transcript answers matched the inherited
  marker and fresh task respectively. Parent completion alone was not sufficient.
- Four Sessions across two tenants completed with distinct replies. PG Attempt
  timestamps confirmed overlap four; foreign-tenant conversation access was denied.
- During an additional streaming Run, SIGKILL terminated the Worker and Control
  Plane together; the same containers were restarted with PG/Kafka data intact.
  Recovery took 18.87 seconds through terminal observation, preserved the exact
  121-character observed prefix, failed/sealed/released the one original Attempt,
  and projected beyond its seal. A new message in that Session then completed.
  No automatic Run or Tool replay was introduced.

Total paid execution: 44 Runs, 42 completed, one deliberately cancelled and one
deliberately interrupted. All 44 Attempts were sealed/released and their partition
progress exceeded their seals before cleanup. Native assistant usage recorded
54,912 input, 269,056 cache-read and 1,569 output tokens across 47 entries; this is
not billing reconciliation and cannot count a provider response lost in the crash.

This task does not claim new long-context/Compaction, hosted-search, browser-paint,
enterprise-load, multi-node or whole-host power-cut acceptance. Single-host Kafka
replication is not independent power-loss protection; seals cannot reconstruct
lost storage bytes. Drain/completion merging remains a separate design decision.

## Automated verification and cleanup

The final real-PG sweep passed 728 tests in 131 files, with one opt-in Kafka
topic-policy test not enabled. All workspace typechecks, formatting, documentation
and image-closure checks passed. Earlier stale schema/queue fixture expectations
were corrected and covered by the final sweep. The pre-rollout real-PG fault gate
passed 26/26. Cold-start regression added metadata-miss/permanent-error and
no-duplicate-lookup coverage (13/13 targeted, also included in the final sweep).
Admission tests cover rollback/lost COMMIT, capacity/cancellation, owner loss before
first output, lost first ACK, first projection rollback/lost reply, empty seals and
shared-writer closure. The cutover migration refuses undrained executions.

Four temporary tenants/accounts, eight Session views (including two children),
four Workspaces and the coding Cube/Volume were cleaned up through scoped resource
deletion and confirmed storage purge, followed by exact-tenant database cleanup.
Original counts remain 33 tenants, 35 users, one Session and one Workspace.
The retired v8 topic was deleted only after all 22 of its Attempts were sealed,
released and projected and no pending seal delivery remained; canonical user
history is retained. Current shared Kafka/service logs use normal retention.
Both isolated test PostgreSQL containers were removed. Temporary acceptance
scripts, credentials and raw test reports were deleted; only this content-free
summary is retained.
