# Cubelet → guest Tool execution review

Date: 2026-10-15. Baseline `c3837bdb`; serving release `handoff-6ab91bb7`.
This is a completed review, not a runtime change or deployment. Evidence:
[isolated measurements](cubelet-guest-execution-review-20261015.json) and
[reproduction instructions](../../scripts/experiments/review-20261015-guest/README.md).

## Scope and assessment

Reviewed accepted Cube operations through native containerd task resolution,
Exec/Start/Wait, the raw terminal request/cancel/result-receipt channel, the guest
scope launcher, fixed Tool attachment, Bash/read/edit/write execution, bounded
output, cancellation, timeout and process cleanup. Compared the exact patched
Cube revision `8721dd151971ce3c2966482bbd32904ad98f378e`, containerd 2.2.2, and
installed Pi Durable 1.0.0 public Tool/Node environment implementation.
Kafka completion delivery remains the next reading hop, inspected here only to
establish the consequence of a driver that never returns.

The ownership split remains reasonable: Cubelet owns accepted operation lifetimes,
the guest runs fixed Tool bodies, and the Worker retains Pi Harness/model execution.
Operation identity, native process handles, separate ordinary cancellation and
fault cleanup, and data-source output bounds are useful boundaries. No replacement
broker, scheduler, per-Tool PG lease check or guest Agent Loop is justified by this
review. The confirmed issues are local adapter behavior and native path parity.

## Findings

### R15G-01 · P2 · The final cleanup Kill loses its deadline

`ContainerdDriver.stopGroup` gives its guest cleanup helper an eight-second budget.
When that budget expires, it calls
`p.Kill(context.WithoutCancel(ctx), SIGKILL)` synchronously. This removes both
cancellation and the deadline, without adding a new cleanup budget.

If the native task/shim path stalls during that call, the supposedly bounded
cleanup cannot return UNKNOWN. `Manager.execute` remains inside the driver, before
final reply delivery and active-operation release. Repeated occurrences can retain
execution capacity. The reviewed containerd Process/Task services forward the
supplied context; they do not install a replacement Kill deadline. CubeShim also
awaits sandbox/container locks, so a lower-level operation is not a substitute for
the caller's bound.

The isolated driver probe starts with a 20 ms parent deadline and stalls only the
fake native Kill RPC. The received Kill context has no deadline. Cleanup remains
blocked for another 80 ms and finishes only when the fixture releases the RPC.
This establishes a missing bound; it is not a claim of a reproduced live VM hang
or a measured fleet-capacity outage.

Source: [maintained native patch](../../deploy/cubesandbox/patches/0003-native-tool-execution.patch),
`Cubelet/pkg/execution/containerd.go:271–313` after patch application; the bare
`WithoutCancel` Kill is at patch line 5458.

Repair direction: use an independent, short, bounded cleanup context while
retaining the native namespace. A lost Kill response must end with the existing
unconfirmed/unsafe outcome and Control Plane recovery ownership. It cannot prove
physical stopping, release quota, replay the Tool or directly destroy a shared VM.
Test stalled Kill, late replies and cleanup failure without changing normal Stop's
process-group boundary.

### R15G-02 · P2 · Read bypasses Pi's path normalization

The custom bounded/image-capable Read calls `env.absolutePath(path)` directly.
Pi's native Read first uses its Tool path normalization and existing-name variants:
leading `@`, Unicode spaces, decomposed Unicode names and curly apostrophes.
Cloud Edit/Write already use native Tool implementations that retain this handling.

Five isolated comparisons against the actual pinned SDK reproduce the gap:

| Input | Native Pi | Current cloud Read |
| --- | --- | --- |
| `@sample.txt`, with `sample.txt` present | Reads it | File error |
| Non-breaking space in a path whose file has an ordinary space | Reads it | File error |
| Composed spelling of a decomposed Unicode filename | Reads it | File error |
| Ordinary apostrophe when the filename contains a curly apostrophe | Reads it | File error |
| `@target.txt`, with both literal and normalized names present | Reads `target.txt` | Reads the different literal `@target.txt` |

Cloud `write("@created.txt", ...)` followed by cloud `read("@created.txt")` also
reproduces a successful write followed by a failed read of the same Tool path.

Source: [guest native-tools](../../packages/tool-sandbox/src/native-tools.ts),
absolute-path construction at line 110 and the custom Read branch at lines 186–239.
The comparison implementation is the installed pinned SDK's `tools/path-utils.js`
and `tools/read.js`; the path helper is not exported through its public Tools port.

