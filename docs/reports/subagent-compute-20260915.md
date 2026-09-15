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
scope authorization and no parent storage deletion. Full check and real deployed
acceptance are still pending; no live-VM claim follows from these fakes/contracts.

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
documentation checks pass. Deployment and paid acceptance remain pending.
