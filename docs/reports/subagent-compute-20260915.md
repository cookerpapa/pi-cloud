# Shared-volume Subagent compute

Status: in progress. Base `9d0a7cb0`. Implements approved ADR-0171; no completion
or live-acceptance claim yet. The wider repository audit and resume update remain open.

- [x] Read current architecture and map child admission, Broker reservation and mounts.
- [x] Tool/workflow contract, frozen cwd and compute scope in PG/Worker.
- [x] Multi-compute Broker/Volume binding, explicit path validation, lifetime.
- [x] Remove child-copy APIs/storage lifecycle and update UI/docs.
- [ ] Regressions and real direct/workflow/nested worktree coding/merge acceptance.
- [ ] Verify retention/isolation; remove owned fixtures; commit/push.

Machine home is an external Volume at `/home/user`; its other system-disk paths
are not portable through this shared-volume mode. Elastic mount root is `/workspace`.
Keep both mount paths stable across parent/child VMs.

## Implemented and local evidence

The direct tool and `runs.run/all` use `sandbox: shared|ephemeral` plus `cwd`.
PG freezes scope/cwd/profile in the child Run; shared descendants inherit the
scope. Broker keys runtime reuse by Workspace and compute scope, keeps cwd per
binding and reaps compute without deleting storage. Preview selects child compute,
not the parent's development machine. Explicit cwd uses the existing authorized
live filesystem reader before queue release.

Removed Volume copy RPC/provider/gateway/control handlers, copy barriers, child
Workspace allocation/deletion, parent-copy metadata and the old tool parameter.
Migration 141 refuses legacy isolated copies instead of relabeling their semantics.
Three exact archived audit tenants (`subagent-mu20fwp7`, `subagent-mu20vumd`,
`subagent-mu27le43`) had zero active Runs/unpurged Volumes; their obsolete fixture
metadata was deleted after a transaction rollback rehearsal, with FK checks
enabled. No real user identities or files were targeted.

Additional root fixes: shared runtime bindings now use their own frozen cwd;
workflow-key deduplication includes sandbox/cwd; directory constraints use literal
dot matching (the previous JS-escaped SQL regex rejected one/two-character path
segments); explicit cwd normalizes trailing separators. Browser path limits now
match the 4,096-character working-directory contract.

Local targeted runs: 73 core tests, 35 provider/workflow tests and 36 directory/
schema/context/preview tests passed (overlapping suites, not an additive total).
Coverage includes same Volume/different runtime, inherited scope, missing/symlink
directory rejection, long directories, no local eager activation, fixed cwd,
scope authorization and no parent storage deletion. Subsequent full/deployed
gates are recorded below; no live-VM claim follows from these fakes/contracts.

Real PostgreSQL (owned disposable database) passed the three Broker ownership
contracts, including scope mismatch rejection and two compute reservations on
one Workspace. The 40-test Broker suite also passed with a scope-specific TTL
assertion: the idle child expires while the active parent continues on its
original runtime. Local build/type checks passed. The full default suite found one
stale UI assertion expecting the retired Workspace-mode label; it now asserts
the compute label and all 134 Web tests pass. Across workspace suites, 905 tests
pass and 25 opt-in tests are skipped; five acceptance-helper tests also pass.
These numbers do not claim paid/opt-in coverage.

All 26 deterministic fault cases pass after replacing the retired copy target
with compute-scope expiry. The report marks its uncommitted working tree so it
cannot be mistaken for an unchanged baseline revision. Browser presentation
checks pass (15 grouped invariants); Helm, runtime-policy, image-closure and
documentation checks pass. These local gates alone do not prove deployed acceptance.

## First deployed acceptance

Runtime `fd07a098` is deployed with schema 141 and matching Cube templates.
All services returned healthy. DeepSeek Flash completed 12 parent Turns and
15 children (including one deliberately cancelled child): direct and scripted
tasks, fresh/branch Lanes, tool-less/lazy activation, shared compute, separate
worktree compute, parallel worktrees, recursion, messages and supervisor replies.
Native Tool calls confirm ordinary Git worktree creation, child commits and
parent local merges; executable Python checks and the merged marker pass.
The two parallel child runtimes differ from each other and the parent, while
all use the same Workspace/Volume. No child Workspace was allocated.

Reported usage: input 33,048, cacheRead 317,824, output 7,884. API admission
p50/p95: 20.8/39.4 ms; first model dispatch p50: 164.3 ms; Pi text event → SSE
client p50: 9.0 ms. Parent text often follows delegation, so it is not a
single-model TTFT. Two wall-clock-jump samples exclude cross-process stage
decomposition; their monotonic totals remain recorded. These are API receipts,
not browser paint or multi-node latency claims.

Fixture `subagent-mu2hb5yc`: conversation views archived, all four compute
runtimes released and the one Volume purge confirmed. Its archived metadata
remains until final scoped cleanup. A stronger nested-compute case and a
machine-home/same-port Preview case are queued for the next live pass.

Historical CI failure `34940633675` came from FORCE-dropping a test database while
closing PG sockets still existed. The fixture now waits for server-observed
connection exit and uses ordinary DROP, rather than swallowing terminal errors.
Seven real-PG tenant/Broker tests pass with that teardown.

Template retention selected eight old templates but Cube cleanup still times out
against the stale node endpoint; none of those eight is counted as deleted.
