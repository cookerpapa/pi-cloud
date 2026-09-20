# Six-area review repairs — September 21, 2026

Implementation/deployed application revision `2c3a4457`, migration 147; Pi 0.84.1,
Kafka v10 and production Cube template `f9ebe6af` unchanged. This implements the
approved local repairs from the [Claude-followup review](../../claude-analysis/architecture-review.md),
not another architecture migration or a claim of line-by-line whole-repository review.

## What changed

- Model Gateway now tracks request-body uploads as in-flight work. Revocation or
  shutdown aborts them; after validation, a synchronous capability/count check
  reserves admission before the upstream call. Regression tests reproduce
  release, expiry, shutdown and simultaneous uploads with one remaining request.
  Invalid payloads do not consume that reservation. No new PG query is added.
- Removed the alternative WebSocket Steer router/backend and its
  prepare/commit/release/result exchange. HTTP Steer remains; WebSocket still
  registers Workers and carries heartbeats. Local command acknowledgements stay.
- Removed dormant `usage_ledger`, `model_requests`, `model_rates`,
  `environment_operations` and three monetary budget fields. Native Pi usage,
  execution limits and active Workspace operations remain. Migration refuses
  active/unsealed execution or unexpected historical accounting/operation rows.
  Existing native-log content had an identical checksum before/after migration.
- Unchanged environment versions use a shared read, not a Project update lock.
  Version writers take `NO KEY UPDATE` and then a fresh read, avoiding a deadlock
  with concurrent readers' Run foreign-key checks. Ordinary input/claim now uses
  **7 + 10 SQL exchanges**, previously 8 + 10, including BEGIN/COMMIT.
- Native projection retains the physical Session lock, then combines three
  post-lock reads. The measured Entry+Record path uses **7 business statements**,
  plus BEGIN/COMMIT; outer Run projection adds four more. Idle lease release uses
  one conditional UPDATE instead of SELECT then UPDATE. Real PG lock-wait tests
  verify the new snapshot sees the preceding writer's committed Lane head.
- Moved concrete Worker execution wiring out of `runtime-core` into
  `supervisor-host`, and Pi loop/error handling out of `pi-session-postgres` into
  `sandbox-supervisor`. Fake models are injected by tests, not embedded in the
  production Runner. No provider/runtime library version changed.
- Fault evaluation runs once per test file, retaining exact target-test and
  skipped/missing-test checks. The 34 cases require 19 processes rather than 34;
  this execution took 125.5 seconds. Case durations now exclude shared startup,
  which is reported separately; no unsupported speedup comparison is claimed.

No new service, cache, retry layer, storage authority or compatibility decoder
was introduced. Session ownership, ordered seals, Kafka ACK and Tool UNKNOWN
semantics remain. Payload duplication/storage redesign and service splitting are
not part of this approved slice. README's concise architecture remains accurate;
the detailed architecture, lifecycle, deployment and usage-observability docs
were updated.

## Verification

Full package run: **1,124 passed, zero failed**, across 176 files. Three opt-in
external checks were skipped: Kafka topic-policy test and two Cube provider
security-gate cases. These skips are not counted as passes. Acceptance helpers:
30 passed; targeted fault gate: 34/34. Typecheck, formatting, build, documentation,
installer contracts, runtime policy, Helm/distributed preflight, observability,
image closure/context and browser presentation/deployment checks passed.
The security high-severity gate passed; two existing moderate Vitest findings
remain, and the Web build still warns about a >500KB chunk.

Real traffic used the Web API client, cookie authentication and cursor-free SSE,
plus actual headless Chrome rendering. Across three owned test tenants:

- 49 Runs: 47 completed, one deliberately cancelled, one deliberately killed.
- Two-round insertion-sort/binary-search coding in real Cube, actual Python tests,
  and byte-identical preservation of the first file in the second round.
- HTTP Steer delivered during a running Bash command changed the final reply.
  Cancellation followed by a new Run succeeded without replaying the old task.
- Workflow Subagents used both inherited and fresh context. Both returned the
  correct markers; SQL verified the parent/children shared one physical Session,
  Worker and lease. Results and child history were readable after settlement.
