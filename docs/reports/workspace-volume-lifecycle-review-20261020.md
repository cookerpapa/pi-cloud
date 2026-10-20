# Workspace and Volume lifecycle review

Status: review complete; findings are not repaired or deployed, 2026-10-20.
Baseline: `f9ca385e` (runtime `model-runtime-058925bb`, schema 192).
Scope: the first agreed resource/interaction review, from Workspace creation and
binding through VM ownership, recovery, retirement and physical Volume deletion.
Approval functionality is excluded. Later Subagent, upload and terminal/preview
reviews remain distinct slices; their resource-holding edges are included here.

## Findings

### WVL-01 · P1 · Unbound cleanup can retire compute still used by a terminal or native child

`claimUnboundWorkspaceRuntimes()` in
[`workspace-runtime-state-repository.ts`](../../packages/sandbox-control/src/workspace-runtime-state-repository.ts)
decides that old active compute is unbound from matching `active_execution_scopes`
and the root Run's `compute_session_id`. It does not account for live human
terminals. Under ADR-0247, an ephemeral child's compute ID is on its Session while
the sole cloud Run belongs to the root; that Run normally has a different compute
ID. A valid root lease therefore fails the current child-compute predicate.

Two real-PG characterizations reproduce selection while respectively:

- the terminal row is `active`, after its Agent Run has finished;
- the native child is `running`, with one valid root authority and only one cloud Run.

Two composed tests use the actual Controller/repository and a controlled provider.
Both reach a provider destruction method while those users remain live. Only
fixture timestamps are aged; no real VM is destroyed. The ordinary root-compute
positive control is protected by its matching active lease.

Trigger: an old `reserved/materializing/active` row crosses the existing orphan
grace (at least two controller lease periods/30 seconds), or loses the retained
Session predicate. The controller's periodic cleanup then closes its allocation.
This is resource retirement, not a native Run timeout; retaining Workspace bytes
does not prevent interruption of processes in that VM.

Direction: define in-use compute from current native child/physical binding and
terminal relationships under the shared Session authority. Recheck those users
at the retirement boundary, including concurrent new admission. Do not restore
child Run rows/leases or replace lifecycle authority with a delayed Kafka cache.

### WVL-02 · P1 · Periodic recovery treats terminal-only compute as missing and idle

[`SandboxController.#recoverElasticRuntimes()`](../../packages/sandbox-control/src/sandbox-controller.ts)
builds its known-runtime set from Tool bindings and the warm pool. Once the last
Agent binding is released, a live human terminal may be the sole local holder;
that holder is omitted. The PG recovery selector also permits the current owner
to recover its own rows, so the 30-second recovery loop can adopt the same live
VM again. It creates a new runtime object with no terminal ID and puts it in the
warm pool when no Tool binding remains.

The composed PG/Controller probe observes warm count `0 → 1`, one redundant
adoption, and then one provider destruction while the terminal is still `active`.
It advances a fixture-only one-second warm TTL; this is not a measurement of the
deployed fifteen-minute TTL. Capacity-driven warm eviction is another reason an
incorrect idle classification matters.

Fixing WVL-01's SQL alone does not fix this path. Direction: maintain one physical
runtime identity and account for terminal holders consistently in local recovery,
warm eligibility and observation. Reuse the existing Controller ownership; do not
add a second durable resource authority. A regression must verify zero duplicate
adoptions and no warm eviction while the terminal remains a user.

### WVL-03 · P2 · Unknown reference recovery loses the cleanup target and cannot converge

This confirms and narrows the previously recorded Cubelet-crash cleanup limit.
The maintained Cube patch's `refcount.Store.RecoverRefCounts()` removes stale
holder IDs and sets `Unknown=true`, without retaining them as pending detach
work. `Manager.finishPendingDetach()` rejects unknown state before executing a
cleanup hook. `ObserveReference()` retries that helper but returns the still
unconfirmed state; polling cannot supply the missing recovery step.

Real Bolt/native Manager probes reproduce:

- last holder lost: count zero, unknown, no pending detach identity; repeated
  observation and a new attach do not recover;
- one shared holder survives: count one, unknown; even the surviving holder's
  later detach is blocked before calling the plugin;
- ordinary persisted pending detach: the existing mechanism converges, calls
  the plugin once and confirms zero. An unrelated Volume remains usable.

Sources: the `store.go`, `state.go` and `manager.go` portions of
[`0004-recoverable-vm-allocation.patch`](../../deploy/cubesandbox/patches/0004-recoverable-vm-allocation.patch).
The [October 17 live evidence](tool-reply-continuation-20261016.md) independently
required positively confirmed operator cleanup. That fixture was cleaned then;
this review does not report a currently stranded production Volume.

The conservative deletion refusal is correct. Direction: specify how original
holder/node/store identity and physical absence authorize bounded reconciliation
through the fixed POSIX plugin. Preserve pending identity before discarding the
old holder, shared holders, creation closure and monotonic reference state.
Changing that recovery evidence/protocol requires an ADR. A timeout, missing
heartbeat or zero count cannot replace positive cleanup evidence. VM quota
release and Volume-byte deletion remain separate decisions.

