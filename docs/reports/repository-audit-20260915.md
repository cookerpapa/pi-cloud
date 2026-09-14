# Repository audit and system validation — 2026-09-15

Base: `1d7d7f8f`. Status: **in progress; not a full-review completion claim**.
Prior reports are historical evidence, not a substitute for this campaign.

## Scope and execution

Read maintained code, tests, migrations, deployment, configuration, CI and current
documentation. Identify generated/dependency material separately. Track file
hashes and reviewed line ranges in one private machine-readable ledger; reread
changed files. Do not infer whole-file coverage from search or truncated output.
No delegated review agents. Change current semantics only after owner discussion.

Sequence: verify implementation → README → complete static review and local
regressions → real product/API/UI and concurrent workloads → failures/latency
analysis → final clean-state retest → fixture cleanup → final report → resume.
Resume changes wait until completion and use v11; existing v9/ESG work is preserved.

## Coverage

Initial inventory: 922 tracked files. The large line count includes tests,
historical schema migrations, deployment and generated evidence. Dependency
lockfiles need dependency/CI validation rather than manual source review.

| Area | Code review | Runtime/combination acceptance |
| --- | --- | --- |
| Implementation map / README | Entry-point/data-flow map updated; detailed file coverage continues | Runtime inventory read-only |
| API, auth, resources, Run admission | Controller/auth/composition/store and machine service read; remaining resource/control services in progress | Local HTTP regressions only; live pending |
| Worker ownership, queue, capacity | Pending | Pending |
| Native log, Harness, Lanes, Compaction | Session backend package read; cancellation/projection-wait finding remains open | 92 offline tests pass; real PG plan case and live combinations pending |
| Kafka, projection, streaming and recovery | Pending | Pending |
| Tools, Cube, Volumes, machines, Preview/SSH | Broker/transport/Volume implementations read; Cube adapter and remaining lifecycle code pending | Owned local fault regressions only; Cube acceptance pending |
| Model routing/configuration and hosted search | Pending | Pending |
| Subagent lifecycle and communication | Pending | Pending |
| Frontend pages, controls and rendered latency | Pending | Pending |
| Configuration, deployment, migration, CI, monitoring | Pending | Pending |
| Scripts/tests/current docs and unused-code cleanup | Pending | Pending |

## Required live matrix

Track separately: single/multi-round/reload; same-user multi-Session; multi-tenant;
Worker handoff; provider/model/reasoning/Fast handoff; repeated Compaction with
coding/search/children; direct/workflow, fresh/branch, shared/isolated Subagents;
multiple services in one Session and across Sessions; actual Preview behavior;
cancel/failure/restart and cleanup; every reachable core UI action.
Use gradual bounded load in this project's environment. Hosted search uses the
normal provider capability, never third-party load testing.

Latency must distinguish backend admission, queue/claim, context/model preparation,
provider first text, publication/projection, SSE receipt and actual browser paint.
Do not subtract unrelated sampling intervals or invalid cross-host wall clocks.

## Findings and decisions

