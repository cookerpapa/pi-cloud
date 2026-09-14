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
| API, auth, resources, Run admission | Pending | Pending |
| Worker ownership, queue, capacity | Pending | Pending |
| Native log, Harness, Lanes, Compaction | Pending | Pending |
| Kafka, projection, streaming and recovery | Pending | Pending |
| Tools, Cube, Volumes, machines, Preview/SSH | Pending | Pending |
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
| LIFE-02 | Control Plane orderly shutdown stops cleanup after the first rejected close | Candidate cleanup failure; inject rejection and verify remaining components close |
| MEM-01 | Control Plane caches management clients by URL without eviction as Worker addresses churn | Candidate boundedness issue; inspect actual client ownership and churn behavior |
| RESTORE-01 | Investigated whether open fetches already-reconciled interruption prefixes | Ruled out: native projection clears the prefix and migration 131 provides a pending-only partial index; no extra cache or query rewrite added |
| UI-01 | Product/admin origin detection and redirects hard-code ports 8080/8081 | Source-confirmed configuration assumption; test supported custom deployment ports |
| MUT-01 | Rebind and cancel check idempotency before acquiring their lifecycle row locks, then can reject on changed state | Candidate concurrent replay bug; reproduce with separate real PostgreSQL connections |
| LIFE-03 | Active Lane cold-history waits use the shared writer signal, not the task's cancellation signal | Candidate blocked cancellation; trace Runtime abort and test projection lag without poisoning sibling Lanes |
| CANCEL-01 | `abort()` was lost before the native Agent existed; cancellation during intent ACK still called the Tool | Reproduced model/effect calls after cancellation. Latched cancellation, checked the existing signal after intent commit, and kept aborted native outcome; unit regressions pass |
| CANCEL-02 | A local pre-sampling abort was classified as an assistant completion missing a Cloud Step | Reproduced through Runner; recognize the explicit no-sampling cancellation without inventing a Step. Runner/Harness suite: 48 pass |
| LIFE-04 | Worker Ready only checks local process/channel state, while a permanently failed publisher can block every future claim | Candidate health/liveness defect; distinguish transient provider unavailability from terminal publisher failure before proposing a fix |
| CFG-01 | Producer startup checks partition count but not existing topic replication/retention policy | Verify actual settings and configuration contract in isolated broker tests |
| MUT-02 | Tenant admission locks the smallest existing tenant UUID, which can change when a new tenant is inserted | Candidate concurrency-capacity race; reproduce overlapping registration transactions in real PostgreSQL |

No architecture change proposed yet. Three runtime-composition tests, 48
Runner/Harness tests and two Worker runtime tests passed; affected package type
checks passed. No paid/live
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
