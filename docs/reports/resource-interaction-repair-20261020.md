# Resource and interaction repair delivery

Status: implementation in progress, 2026-10-20. Not yet deployed.
The owner approved the [six-slice plan](resource-interaction-repair-plan-20261020.md).
The last verified serving release remains `model-runtime-058925bb`, schema 192.

| Slice | Source and verification | Live acceptance |
| --- | --- | --- |
| 1 — Live compute ownership/admission | Implemented; nine real-PG regressions, 95 existing tests and both affected typechecks pass | Pending matched release |
| 2 — Supervisor/workflow lifetimes | Pending | Pending |
| 3 — Delegation recovery/discovery | ADR-0264 approved; public-API prototype pending | Pending |
| 4 — Unknown Volume references | Pending evidence/protocol decision and implementation | Pending |
| 5 — Attachment lifetimes | Pending evidence/protocol decision and implementation | Pending |
| 6 — Terminal/preview lifetimes | Pending | Pending |

## Slice 1

Orphan retirement includes native child compute under the root Session authority
and terminal holders under their controller authority. It selects bounded hints,
locks the corresponding Workspaces, then rechecks users in a fresh PG statement.
Warm eviction separately claims `warm → cleaning` under the Workspace lock;
terminal or Tool admission cannot borrow compute after that claim.

Local recovery derives its known runtimes from warm, Tool and terminal holders.
Adoption joins the existing Workspace provisioning serialization and rechecks
local identity after the candidate snapshot. A recovered handle must match its
recorded Workspace. Profile changes cannot evict a terminal-held runtime.

Terminal admission now follows Session → Workspace lock order. A cleaning or
unknown shared runtime is busy, not permission to create a second terminal VM.
Workspace deletion combines its five occupancy checks and detached-Session count
under the existing lock. The empty-Workspace sample uses eight business SQL
statements instead of thirteen, excluding transaction framing.
The unused `turnWallClockTimeoutMs` field/initializer is removed.

The original seven PG review probes were replaced by maintained regressions in
`packages/sandbox-control/test/shared-compute-lifecycle.postgres.test.ts`, with
two additional admission/retirement races. All nine pass with real PG and a
controlled provider. Active terminal/child destruction is zero; the duplicate
adoption test also confirms ordinary eviction after explicitly closing the last
terminal. Concurrent Run/terminal admission both succeed. These are not live VM
fault tests. Sandbox-control and Control Plane typechecks pass. The 53 controller cases and
42 ownership/admission/cleanup/recovery cases pass (95 existing tests total).

An initial typecheck exposed a missing Workspace scope on the internal recovery
candidate; the port and fixtures now carry the existing PG identity explicitly.
Earlier broad test runs were stopped while refining that change and diagnostic
output; they are not counted as passing acceptance. The completed per-suite results above supersede those interrupted runs; live
release evidence remains pending.

Private test logs are under
`deploy/production/runtime/release-evidence/resource-repair-20261020/`.
No production accounts, configuration, credentials or resources have been changed.