| ID | Observation | Status / next proof |
| --- | --- | --- |
| CP-01 | `main` provides an HTTP Steer backend factory, but runtime composition dropped it; the service used the local WebSocket path instead | Fixed by forwarding application options intact; API regression returned 503 before and 200 after, with no local Worker socket. Live multi-replica retest pending |
| CP-02 | Admission metrics were dropped by runtime and module composition before reaching the store factory | Fixed wiring; API acceptance and resource-create histograms now observe samples. Same regression failed before, passes after |
| AUTH-01 | Both authenticators awaited a usage UPDATE on every valid request, even within the five-minute refresh interval | Reproduced redundant SQL calls; use `last_used_at` from the authority read to skip fresh updates, preserving conditional concurrent refresh and uncached revocation checks. 12 auth/gateway tests and type check pass |
| LIFE-01 | Worker creates/listens on Model Gateway, but records it for cleanup only after upstream health succeeds | Reproduced a live listener after failed startup. Register ownership before startup awaits (also the owned Kafka log); two Worker runtime tests and type check pass. Kafka partial-start failure still needs separate injection |
| LIFE-02 | Control Plane orderly shutdown stopped cleanup after the first rejected close | Reproduced skipped Projector/DB/metrics closes. Share one ordered teardown on startup failure and shutdown; attempt every close and surface aggregated errors. Two lifecycle regressions pass |
| MEM-01 | Control Plane cached management wrappers for every historical Worker URL | Removed unused object cache: wrappers hold no connections and already share the HTTP dispatcher; no routing/authority change |
| RESTORE-01 | Investigated whether open fetches already-reconciled interruption prefixes | Ruled out: native projection clears the prefix and migration 131 provides a pending-only partial index; no extra cache or query rewrite added |
| UI-01 | Product/admin origin detection and redirects hard-code ports 8080/8081 | Source-confirmed configuration assumption; test supported custom deployment ports |
| MUT-01 | Rebind and cancel check idempotency before acquiring their lifecycle row locks, then can reject on changed state | Candidate concurrent replay bug; reproduce with separate real PostgreSQL connections |
| LIFE-03 | Active Lane cold-history waits use the shared writer signal, not the task's cancellation signal | Candidate blocked cancellation; trace Runtime abort and test projection lag without poisoning sibling Lanes |
| CANCEL-01 | `abort()` was lost before the native Agent existed; cancellation during intent ACK still called the Tool | Reproduced model/effect calls after cancellation. Latched cancellation, checked the existing signal after intent commit, and kept aborted native outcome; unit regressions pass |
| CANCEL-02 | A local pre-sampling abort was classified as an assistant completion missing a Cloud Step | Reproduced through Runner; recognize the explicit no-sampling cancellation without inventing a Step. Runner/Harness suite: 48 pass |
| CANCEL-03 | Acknowledged cancellation failure changed business state but omitted the output seal and task-authority release | Reproduced missing Outbox terminal and zero release calls. Reuse failure closure in the same transaction; seven queue tests pass. Keeps the existing failed/quarantined Session state, not a successful cancellation |
| LIFE-04 | Worker Ready only checks local process/channel state, while a permanently failed publisher can block every future claim | Candidate health/liveness defect; distinguish transient provider unavailability from terminal publisher failure before proposing a fix |
| CFG-01 | Producer startup checks partition count but not existing topic replication/retention policy | Verify actual settings and configuration contract in isolated broker tests |
| MUT-02 | Tenant admission locks the smallest existing tenant UUID, which can change when a new tenant is inserted | Candidate concurrency-capacity race; reproduce overlapping registration transactions in real PostgreSQL |
| OBS-01 | Rejected metric collection escaped a native HTTP async callback | Reproduced a hanging scrape plus unhandled rejection. Return 503 for that scrape; next scrape succeeds |
| OBS-02 | Trace status used a safe error code but exception events still exported the raw message/stack | Reproduced with a synthetic secret in an owned error. Export only classification, rethrow the original error to its caller |
| CFG-02 | Control Plane parsed/mounted an unused dedicated PG notification URL | Deleted CP option/mount; Worker's actual LISTEN connection and bootstrap direct-PG settings remain |
| CFG-03 | CP/Broker/Volume Gateway rejected group-readable secrets while Helm mounts them 0440 under fsGroup | CP and Broker loaders reproduced failure with owned 0440 fixtures; aligned process-group read permissions while rejecting group writes/world access/symlinks. 44 Bootstrap/Broker/cleanup regressions pass. Actual Kubernetes startup and Volume Gateway child-process check remain pending |
| DEV-01 | Machine creation checks replay before tenant lock; pause/resume replay treats a recorded request as a completed effect | Candidate concurrent create / failed lifecycle replay errors; reproduce after Broker lifecycle review |
| DEV-02 | Machine lifecycle descriptor requires an active Domain and non-failed environment profile, including release | Candidate inability to release resources in a drained/failed Domain/profile; check lifecycle contract and reproduce |
| DEV-03 | Broker concurrent duplicate machine provisioning created two provider runtimes; simultaneous first task bindings chose the same binding ID | Both reproduced. Reuse existing per-Workspace provisioning critical section for machine provisioning/binding creation, not Tool execution. Concurrent parent/child bindings now stay distinct and reuse one runtime |
| DEV-04 | Machine handle entered the ready map before durable state publication; failure destroyed the VM but retained that handle | Reproduced phantom active count. Publish PG state before installing the ready handle; clean failure no longer advertises a destroyed runtime |
| TOOL-01 | A reused persistent-machine binding could return a cached response belonging to an earlier Attempt | Reproduced by delaying old-body retirement while rebinding. Match the reader Attempt as well as binding ID; no PG round trip added |
| CLEAN-01 | Binding-local `materializing` was never written; old terminal-capacity transfer path had no reachable caller | Removed the field/branches/transfer method and its dead-feature test. Physical runtime materialization and concurrent Tool execution remain |
| CLEAN-02 | Native Lane exposed its private reader despite having no caller; one Fork test name incorrectly implied no payload copy anywhere | Removed unused getter; clarified shared query projection versus self-contained Fork log. No persistence semantics changed |
| LIFE-05 | Broker HTTP listener remained open after provider teardown failed | Reproduced with actual local listener; close HTTP in `finally`. Eight RPC/server regressions pass. Also removed unreachable HTTP-side Tool timing branch; executor owns execution timing |
| FILE-01 | Trusted Git preflight discovered a Workspace's `.git/config` | Owned fake-SSH marker reproduced local config execution. Run network preflight outside user directories and disable global Git config; no real credentials or external server involved |
| FILE-02 | Credential reads followed a Workspace symlink outside its volume | Reproduced against an owned fixture; open non-following, nonblocking regular file and bound actual bytes read |
| FILE-03 | Browser path validation could race a parent-directory replacement before open/readdir | Reproduced outside fixture content/names. Validate the opened Linux descriptor and retain it for listing; bound reads if files grow after stat. Volume regression suite passes |
| PERF-01 | Git preflight held the Volume lock/PG lock connection during remote network wait | Reproduced blocked directory access; release after reading the credential, then perform the independent network probe |
| LOCK-01 | Volume advisory-lock connection failure is detected after the filesystem callback completes | Needs real PG disconnect + fork/delete interleaving proof; do not change storage/authority semantics without discussion if a local atomic-filesystem fix is insufficient |
| MEM-02 | Supervisor retains completed Assignments and their prompt/publisher closures in `byRun`, plus completed control requests | Source-confirmed retention; measure owned synthetic traffic and preserve duplicate/no-replay semantics when reducing retained state |
| TIME-01 | Lease/claim timestamps are captured before potentially blocked SQL updates | Probe delayed renewal versus actual expiry/seal with real PG; do not silently change the authority clock model |

