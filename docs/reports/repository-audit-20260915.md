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
| CP-01 | `main` provides an HTTP Steer backend factory, but runtime composition drops it; the service uses the local WebSocket path instead | Source-confirmed wiring defect; reproduce request on a replica without the Worker connection |
| CP-02 | Admission metrics are dropped by runtime and module composition before reaching the store factory | Source-confirmed wiring defect; assert metric observation through the public API |
| LIFE-01 | Worker creates/listens on Model Gateway, but records it for cleanup only after upstream health succeeds | Candidate startup leak; fail a local fake provider health check and inspect listener cleanup |
| LIFE-02 | Control Plane orderly shutdown stops cleanup after the first rejected close | Candidate cleanup failure; inject rejection and verify remaining components close |
| MEM-01 | Control Plane caches management clients by URL without eviction as Worker addresses churn | Candidate boundedness issue; inspect actual client ownership and churn behavior |
| RESTORE-01 | Native host fetches all unpruned interruption prefixes on every open, including already reconciled history | Candidate restore amplification; measure long interrupted histories and deduplication before changing query |
| UI-01 | Product/admin origin detection and redirects hard-code ports 8080/8081 | Source-confirmed configuration assumption; test supported custom deployment ports |

No architecture change proposed yet. Reproducers and regression results remain
pending. Architecture-level issues block only their own modifications; continue
independent review and verification while awaiting the owner.

## Resources and final gate

Before mutation, inventory existing tenants/users/resources, image revisions and
configuration digests without disclosing credentials. Register test resources
explicitly. Delete only those fixtures after drain/seal/physical purge; preserve
formal diagnostic logs and real user data. Keep aggregate results, not raw
transcripts or credentials. Final CI checks, clean-state matrix, cleanup and
resume update are all pending.