- Four simultaneous Sessions across two tenants returned their own markers;
  foreign-tenant history access was denied. Functional SSE observers recorded no
  unexpected reconnects. This is bounded concurrency acceptance, not a capacity limit.
- DeepSeek V4 Pro/off/Standard → GPT-5.6 Luna/medium/Standard switching worked.
  A pre-upgrade Session recovered its remembered marker on the new Worker.
- Chrome actual send/render/reload of an explicit Session URL passed: first text
  paint 1,964.7ms, with 8ms from DOM update to paint (one sample).
- A real SIGKILL of Worker and Control Plane during streaming preserved all
  **169 already-observed characters**. The old Run had exactly one admission,
  failed and sealed; the queued Follow-up started on a new Worker boot/lease only
  after that seal committed, and completed. PG/Kafka/Cube were not restarted.

Native assistant usage records totalled **69,176 uncached input, 298,752 cache-read
and 1,771 output tokens** across 54 stored assistant records. Six concrete Broker
operations succeeded. This is real provider traffic, not fake-model token estimates.

The first browser probe selected a row before opening had completed; its later
reload also incorrectly expected the root URL to retain a Session selection.
The corrected fixture waited for selection and used the supported `?session=`
link. The fault evidence query initially used a nonexistent `admitted_at` column;
verification was corrected to `started_at` against the same persisted fault,
not rerun until a preferred result appeared. Neither was a production regression.

The default local `experiment` guest image was stale and failed its contract.
The explicit production image digest passed directory, execution, path-boundary
and arbitrary-port preview checks; subsequent real Cube coding passed. No new
template, old-machine mutation or compatibility mode was needed.

## Matched latency comparison

One WSL host, one Worker, primary PG, three Kafka brokers and CLIProxyAPI. Old
application `f9ebe6af` versus `2c3a4457`; real Luna/medium/Standard, 15 sequential
short replies per cohort on a persistent SSE connection. First three warm-ups
excluded. No builds, test suite or isolated PG ran during either cohort; no
power, clock or durability setting changed.

| Warm 12 samples, median / p95 | Before | After |
| --- | ---: | ---: |
| API acceptance | 14.57 / 33.29ms | 15.44 / 22.12ms |
| Submit → provider dispatch | 63.11 / 90.56ms | 65.48 / 88.55ms |
| First text excluding provider route | 70.84 / 99.27ms | 74.61 / 97.05ms |
| Entire Turn excluding provider route | 146.61 / 217.38ms | 138.58 / 165.51ms |
| Provider completion → terminal receipt | 76.41 / 145.51ms | 68.81 / 83.04ms |

Startup/first-text internal latency did **not** materially improve. Whole-Turn
median decreased about 5.5% in this sample, mostly in settlement; the smaller
tails do not establish statistical significance or enterprise throughput.
The structural result is fewer statements and less ordinary cross-Session
locking, not a claim that every removed SQL saves a disk sync.

Medians average the middle pair; p95 uses nearest rank. Subtraction pairs each
Turn with its model transport timing. The provider route includes CLIProxyAPI;
the table measures API/SSE receipt, not browser paint. Remaining host/WAL and
callback tails remain separate investigations.

## Cleanup and boundaries

Created three test tenants, ten Session views (including two child Lanes), three
Workspaces and lazy elastic compute; no dedicated development machines.
Cleanup completed through product deletion, confirmed physical Volume purge,
then removed only the exact registered test tenants' database rows in foreign-key
order. Cube inventory and the shared Volume directory are empty. The isolated
test PG container/volume was removed. Original native history retained its
checksum; original totals remain 33 tenants, 35 users, one Session, one released
Workspace and seven Runs. Original accounts and resource tombstones are retained.
Private raw evidence is removed after this aggregate report is committed; shared
production logs and Kafka retention are not globally wiped.

This slice does not repeat production-threshold multi-compaction, heavy hosted
search, Fast-mode/provider combinations, multi-node HA or high-load capacity
testing. Moved loop/compaction contracts passed deterministic regression; earlier
versioned acceptance is not relabelled as a new run. No new architectural blocker
was found; the existing Cube launch-generation and Volume-refcount issues in
the backlog remain outside these repairs.
