# Direct log / unified Projector acceptance

2026-09-09. Tested working tree based on `e5ae889f`; this report accompanies the
ADR-0163 implementation commit. Production schema 134, topic
`pi-cloud.execution-log.v7`. No Cube template or native Pi history rewrite.

This report describes the original signed-record implementation. The current
private deployment removes signatures under [ADR-0164](../adr/0164-trusted-private-log-publication.md).

## Delivered contract

Worker obtains one PG-issued publication scope/public key, appends the opening
and signs records directly into Kafka. One Session Projector group verifies
scope/provenance and folds native PG state, live view and Tool routing. There is
no remote Fact Gateway, secondary channel lease, independent live/Tool consumer
or second execution-committed Kafka notification. Worker native writes return
at Kafka ACK; the next Run waits for the predecessor's committed seal.

Projector replicas advertise unique internal URLs in Kafka membership. The
ordinary authenticated SSE endpoint proxies to the assigned replica when needed.
Tool Broker remains an effect/lifecycle endpoint with owner-direct raw results,
Lease/fence admission and no-replay operation identity; it has no Kafka client.

## Correctness and real workloads

- Full suite: **734 passed**, 3 explicit environment-dependent skips. Obsolete
  channel/commit-notification suites were removed with their implementation;
  native-host and seal tests now verify signed scope rejection, direct terminal
  projection, atomic PG rollback, unsealed-prefix replay and shared-Lane closure.
- Public Pi backend conformance, Compaction/Harness recovery, tree/Fork/prune,
  schema-from-empty, executor deduplication and resource tests passed.
- Real GPT/Cube multi-round acceptance passed twice. The maintained rerun proves
  entry into the current v7 topic, warm process reuse, authenticated Preview and
  1,025-file Volume restoration into a new Cube. The old script mistakenly read
  v5 offset totals; it now imports the code-owned topic and checks the new
  publication/open position. Offset sum is named as such, not unique event count.
- Real Projector SIGKILL: Worker boot times unchanged; **82 records appended
  while Projector was down**; the same Attempt completed after replay. The test
  now uses `--no-deps` so a Control Plane restart cannot recreate Workers.
- Two real Projector replicas owned disjoint parts of the production topic.
  A Session deliberately selected on the secondary was served through primary
  Web API/SSE; two DeepSeek coding Runs completed read/write/edit/bash tests.
  Thirteen executor deliveries averaged 7.73 ms during concurrent host load.
- Real Worker SIGKILL during visible streaming produced a failed terminal and
  preserved the visible prefix. A replacement Worker recovered that prefix;
  its Run began only after the predecessor seal committed. Cold cross-Worker
  marker recall and four concurrent Runs also passed.
- DeepSeek Subagents passed fresh/inherited Lanes, lazy activation, shared and
  isolated Workspaces, parallel children and recursive parent/child navigation.
- Four tenants/eight model Runs completed with four marker restores, four
  cross-tenant denials and zero marker leaks. Text TTFT p50/p95 was 1.44/4.98 s;
  queue p95 was 3.78 s with the existing small parent-slot configuration. The
  earlier clock-divergent latency sample was rejected and rerun, not reported as
  a performance success.

Across all generated test tenants, 56 Runs produced 100 assistant model messages:
173,762 input, 18,762 output and 778,368 cache-read tokens. This includes the
intentional Worker-crash Run and the discarded clock-divergent measurement.

Evidence: [Cube](cubesandbox-production-acceptance-latest.json),
[Projector restart](control-plane-restart-acceptance-latest.json),
[owner-routed SSE/coding](session-projector-live-latest.json),
[Worker recovery](pi-worker-pool-acceptance-latest.json),
[Subagents](subagent-production-acceptance-latest.json),
[multi-tenant load](multi-tenant-model-load-latest.json).

## Publication performance

The [signed producer benchmark](https://github.com/cookerpapa/pi-cloud/blob/24ab9dc2/docs/reports/kafka-accepted-fact-load-latest.json) uses 256-byte
text fragments, per-Session Ed25519 signing, one Node producer process, four
producer lanes and 32 Kafka partitions/RF3. Per-case key creation is outside the
timed loop. At 1,024 logical Sessions, 262,144 sustained records achieved about
**12,816 records/s**. A single Session averaged 238 records/s with ACK p50/p95
4.16/4.78 ms. This excludes permit issuance, Projector verification/PG, model and
Cube time; it is not 1,024 simultaneous real model workloads.

Signature work adds CPU cost versus prior unsigned transport-only reports. This
change is an ownership/topology simplification, not a claim that every isolated
benchmark became faster. End-to-end capacity still requires enough Worker and
Projector replicas and measured PG/consumer headroom.

## Cleanup and deployment

All 25 generated Workspace Volumes were confirmed purged before database cleanup.
Fifteen test tenants and their 33 Session scopes were removed, including only the
two explicitly named foreign-test projects under the original bootstrap tenant.
Every PG foreign key was checked before cleanup committed. All 2,531 retained
v7 records were verified as test-only before deleting their ranges. The temporary
second Projector and private benchmark Topic were removed. Original **35 users
and 52 Sessions** remain. A private pre-134 backup is retained outside Git.

Default deployment returns to its original single Control Plane/Projector and
two Workers. Additional replicas now divide one consumer group; Kubernetes
shares `global.kafka` settings and uses Pod IP for unique Projector URLs.
Aggregate reports are retained; no raw test conversations or workspaces are kept.
