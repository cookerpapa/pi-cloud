# Message handoff acceptance — 2026-09-05

Runtime under test: `d0770b973f3b7e036fdfa34ce8b932f9d7ba9a4b`.
Build-only follow-up: `8b79bab061318cd5d5d434c1154fe4c5a1d4cf19` selects the
official Go module proxy on GitHub CI. It does not change running application
code. Topology: one WSL host, two Pi Worker processes, three Kafka brokers,
PostgreSQL, and real Cube KVMs.

## Deterministic handoff checks

624 tests passed; three opt-in infrastructure tests were skipped by the normal
test command. Live coverage below exercised the actual deployed infrastructure.

| Boundary | Before | Verified change |
| --- | --- | --- |
| idle SSE | a heartbeat left an outstanding read and the next read threw | several heartbeats followed by one delivered event, without reconnect or leaked timer |
| history snapshot | history and sequence boundary were separate reads | one repeatable-read transaction; refresh when terminal eviction overtakes the snapshot |
| Pi active context | three branch reads before first sampling, two before the next | one branch read per sampling, reused for Compaction assessment |
| 100 concurrent pending mutations | individual result polling | one combined first read, one combined read after notifications; no per-mutation polling timer |
| projection receipt | Session transaction, then independent receipt INSERT | injected receipt failure rolls back Session changes; replay commits one effect |
| existing Cube Bash | identity, upload, exec, cleanup RPC, identity, HTTP scan | identity, upload, exec; cleanup inside that exec; Preview triggers HTTP verification |
| file Tools | write mkdir/write RPCs; edit access/read/write RPCs | one write RPC; edit read/write RPCs, retaining conflict checks |
| Kafka consumption | all assigned partitions waited on each handler | blocked partition does not delay another partition; bounded pending work and ordered partition handlers |

Counts above describe work eliminated or bounded, not a hardware throughput
claim. No model timing is used to infer those reductions.

## Live product checks

- [Browser](browser-ui-acceptance-latest.json): 92 controls exercised, including
  opening an existing conversation through exactly one SSE request and no
  redundant REST history request. Tree focus changes and 32 seconds of idle
  heartbeats caused zero new SSE requests. Chat first text / complete reply:
  2,879 / 3,190 ms.
- [Snake](snake-preview-acceptance-latest.json): 10 real GPT Tool calls, HTTP 200
  through isolated Preview, and browser start/move/pause/reset passed.
- [Concurrent tenants](multi-tenant-model-load-latest.json): six tenants,
  12 completed real-model Runs, six successful cross-round marker restores,
  six cross-tenant API denials, no marker leaks, one Attempt per Run.
- [Coding and storage](cubesandbox-production-acceptance-latest.json): warm
  Cube reused across coding Turns, Preview publication, surviving background
  process, and 1,025-file persistent Volume restored into a new Cube. Twenty-two
  model responses recorded 26,499 input, 3,104 output and 220,672 cache-read tokens.
- DeepSeek V4 Flash: two additional coding Turns created nested sorting/search
  files, edited the existing implementation and added graph traversal tests.
  Both shell test markers were observed in Tool results. Five Tools per Turn;
  total Turn durations 12,099 and 11,889 ms. Native usage: 12 responses, 3,204
  input, 2,790 output and 99,200 cache-read tokens. Workspace deletion and physical
  storage purge were confirmed. Native Compaction correctness was covered by
  automated runtime tests; this short live workload did not force Compaction.
- [Control Plane SIGKILL](control-plane-restart-acceptance-latest.json): the
  streaming Run completed after Gateway recovery with one Attempt.
- [Kafka broker SIGKILL](kafka-broker-restart-acceptance-latest.json): one
  broker restarted during a real stream; one Attempt completed, zero SSE reconnects.

## System and Provider timing

From the isolated coding/storage acceptance (milliseconds):

| Run | admission | queue + claim + Runner preparation | model sampling total | Tool total | full Run |
| --- | ---: | ---: | ---: | ---: | ---: |
| pure chat | 20 | 202 | 2,508 | 0 | 3,111 |
| first coding | 27 | 281 | 14,897 | 1,906 | 17,712 |
| follow-up coding | 24 | 185 | 12,362 | 599 | 14,360 |

These are individual observations, not latency percentiles or a controlled
before/after model benchmark. Provider generation differs between Runs.

## Operational findings and cleanup

The first GPT attempts returned an upstream expired-token error. The existing
same-account access token was updated from the authorized local Codex login;
no refresh token was copied. Restarting CLIProxyAPI cleared its stale auth
availability state, and subsequent end-to-end GPT tests passed.

The first CI failed fetching Go checksum metadata from goproxy.cn (502/504).
The CI download-source follow-up passed all jobs without disabling checksum
or vulnerability verification. Cube still deferred historical template cleanup
on an unavailable old node; new template registration and runtime acceptance
passed. This pre-existing cleanup issue is not claimed fixed here.

Acceptance machines were released, test Workspaces deleted, screenshots and
temporary logs removed after extracting this report. Existing user resources
were preserved. Kafka accepted records expire under the deployment retention
policy; the shared production topic was not reset to erase test records.