### WVL-04 · P2 · Terminal admission and Run admission acquire locks in opposite order

[`ControlPlaneStore`](../../packages/control-plane/src/control-plane-store.ts)
locks Session `FOR NO KEY UPDATE`, then Workspace `FOR SHARE` for a new Run.
[`reserveTerminal()`](../../packages/sandbox-control/src/workspace-runtime-state-repository.ts)
locks Workspace `FOR UPDATE`, then Session `FOR UPDATE`. Concurrent ordinary
actions can each hold the row the other needs.

A barrier-controlled real-PG test forms this cycle using the actual two methods.
The existing lifecycle `lock_timeout` breaks it: terminal admission fails with
`unavailable` / PG `55P03`, and Run admission succeeds. The corrected final sample
settles in 522 ms. This is a bounded failure, not a claim of indefinite deadlock
or a measured production incidence rate.

Direction: establish one compatible lock order for Session/Workspace admission,
deletion and rebind. Keep atomic deletion/admission exclusion; simply removing
the locks or replacing the Workspace read with a cached view is not equivalent.

## Measured simplification opportunities

- **WVL-O1:** deleting an unused, single-Workspace project issues 13 business SQL
  statements, excluding BEGIN/COMMIT. Five independent occupancy checks (Run,
  terminal, development machine, native child, Issue job) can be evaluated together
  while retaining the Workspace lock and useful refusal reasons. This is a
  low-frequency optimization, not a reason to add another cache or weaken checks.
- **WVL-O2:** `SandboxResourcePolicy.turnWallClockTimeoutMs` still has a 900,000 ms
  initializer in the Cube provider, but repository search finds no execution
  consumer. Actual Cube creation passes `timeoutSeconds: -1`. Remove the obsolete
  internal field in a matched cleanup; it is misleading metadata, not an active
  fifteen-minute Run limit. Do not mistake it for a remaining runtime timer.

## Reviewed boundaries and retained design

| Boundary | Inspected current implementation / evidence |
| --- | --- |
| Workspace create/delete/rebind | ControlPlaneStore, current Workspace admission tests, native Session quiescence and machine release guards |
| Dedicated machine lifecycle | DevelopmentEnvironmentService create/action/reconcile/retire and Controller provisioning/adoption/release |
| Compute reservation and cleanup | PostgresWorkspaceRuntimeStateRepository, SandboxController, SandboxAdmission, binding references and ordered revocation |
| Volume transport/bytes | Cube provider/client ensure/delete/close, Volume deletion reaper, Gateway prepare/finalize, filesystem locks and fixed POSIX plugin |
| Native reference/admission | CubeMaster allocation Volume holds/generation/state, Cubelet persisted refcounts/Manager/startup reconstruction and allocation contracts |

The following constraints remain justified and were not proposed for removal:
PG admission holds the current Workspace decision through commit; rebind requires
settled work/no writer; native allocation closure excludes late creation; shared
Volume holds survive uncertain replies; the Gateway never initializes storage on
a read; generation-bound deletion waits for filesystem users and physical evidence.
Persistent Cube Volume remains the sole Workspace-byte authority. No alternate
archive, child scheduler, heartbeat-based deletion or whole-VM Tool-error cleanup
is recommended.

## Verification and scope limits

- 205 existing Node tests across 11 relevant files pass (94 lifecycle/PG/Gateway
  cases plus 111 Controller/provider/client cases).
- Seven new real-PG characterization/measurement cases pass **by reproducing the
  baseline behavior above**. They are not passing fixed-behavior regressions.
  The native child fixture projects public task records; it does not run a model
  or a full Harness. Controller composition substitutes only physical provider
  operations and binding transport with controlled test implementations.
- Three new native reference scenarios run on the exact patched Cube source,
  real Bolt and the native Manager. The Volume package run passes eight top-level
  Go tests / twelve pass events including subtests, with the race detector.
- The maintained native allocation check passes real MySQL/Bolt/reference and
  execution contracts: 55 top-level tests / 77 pass events, plus the cubebox
  lifecycle integration package. These counts overlap the ordinary Volume tests;
  they are not an additive independent-test total.
- The final probes typecheck. Earlier composed-fixture typing was tightened to
  valid seed/environment schemas and a complete controlled provider interface;
  all seven cases reproduce again. These fixture corrections are not production
  findings. Initial local extraction inside the parent Git checkout skipped
  patches; inspection caught it before native testing, and the maintained probe
  driver now always extracts into its own temporary directory and checks hashes.

Reproducers and exact commands:
[`scripts/experiments/review-workspace-volume-20261020/`](../../scripts/experiments/review-workspace-volume-20261020/README.md).
Content-free measurements: [JSON](workspace-volume-lifecycle-review-20261020.json).
Private raw logs: `deploy/production/runtime/review-evidence/workspace-volume-20261020/`.

No production code, deployment, account, provider configuration, Kafka offset or
existing VM/Volume was modified. Disposable PG/MySQL/native test resources are
closed by their fixture lifetimes. No live Cubelet fault was repeated; the prior
real crash receipt is cited separately. Fixes and any changed lifecycle contract
need their own implementation/acceptance slice.
