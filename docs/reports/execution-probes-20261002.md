# Execution-path and physical-runtime probe acceptance — 2026-10-02

Status: deployed; focused real Luna, VM, browser and control-plane replacement
acceptance passed. Decision: [ADR-0211](../adr/0211-execution-path-and-runtime-probes.md).
Implementation: `e6240f4b`; native namespace repair: `e442fed1`.
Deployment evidence corrections: `27acf05e`, `f781e585`.
Browser harness corrections/focused gate: `04731518`, `df564a97`.

## Resulting behavior

A physical Session shares one publication probe across its Lanes. Projector
arrival confirms the log path immediately. Activated bindings may continue to
the fixed guest echo and return through the original Worker's Kafka mailbox.
Bindings sharing a VM use one echo and one measured round trip. Each Run keeps
its own return-path evidence; valid physical VM evidence can be shared.

The controller's separate due-time pump reuses recent guest evidence and probes
idle VMs directly. It covers all due targets with bounded concurrency instead of
truncating each pass to 16. A bounded inventory supplies positive lifecycle
observations; omissions require exact-node checks. Paused VMs are not woken.
Neither probe failure nor a missing list item can release quota or replay a Tool.

Probe messages never become Pi entries, model context, Tool Results, PG health
samples or execution authority. Projector/Cube/Worker stages describe the last
confirmed position and a suspected interval, not a conclusively failed component.

## Real acceptance

| Check | Evidence |
| --- | --- |
| Pure chat and complete guest round trip | [Luna probe gate](execution-probes-live-20261002.json): chat allocates no VM; a full probe returns while a real Bash is still running; Projector, Cube and Worker stages observed. No probe payload appears in native history. |
| Independent direct probing | Same gate: direct guest response in 82.3 ms in this sample; old executor boot rejected; direct response succeeds with an undeliverable fixture Kafka reply destination; paused VM is not resumed by probing. |
| Native Tools | [Three coding Turns](execution-probes-native-tools-20261002.json): write/read/edit/Bash, large-output bounds and guest symlink behavior pass on GPT-6 Luna. |
| Control Plane loss | [Owned process-fault gate](execution-probes-handoff-restart-20261002.json): SIGKILL/start during Bash, same Run/Worker completes, start/end effects occur exactly once, and fixture cleanup completes. |
| Browser | [Focused browser gate](execution-probes-browser-20261002.json): GPT-6 Luna selected before spending tokens; the real page displays fresh message-path and sandbox-round-trip times while Bash is running; completion and cleanup pass. |

These are single-host functional observations. The 82.3 ms sample is not a
latency SLO or a multi-node availability claim. The undeliverable reply test
targets an owned nonexistent reply topic; it does not stop shared Kafka brokers.
Direct probing without completion readiness is additionally covered at the
Cubelet service boundary.

## Repository and native contracts

- 1,532 workspace tests and 66 acceptance-helper tests passed using an isolated
  PostgreSQL instance. The initial PGlite queue socket failure was rerun: 25/25
  queue tests and then the whole real-PG repetition passed. Integration opt-outs
  are not counted as passed coverage.
- [All 116 named fault cases](execution-probes-faults-20261002.json) passed,
  including seven new probe and health cases. A 160-target fixture verifies full
  scheduling coverage and bounded concurrency; it does not simulate 160 real VMs.
- Go execution tests and race checks, the direct-probe service contract,
  CubeMaster forwarding and CubeAPI forwarding passed. A new regression test
  reproduces the missing process-start namespace before its repair and passes
  afterward for both Tools and probes.
- Typechecks, application/Cube builds, template contracts, browser presentation,
  documentation, installation/Helm, runtime policy, observability and dependency
  closure checks passed. The security gate retains two existing moderate findings
  and no unwaived high/critical finding.

The broad upstream Cube test suites are not clean: unrelated NUMA/probe fixtures
fail, and the Redis proxy nil-pointer also reproduces at the unchanged Cube patch
baseline. No unrelated test was weakened. The broad browser script initially
stopped at stale model-menu assumptions: selecting a model still needs a thinking
choice, and Sol's catalog default is low rather than medium. The paid-Luna
precondition and workspace cleanup key were corrected; the executed browser
acceptance here is explicitly the focused probe mode, not a claimed full UI pass.

## Repairs found during rollout

The existing host's K3s restart loop came from a missing `picloud0` interface and
missing PiCloud startup helper/drop-in. Restoring the canonical files already
defined by the self-hosted installer restored Cube. Exact observation correctly
reported unavailable before this repair and positively reported the old VM
stopped afterward.

The first real Tool run caught a regression in this change: the native process
start context had been captured before the containerd namespace was installed.
The repair preserves both the resolved namespace and the probe deadline. The
final Cubelet uses the freshly built corrected native binaries/version manifest
with the already verified, unchanged protocol-2 completion adapter and native
dependencies. Its deployed digest is
`sha256:d128f7d1649f798accddd731baf97c3471b1e9c4d8fa60e29f37db5afa9e93e7`.
The pinned patch set contains the full correction for clean builds; no legacy
execution fallback is installed. Guest image revision is
`e661c7d9d5798d4ef1f0761df29594163cb6da13`.

## Asset preservation and maintenance correction

Private PG and Workspace backups preceded maintenance. The stopped development
VM was explicitly retired, with exact-node absence confirmed. Its environment ID
and Workspace Volume were retained for generation 5.

The initial maintenance procedure incorrectly assumed that a requested resource
would be automatically provisioned. The existing reconciler instead abandoned
the unissued request and marked its Workspace/project deleted. Cleanup was
stopped, the deletion grant revoked, and those metadata changes reverted before
storage purge. Every original backed-up file still matched byte-for-byte. The
actual provision endpoint then restored generation 5 to running, including
successful adoption across the later Control Plane restart. Product lifecycle
policy was not weakened to accommodate the maintenance mistake.

After owned fixture cleanup, all **174 original native rows** match their initial
whole-row ordered JSONB digest:
`d474112ed2bfd627b489ec2227555be0`. The original Workspace/project deletion fields
are clear, the development machine is running, and no active Run, Tool binding or
elastic fixture remains. Heartbeat failure still has no power to delete a user's
machine automatically.

Old template cleanup remains an existing operational limit: this rollout deferred
23 candidates after Cube node cleanup deadlines. New templates were confirmed
READY; deletion guards were retained.