Architecture question ARCH-01 (asked, awaiting owner): should a Session quarantined
after cancellation cleanup failure accept a new Turn after the old loop's exit and
committed seal are confirmed? Existing behavior only permits Fork/prune. No old
Run/Tool replay is proposed; ordinary failure-closure bugs are fixed independently.
| CFG-04 | Helm CP sets global HTTP(S) proxy but no NO_PROXY; several private Broker requests use global fetch | Candidate internal routing through provider proxy; verify actual runtime/Node proxy contract in owned deployment test |

No architecture change proposed yet. Local regression slices passed: three
runtime-composition tests; 50 Worker/Runner/Harness tests; 12 auth/gateway tests;
69 Broker/admission/Tool-result/bootstrap/shutdown/monitoring tests. These slices
overlap earlier runs and are not a full-suite total. Native storage package: 92
offline tests pass, one real-PG-only plan test pending. Volume/RPC follow-up: 27
pass. Affected type checks passed. No paid/live
test was run in this campaign yet. Fixes are not deployed to the running stack yet.
Architecture-level issues block only their own modifications; continue
independent review and verification while awaiting the owner.

## Resources and final gate

Before mutation, inventory existing tenants/users/resources, image revisions and
configuration digests without disclosing credentials. Register test resources
explicitly. Delete only those fixtures after drain/seal/physical purge; preserve
formal diagnostic logs and real user data. Keep aggregate results, not raw
transcripts or credentials. Final CI checks, clean-state matrix, cleanup and
resume update are all pending.