Repair direction: align the guest's path interpretation and subsequent path checks,
with contracts against public native Read/Write/Edit behavior. Preserve bounded
streamed text reads, image support and existing file guards. Do not deep-import
Pi private modules, patch its loop, or retain two version-dependent path modes.
Keep the ambiguous-name case in the upgrade tests so a successful read of the
wrong file cannot pass unnoticed.

### O15G-01 · Low priority · Ordinary Tools carry unused initialization data

`#attachedInitialization` sends a complete environment snapshot, recipe and a
hard-coded `workspaceSeed: {kind:"sample_java"}` for every ordinary Tool. Guest
operation mode parses that initializer but `attachToolExecution` consumes only
the selected root and network configuration; activation identity is checked by
the envelope. Environment validation and actual seeding belong to VM preparation.
The placeholder does not mean every command recreates a Java project.

A schema-valid default fixture has a 747-byte initializer. The fields actually
consumed by operation mode occupy 128 bytes. This is a field-selection measurement,
not the size of a proposed complete protocol or a measured latency improvement.

Sources: [descriptor construction](../../packages/sandbox-control/src/cubesandbox-sandbox-provider.ts)
at line 746, [dispatch payload](../../packages/sandbox-control/src/tool-command-dispatcher.ts)
at line 180, [guest attachment](../../packages/tool-sandbox/src/tool-worker.ts)
at line 853, and [input envelope](../../packages/tool-sandbox/src/envd-tool-exec.ts).

Repair direction: distinguish full environment initialization from the small
attachment parameters needed to execute one Tool. Keep full preflight validation
at activation/adoption and operation identity/root/network checks at execution.
This changes a guest protocol/descriptor, so record an ADR and perform a matched
upgrade before removing the old shape. It needs no additional cache or authority.

### O15G-02 · Low priority · Expired setup can still start a fixed launcher

The driver detaches preparation and Start from the execution context. If the
original budget expires during Spec/Exec/Wait setup, Start still receives a fresh
ten-second context; the original context is checked only afterwards. An isolated
probe confirms one launcher Start with an uncancelled Start context after the
parent has expired.

The input channel separately observes parent cancellation, so this probe does
**not** demonstrate that user Bash or file actions execute after expiry. The
confirmed behavior is needless fixed-process startup followed by failure cleanup.
Before issuing Start, recheck the execution budget; when no Start was sent, retain
that evidence and clean the unstarted native handle within a bounded budget.
Do not infer non-execution when a Start RPC was issued but its reply was lost.

## Preserved choices and checked non-findings

- Ordinary cancellation still targets the unfinished Tool's process group;
  `setsid` descendants and completed background launches have separate semantics.
  Timeout/infrastructure cleanup is deliberately stronger and operation-scoped.
- Native terminal readiness prevents request echo/transformation. The final
  receipt confirms that Cubelet received the complete frame, not that Kafka or
  the Worker committed a canonical result.
- Progress delivery uses a nonblocking writer admission and a bounded write;
  this review did not establish an unbounded observation-HTTP wait in the driver.
- Containerd's `cio.Wait()` joins output copies, not its stdin-copy goroutine;
  the apparent deferred input-close deadlock is not a confirmed finding.
- A structured guest `worker.failed` does not automatically set a nonzero process
  exit code. It can reach the completion adapter; it is not invariably discarded
  by the driver's exit-code check.
- Pi's full Bash-output spill differs from the cloud policy intentionally:
  [ADR-0168](../adr/0168-direct-workspace-storage.md) explicitly retains bounded
  results and permits explicit redirection to Workspace files instead of a raw
  output archive. Shared-Workspace file concurrency remains user-managed under
  ADR-0130. Neither is relabeled here as an accidental alignment failure.

## Verification and limits

- Existing Tool Sandbox suite: eight files, 70 passing tests, including native
  edit/read contracts, cancellation, working-directory loss and output bounds.
- Maintained native admission suite: passes with the race detector.
- Complete patched Cubelet `pkg/execution` baseline: passes with the race detector;
  the reproduction runner excludes its two review probes from that baseline run.
- Two additional driver fault probes, five native/cloud Read comparisons and the
  cloud Write/Read inconsistency reproduce the observations above. Review probes
  assert the existing defects, so their success does not mean those defects are fixed.
- Go reproduction uses 1.26.0 and exact pinned Cube/containerd source; release
  compilation uses its separately pinned toolchain. No live VM/link failure,
  model request, production data mutation, runtime patch or deployment was performed.

Prefer repairing R15G-01 and R15G-02 first. O15G-02 can join the same bounded
driver-lifecycle change; O15G-01 is a small, explicit protocol simplification.
The source mechanisms and current architecture can be retained.
