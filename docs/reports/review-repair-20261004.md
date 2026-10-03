# October 4 follow-up review repairs

Status: implemented and deployed. Matched protocol-3 Cube/application release,
schema 170, real-model tools, Pod replacement, path probes, shared-VM cancellation
and image-queue acceptance pass. Direct containerd-task SIGKILL (exit 137) also
passes. [Final inventory](review-r2-rollout-20261004.json) is recorded. No production data reset.

The owner approved the [follow-up review](repository-review-20261003-r2.md) fixes
and Kafka-ordered stopping. Decisions are recorded in [ADR-0218](../adr/0218-review-boundary-repairs.md)
and [ADR-0219](../adr/0219-ordered-cube-admission.md).

## Changes

| Finding | Implemented behavior |
| --- | --- |
| R2-01 | Bound the composed input, attachment metadata and encoded image hints before committing human input/edit/steer. Preserve text without truncation. Worker validates the same native serialized Fact budget. |
| R2-02 | PG computes Subagent cancellation availability and supervisor request/reply deadlines, including expiry after row-lock acquisition. |
| R2-03 | Persist due times and capped retry delays for Workspace/image cleanup. One failed deletion does not block unrelated resources; node absence and attachment reachability remain required. |
| R2-04 | Four Kafka gates provision isolated pinned RF3 fixtures or use explicit test endpoints. Remove the retired production Docker-network dependency and redundant load worker. |
| R2-05 | Verification reminders and recognition resolve commands from the frozen Run working directory, including directories containing spaces. |
| R2-06 | SSH, terminal open/resize and Cube share the same 1,000-column/500-row transport constraints. |
| Q2-01 | The queue cancellation and binding-closure suites explicitly use real PostgreSQL. The default command provisions a disposable pinned database; CI can supply its existing isolated test URL. |
| O2-01 | Ordinary Subagent maintenance issues two affected-Run indexed reads instead of four global reads. Startup, deadlines and bounded-index overflow retain recovery. |
| D2-01 | PG binding closure follows the Session Kafka path. Cube admits by boot and VM/partition position, without lifetime closed-Run/writer/operation sets or the permanent global exhaustion latch. Normal release waits for stopped; quarantine retains uncertainty and quota. |

The final execution seal still follows scope closure. An old Projector RPC already
in flight is rejected when its source position predates the destination's progress.
A lost lifecycle ACK replays Stop; no arbitrary Tool command is replayed. Active
operation bodies/fingerprints are removed after bounded result delivery. Probe
observations never advance effect admission.

Migrations 169 and 170 add fair cleanup deadlines and bounded binding closure
metadata. Native Session log and guest Tool wire are unchanged. Managed Cube
transport is version 3 with no version-2 fallback. The native execution/probe
patches are consolidated into one maintained patch, pinned by digest.

## Evidence

The repaired runtime source is `98379564`, build proxy forwarding is `3b991061`,
and live recovery corrections are `d9f8ebc4` / `21b3f206`. The latest fault report
runs against clean `21b3f206`; the earlier working-tree run remains in Git.

- Full `npm run check` before the live recovery corrections: 1,699 passing tests in 251 files, nine explicitly skipped
  external-runtime cases. Type checking passes across all workspaces. Separate
  real Kafka integrations cover three of the external paths.
- [Fault evaluation](review-repair-faults-20261004.json): 154/154 selected contracts
  pass across 59 test groups. These overlap the normal suite; counts are not additive.
- Formatting, documentation, dependency hardening, installation contracts, Helm,
  runtime policy, observability, image closure and application builds pass.
  The existing high-severity security gate passes; two moderate dependency
  findings remain and are not represented as newly repaired here.
- Matched native build: managed protocol 3, guest wire 2, patch set
  `5fb3cf5860924168`, completion source `e95a4d4d830096b65a5242fdfdc387efcb132dc5`.
  Cube Helm release 22 uses the same pinned chart and declarative renderer as
  installation. The host-initialization entry requires root; updating this
  existing cluster used the prepared, server-validated release and imported
  images, with no extra post-deployment patches.

- Targeted composed-input, Runner and attachment contracts; 28 queued-input tests
  pass with the default disposable PostgreSQL command.
- Real PostgreSQL clock-skew and post-lock-expiry tests; real cleanup fairness
  test with 16 failing Workspaces followed by a healthy 17th.
- 126 controller/provider/client/routing/view tests and 11 real-PG ownership/
  closure tests. An old open fact cannot issue Stop at an incorrect log position.
- Real PG + RF3 Kafka: final seal follows ordered Cube closure; deliberately lost
  ACK causes identical Stop replay. Cube RPC is simulated in this integration
  test; it does not claim a live VM execution. The Subagent control integration
  also passes with zero idle SQL reads during its measured window.
- Native Go race tests cover old-owner arrival, same-position cleanup, active
  duplicates, sibling survival, independent partitions and 70,000 closures.
  Targeted Cubelet service and CubeMaster managed-endpoint tests pass. Attempting
  unrelated upstream whole-package tests exposed their existing host/network/
  NUMA assumptions; those suites are not represented as passing here.
