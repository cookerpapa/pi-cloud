# Shared-volume Subagent compute — acceptance

ADR-0171 is implemented and verified. Worker/Harness and Cube templates run
`fd07a098`; Broker/Volume Gateway run the compatible directory-error fix
`b84ecb30`. PostgreSQL schema is 141. The wider repository audit is **not complete**;
the resume remains unchanged.

## Contract and simplification

`subagent` and workflow `runs.run/all` accept `sandbox: shared|ephemeral` and
optional absolute `cwd`, independently of fresh/branch context. Every child
keeps the parent's Volume. Shared descendants inherit their parent's compute;
ephemeral children get lazy, separately recycled Cube compute. Run metadata
freezes cwd, compute scope and profile. Renewal never changes storage ownership.

The parent creates and merges Git worktrees using ordinary Bash/Git. PiCloud
does not copy Workspaces, initialize repositories, commit/stash/merge or remove
worktrees at child completion. Elastic Volumes mount at `/workspace`; machine
home Volumes mount at `/home/user`. The machine's other system-disk paths are
not shared through this mode. Cooperative shared storage is not file security
isolation between these collaborators.

Removed the copy RPC, provider/Gateway/control handlers, copy barriers, child
Workspace allocation/deletion, parent-copy metadata and the old tool parameter.
Migration 141 refuses legacy isolated copies instead of relabeling their data.
The reproduced LOCK-01 destructive-copy path is retired, not hidden by a new
retry or filesystem publication layer.

Root fixes found during implementation/acceptance:

- Runtime reuse now retains **per-binding cwd**, not the first binding's cwd.
- Workflow-key deduplication includes compute and cwd.
- SQL directory validation matches literal dots; its previous JS-escaped regex
  mistakenly rejected one/two-character directory names. Paths normalize trailing
  separators; browser limits match the 4,096-character cwd contract.
- Missing/inaccessible paths remain deterministic errors across both Volume and
  Broker HTTP boundaries. Previously a typed failure became retryable, leaving a
  child permanently preparing. No directory creation or fallback was added.
- CI fixture teardown waits for PG to observe closed clients before ordinary
  DROP DATABASE; FORCE caused late, uncaught FATAL errors in closing sockets.

## Verification

- Two paid DeepSeek passes: **25 parent Turns and 32 children**, covering direct/
  workflow starts, fresh/branch context, tool-less/lazy activation, parallel
  worktrees, recursion, messaging, supervisor decisions and intentional cancellation.
  Native commands confirm child Git commits, parent local merges and Python tests.
- Two parallel child runtimes differ from each other and the parent but use the
  same Volume. A shared grandchild uses its parent's private Cube, cwd and family
  lease. No child Workspace is allocated.
- Development-machine acceptance: shared home but separate `/etc`, parent and
  child serving distinct pages on port 5173, authenticated previews, Terminal/SSH,
  Broker restart, pause/resume, preserved parent processes and final release.
- Real negative tests on uninitialized and initialized Volumes returned explicit
  failure in **3.74/3.71 seconds including model time**. No child compute starts;
  failed child history remains readable through the product API.
- All default workspace test suites passed after correcting one stale UI label
  assertion (905 tests at initial cutover; opt-in gates reported separately).
  The final Broker suite passes 137 tests with five opt-in skips. Real-PG
  tenant/Broker tests pass, including three repeated tenant teardown runs.
- Build/types, 26 deterministic fault cases, 134 Web tests, browser presentation,
  Helm, runtime-policy, image-closure and documentation checks pass. GitHub CI
  passed `fd07a098`, `4eb95664` and `b84ecb30`.

The two DeepSeek runs report input **58,114**, cacheRead **707,200**, output
**17,294**. First-pass admission p50/p95: **20.8/39.4 ms**; first model dispatch
p50: **164.3 ms**; Pi text event → SSE client p50: **9.0 ms**. Parent text often
follows delegation, so it is not single-model TTFT. Two clock-jump samples exclude
cross-process decomposition. These measurements are API receipts, not browser
paint or multi-node performance claims.

Structured evidence: [Subagents](subagent-production-acceptance-latest.json),
[development machine](development-environment-acceptance-latest.json).

## Cleanup and remaining limits

All fixture Cubes/machine processes and Workspace bytes were released/purged.
After exact ownership, archived-state and quiescence checks, removed four new
test tenants plus the machine's scoped project data: **70 Run records and 43
Session views**. User identities outside these fixtures were preserved. Three
older, already-purged copy-fixture tenants were also removed for schema cutover.
Cleanup used FK-enforced transactions and rollback rehearsals, not global resets.

Eight unrelated old Cube templates still fail cleanup against a stale node
endpoint; they are **not** counted as deleted. Multi-node Volume attachment and
Cube-native launch-generation fencing remain separate audit/deployment work.
Temporary compute does not restore lost process memory or provide automatic Git
merge, atomic filesystem snapshots or protection against collaborators editing
the same files.
