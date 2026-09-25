# Ephemeral Tool progress acceptance — 2026-09-25

Implementation: `63087fa7`, with the accompanying UI-only fixed-box tail-follow
refinement. One WSL host, Compose Worker/Broker/Control Plane, RF3 Kafka and real
Cube KVM. All paid calls used GPT-5.6 Luna; none used DeepSeek.

## Contract

Guest Pi update → Broker's newest-only HTTP sender → owning Projector → existing
authenticated SSE. These observations have no formal Session sequence, Kafka
publication, PG row, Worker callback or model-context entry. Final results retain
native Pi processing and the existing Kafka reply path.

Bash emits at most once per second. Broker sends at one-second intervals and
caps text at 8,192 characters. Slow readers retain at most 64 newest operation
snapshots, separate from formal event ordering. No viewer means no retained output.
The UI preview is collapsed by default, fixed-height and replaced in place.
Only its inner log box follows output; manual scrolling stops that following.

## Verification

- Full deterministic suite: **1,082 passed**, 107 opt-in cases skipped, 171 test
  files passed. Opt-in skips are not represented as successful live tests.
- Whole-repository typecheck, build, format, documentation, Helm, runtime policy
  and runtime image closure checks passed. Production configuration and installer
  checks passed; final UI typecheck passed after its tail-follow refinement.
- HTTP test reused one TCP connection across successful delivery, HTTP failure,
  owner redirect and the next snapshot. There is no retry of the dropped snapshot.
- Regression tests cover 10,000 coalesced updates, tenant isolation, viewer
  disconnect/reset, running-Tool eligibility, duplicate/late observations,
  final-only Kafka publication, source output bounds, silent commands and aborts.
- Existing Workflow host-call/control tests still pass. This acceptance did not
  repeat a paid multi-Subagent campaign or physical multi-node HA.

## Real browser, model and Cube

The maintained [script](../../scripts/run-live-tool-progress-check.mjs) uses the
frontend API and a real Chrome page. [Numeric results](tool-progress-acceptance-latest.json).

| Scenario | Observed result |
| --- | --- |
| 1.5 MB output followed by a 50-second foreground command | 37 temporary updates; maximum observed preview 577 characters; exactly one Tool execution; final marker retained and result below 64 KiB |
| Browser reload during that command | Collapsed preview restored; subsequent snapshots displayed without replaying old progress |
| Projector SIGKILL and explicit restart | New conversation snapshot and subsequent progress arrived; same Run completed, no Tool replay |
| Continuous output UI | Preview default collapsed; fixed height; transcript remained at manually selected scroll position; preview removed at completion |
| `sleep 25` | Completed in 30.28 seconds end-to-end, zero updates; no progress heartbeat dependency |
| Cancel a long Bash | Run cancelled; preview removed; zero late progress after terminal observation |
| Continue coding after cancellation | Actual write/read/edit/bash insertion-sort task completed successfully in the same Session |

The noisy Run took 59.72 seconds end-to-end, including the explicit 50-second
command and 4.89 seconds measured model transport. This is functional fault
acceptance, not a throughput or first-token benchmark.

The initial fault attempt incorrectly assumed `docker kill` would trigger the
restart policy. It manually stops the container. Control Plane was explicitly
started, its Run completed, and owned resources were released. The script now
performs kill/start and requires a replacement snapshot before accepting new
progress. The corrected full scenario passed; the initial attempt is not counted
as passing crash acceptance.
That prolonged initial outage also reached the existing Worker heartbeat timeout:
PG recorded retirement after the Tool/Loop finished, and its container restarted.
The corrected short-restart test used the replacement boot throughout. These
results do not establish that arbitrarily long Control Plane outages preserve
Worker ownership.

Across both attempts, native usage records reported 23,805 input, 62,464 cache-read
and 912 output tokens (87,181 total). These are Pi usage counters, not a monetary
billing claim. Owned native PG logs contained zero `tool.progress` or
`tool_execution_update` records.

## Cleanup and limits

Released both test Workspaces through the API and verified `storage_purged_at`
before removing test metadata. Removed two test users/tenants and 238 scoped PG
rows with foreign keys enabled. Counts returned to the pre-test baseline:
33 tenants, 35 users, one Session, seven Runs and one Workspace. Browser profiles
were automatically removed; no development machine was requested. Shared Kafka
records and official service logs retain their normal retention policy rather
than deleting other users' data to erase test traces.

Fresh matching Cube templates were deployed. Existing retention deleted one
unreferenced older template; seven older template cleanups were deferred by the
already-known stale Cube node-address issue. No user Volume was deleted by template
retention. That issue remains in BACKLOG, not claimed fixed here.

Progress loss is intentional on connection loss/reassignment. This change does
not restore a dead Tool process, recover old Loop callbacks, provide arbitrary
shell exactly-once semantics, or subscribe to background-service logs after the
Tool invocation returns. Broker/Worker loss preserves UNKNOWN and seal rules.