- Kafka fixture gates: 6,000 offered/66 accepted/5,934 capacity refusals, all 66
  persisted; partition isolation and native retention pass. A two-case, 34-event
  load smoke validates the command, not deployment capacity.

Historical baseline reproducers live at commit `2c2e1310`; they were removed from
current scripts after repair. Maintained regression tests and
`npm run cubesandbox:admission-check` now assert the intended behavior.

## Limits

One host is not physical-node HA. Neither Kafka ordering nor scoped stopping
provides exactly-once arbitrary shell effects. Quarantined or replaced-executor
results remain UNKNOWN. The Cube extensions remain an explicit maintenance
responsibility. Binding ACK waits are bounded lifecycle work, not per-Tool SQL;
missing observations never authorize deletion or quota release.

## Live recovery correction

The first [live controller crash attempt](review-r2-handoff-restart-initial-20261004.json)
failed with `cubesandbox_tool_unavailable`. Controller shutdown/expiry marked
capsule-backed VMs unknown; the quarantine trigger closed their bindings, and
the new ordered handler correctly stopped those scopes. The error was treating
controller loss as physical uncertainty. Two real-PG regression cases reproduce
closed bindings on both shutdown and expiry before the fix. The corrected
repository preserves capsule-backed VM state for verified adoption; missing
capsules and genuine recovery/physical failures still close admission. The full
sandbox suite then passes 239 tests, including both new cases. No VM is declared
healthy merely because it has a capsule.

The [next attempt](review-r2-handoff-restart-notification-20261004.json) completed
the Run but exposed a failed Tool. A bounded diagnostic trace then showed a
verified VM and open adopted binding, followed exactly 15 seconds later by
`runtime_recovery_unconfirmed` after the synchronous adoption notification
failed. Adoption and already-confirmed retirement now rely on committed Outbox
references; new registration/closure retain their barriers. Pending closure
recovery defers without quarantining siblings or installing partial local state.
The 89 affected controller/routing/PG/view tests pass, including a publication-
outage regression; the additional retirement guard check also passes. Physical
identity and explicit quarantine checks remain in force.

## Matched deployment and live evidence

- Application image family: `review-r2-ordered-v3`; Control Plane after recovery
  corrections: `review-r2-recovery-v3` (`21b3f206`). Database schema 170. Native
  Cube patch/completion identities above remain unchanged. Guest source:
  `24bc31718964bea54eac600c1a42335ae7d20be6`.
- [Native tools](review-r2-native-tools-20261004.json): three Luna Turns and 13
  successful read/write/edit/Bash calls, including large output and symlink edits.
- [Pod replacement](review-r2-handoff-restart-20261004.json): original Worker
  survives, native command finishes, exact file contents prove one execution.
- [Direct process SIGKILL](review-r2-process-restart-20261004.json): confirmed
  exit 137 and increased container restart count; original Worker/native command
  completes exactly once. The preceding in-container PID-1 signal attempt did
  not restart the process and was correctly rejected by the gate.
- [Execution probes](review-r2-execution-probes-20261004.json): no VM for chat,
  Projector/Cube/Worker stages confirmed during silent Bash, no probe history,
  replaced boot refused, paused VM not awakened by probing.
- [Shared VM cancellation](review-r2-shared-vm-cancel-20261004.json): two bindings
  on one physical VM; cancellation settles in 547 ms in this sample, both parent
  and child stop, the sibling completes and the command executes once. This is
  a single-host sample, not a latency guarantee.
- [Starter image queue](review-r2-queued-image-20261004.json) and
  [standard image queue](review-r2-queued-image-standard-20261004.json): image-only
  admission, editing with attachment retention, promotion to steer, exactly one
  input consumption and direct Luna vision without a read Tool.

The first [standard-profile image attempt](review-r2-queued-image-standard-initial-20261004.json)
failed before Tool admission. A direct Cube call reproduced HTTP 500 with
`reset guest time failed` on that template. Recreating the standard template from
the same immutable image produced `tpl-091587931471433489c921ba`; a real VM boot
and the full standard image-queue scenario then passed. Only the generated
standard-template selection changed. This does not establish the upstream
snapshot/time-reset root cause or remove deferred old-template cleanup.

The upload gate now stops immediately if its prerequisite Run terminates before
any running Tool, and accepts an explicit fixture profile (starter by default).
The shared-VM cancellation script is retained as a reusable acceptance gate.

Final state: Control Plane and both Workers Ready; no active Runs, leases or Tool
bindings; Cube inventory empty. The original 21 image-object identities/hashes
match the pre-rollout digest. Owned test PG/Kafka containers and private rendered
Secret/diagnostic files were removed. Cleanup requests for live fixtures completed;
one failed standard-VM creation still has an unknown allocation with no recorded
VM/node identity, alongside the pre-existing unknown allocation. They remain
held rather than forcing absence or quota release. The two identifiable direct
Cube probes have independently confirmed absence on the recorded node. Deferred
old-template GC and the failed-allocation identity gap remain explicit backlog work.
