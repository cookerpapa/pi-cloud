# October 4 follow-up review repairs

Status: implementation and automated checks complete. Matched Cube release 22
is installed; guest-template/application cutover and live acceptance are in
progress. No production data reset.

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

The repaired runtime source is committed at `98379564`; build proxy forwarding
is `3b991061`. The fault report was started on the working tree before these
commits, and explicitly records that fact rather than claiming a clean baseline.

- Full `npm run check`: 1,699 passing tests in 251 files, nine explicitly skipped
  external-runtime cases. Type checking passes across all workspaces. Separate
  real Kafka integrations cover three of the external paths.
- [Fault evaluation](review-repair-faults-20261004.json): 150/150 selected contracts
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
