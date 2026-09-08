# Kafka-native Session production cutover

2026-09-09. Tested working tree based on `c2f2cc58`; Pi 0.84.1, one WSL host,
three Kafka brokers (`acks=all`), PostgreSQL and real Cube KVM. This is the
production adapter, not the earlier full-log experiment.

## Implemented boundary

The active Harness appends through SessionStorage and continues at Kafka ACK.
One physical-Session writer assigns immutable native stamps across concurrent
Lanes. PG projects exact records; ordinary Steps read the acknowledged view.
Cold restoration remains latest Compaction plus suffix. Normal closure is
Run-scoped; uncertain publication retires the shared writer incarnation.

Removed the PG mutation-result table, compact receipts, receipt notification
waiter, old execution-view cache and legacy projection-time sequence allocation.
Kafka reclamation now requires both safe PG progress and retention grace.

## Paid acceptance

- Real DeepSeek write/edit plus browser reload: two Runs, 22 native appends each;
  cumulative Kafka waits **236 ms / 133 ms**, PG receipt waits **0 / 0**.
  First Run needed no history branch download; the second loaded once.
  [Tool/UI evidence](tool-preparation-acceptance-latest.json).
- Long-context coding completed 13 algorithm rounds and natural Compactions at
  **112,123** and **112,236** tokens, using the unchanged 128,000-token model
  window. A settlement fault interrupted the subsequent recall check; the same
  Session and Workspace were preserved and continued after the fix, not recreated.
- Continuation restored the first-round marker, performed further coding on a
  replacement Worker, passed **339 independently executed Python tests**, and
  switched to GPT with hosted Web Search. The long Session used **393,824 input,
  196,908 output and 9,655,808 cache-read tokens**, including the repeated checks.
  [Continuation evidence](native-session-resume-acceptance-latest.json).
- Fresh, inherited, shared-Workspace, isolated-Workspace, parallel and recursive
  Child execution passed. Children used native Lanes and the parent Worker,
  without independent physical Sessions or inherited Entry copies.
  Focus/full tree projections passed. [Subagents](subagent-production-acceptance-latest.json).
- Browser-cookie APIs passed login/isolation, tree/Fork/prune, file browsing,
  terminal/Agent concurrency, two concurrent Sessions sharing a Workspace,
  Steer, cancellation/recovery, rebinding and deletion.
  [Product surface](product-surface-acceptance-latest.json).
- Four tenants / eight Runs: all completed with one Attempt, four successful
  context recalls, four cross-tenant denials and no marker leaks. During this
  short-context check each Worker temporarily had eight slots (three reserved
  for Children). Queue p50/p95: **205 / 937 ms**; visible text p50/p95:
  **2,284 / 3,076 ms**. These include Provider time and concurrent host work,
  not just platform transport. [Evidence](multi-tenant-model-load-latest.json).

Long coding's large first-visible delays were not attributed to PG: the native
responses included thousands of hidden reasoning tokens, e.g. 6,186 reasoning
tokens before a large Tool call. Visible latency and model-free transport
measurements are deliberately reported separately.

## Process faults and fixes found

The real-process probe paused the old ingress for twelve seconds, killed its
Worker, restarted projection, and brought up a replacement. Follow-up remained
queued until the seal; the replacement received the visible interrupted prefix.
Resuming the old ingress did not alter the new head or show late output.
The passing rerun observed **zero PostgreSQL deadlocks**.
[Fault evidence](worker-handoff-probe-latest.json).

Acceptance uncovered and fixed:

1. Inconsistent Attempt/Lease/Worker row-lock order during renewal and settlement.
   Locks now follow the lifecycle order; bounded retries apply only to SQLSTATEs
   proving transaction rollback, never to model or Tool execution.
2. An expired Run could remain on an otherwise healthy Worker. Maintenance now
   retires that expired lease without stopping unrelated Sessions. This also
   automatically settled the stranded production-test Run after deployment.
3. Public Run completion could precede its canonical projection. The API exposes
   settling until the seal commits.
4. Tree/Fork/prune still assumed UUID native Entry IDs, including two PG columns.
   Schemas and columns now preserve opaque Pi IDs; real Fork/prune passed.
5. Worker-restart acceptance inadvertently restarted an obsolete bootstrap
   container. Bootstrap was recreated and individual Worker checks now use
   explicit dependency-free recreation.

The lock fix and healthy-Worker expiry cleanup were applied after the initial
native cutover. Earlier successful coding did not by itself prove these boundaries.

## Model-free measurements

| Scope | Workload | Observed result |
| --- | --- | --- |
| Kafka adapter only | 1,024 logical Sessions, 262,144 sustained records | 31,806 events/s; ACK p50/p95 25.7/58.7 ms |
| PG exact projection | 256 Sessions × 8 complete 1 KiB entries; concurrency 32; isolated 2 CPU/768 MiB PG | 278 entries/s; 4,548 WAL bytes/entry |
| Command/result path | 1,024 Sessions, 3,072 commands; two Broker consumers and counting executor | 931 commands/s; no duplicate effects |

These are different pipeline slices, not an end-to-end Agent concurrency limit
or a before/after speedup claim. Removing PG waits does not increase PostgreSQL's
intrinsic throughput. See [Kafka](kafka-accepted-fact-load-latest.json),
[PG](postgres-session-projection-latest.json),
[Tool delivery](tool-result-retirement-acceptance-latest.json).

Real Kafka deletion tests also verified: no checkpoint retains everything;
unsealed prefixes remain; recent records respect the grace; PG failure stops
reclamation. Progress fixtures used socket-backed PGlite, not a second production
database. [Retention evidence](native-retention-acceptance-latest.json).

## Operational scope

Migrations 131–132 preserve existing semantic history. Final verification passed
747 tests; three environment-gated tests were skipped in the unit invocation.
Type checking, build, Helm, runtime-policy and image-closure checks passed.

Cleanup removed 18 acceptance tenants and their 35 Sessions, after API-based
Workspace deletion and confirmed Volume purge. All 4,128 records below the
captured heads of the newly deployed Kafka topic were verified to belong to
these test tenants before deletion; old topics and unrelated data were untouched.
The installation is back to its original **35 users and 52 Sessions**.
Worker capacity is restored to four slots after measurement.
An owner-only pre-cutover PG backup is retained under the private runtime
directory; no credential or transcript is committed.

Aggregate production-test usage (including failed/repeated acceptance attempts):
569,629 input, 213,326 output and 10,370,176 cache-read tokens across 83 Runs.
Separate private fault probes are reported independently.

This remains semantic recovery. In-flight shell effects may be UNKNOWN. Cube
physical launch-generation fencing, multi-node HA and unlimited projection-outage
storage are not claimed. Broker partition ownership is unchanged by this cutover.
