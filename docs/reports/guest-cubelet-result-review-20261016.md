# Guest → Cubelet result review

Date: 2026-10-16. Baseline `06559532`; maintained release
`guest-execution-5536fc73`, guest protocol 6. This is a completed source/isolated
review, with no runtime change or deployment.

## Scope and assessment

Reviewed fixed guest result generation, progress/final framing, native raw PTY
receipt, process exit/output draining and the decision to deliver a result or
clean its operation scope. Inspected the completion adapter only to establish
the downstream consequence; Kafka publication/Worker consumption is the next hop.
Sources include the exact pinned Cube commit and all eight verified patches,
containerd 2.2.2 I/O, and the current guest/transport contracts.

Version correction from release verification: the 2.2.2 I/O source was inspected,
but patch 0005 resolved the built dependency to 2.2.5. The approved repair's
release now pins 2.2.7 for a scan finding and repeats the execution contracts;
see its [delivery record](tool-receipt-preview-repair-20261016.md).

The split remains reasonable: guest Tools produce results, Cubelet owns accepted
native process lifetimes, and Worker Pi processing owns canonical conversation
results. This review does not justify a new service, queue, per-Tool PG lookup,
result ledger or automatic shell replay. Two local boundary problems are confirmed.

Original probes are archived in Git
`b3890979:scripts/experiments/review-20261016-guest-result/`; the approved
[repair](tool-receipt-preview-repair-20261016.md) replaces them with maintained
regressions. The [machine-readable evidence](guest-cubelet-result-review-20261016.json) separates
actual guest/PTY behavior from substituted native process services. Passing these
characterization probes reproduces the defects; it does not mean they are fixed.

## R16R-01 · P2 · Receipt loss turns a completed Tool into scope cleanup

The guest Tool writes a successful final frame with `scopeStopRequired:false`.
After its child exits, the launcher completes local cgroup bookkeeping, then
waits up to five seconds for `scope.received`. If that reverse-direction receipt
is missing, its catch handler writes `cube_execution_scope_failed` to stderr and
sets exit code 1. Stderr shares the native PTY, so this plain text also reaches
the JSON output parser.

Cubelet may already hold the complete, successful result. Nevertheless the new
non-JSON line marks the output invalid; nonzero launcher exit independently
triggers the same cleanup branch. The driver invokes `stopGroup`, discards the
retained result and reports failure. The completion adapter maps that failure
to an UNKNOWN execution outcome.

Example: Bash launches a development server, exits successfully and returns its
URL. The forward result reaches Cubelet, but the reverse receipt is lost or delayed
past its deadline. This code can then kill the server in that operation's cgroup,
even though the Tool finished and requested no scope stop. This is an
**operation-cgroup cleanup**, not direct destruction of the shared VM. If cleanup
itself cannot be confirmed, the existing quarantine path remains a separate concern.

Evidence:

- The actual launcher and actual guest Tool run through a real local PTY, with
  only privilege switching and cgroup calls substituted. Both receipt cases emit
  a successful final result and complete local-finish bookkeeping. Delivering the
  receipt yields exit 0; withholding it yields exit 1 after five seconds and the
  plain error line. No user cancellation or execution timeout is injected.
- The actual patched driver/parser and actual containerd FIFO I/O consume those
  captured frames with fake process/task services. Normal receipt retains the
  result and makes zero cleanup calls. Receipt loss produces `tool_output_invalid`,
  drops the result and makes one operation cleanup call. This proves the decision;
  it is not a live VM/background-process destruction test.

Sources: [launcher receipt wait](../../packages/tool-sandbox/src/cube-tool-scope.ts:154),
[launcher failure](../../packages/tool-sandbox/src/cube-tool-scope.ts:174),
[native cleanup/classification](../../deploy/cubesandbox/patches/0003-native-tool-execution.patch:5388).
The composed `Cubelet/pkg/execution/containerd.go` lines 246–270 retain this branch.

Repair direction: distinguish Tool completion, local execution-scope settlement
and transport receipt failure. Give the host an unambiguous way to identify
“local execution/settlement completed, receipt alone failed”; when the host also
has the complete valid result, receipt loss alone must not request scope killing.
Keep the existing bounded receipt because it prevents process reaping from racing
unread output. Do not accept arbitrary nonzero exits as success, ignore malformed
frames indiscriminately, or trust a result when local settlement is unconfirmed.
Missing output, ambiguous execution and genuine cleanup failure remain UNKNOWN.
Changing that termination contract requires an ADR before implementation.

## R16R-02 · P2 · Truncated Bash progress exceeds the native forwarding limit

`NativeToolOutput.snapshot()` places the visible text in `content` and, after
truncation, also in `details.truncation.content`. `envd-tool-exec` serializes this
whole snapshot plus the original Tool arguments. Cubelet forwards progress only
when the serialized frame is at most 64 KiB. The completion adapter's later
8,192-character preview trim cannot help a frame already discarded by Cubelet.

The real guest probe prints 60 KiB of synthetic text and then waits long enough
for a progress tick. The retained visible text is 51,200 bytes; the duplicated
truncation text is another 51,200 bytes. The actual frame is 102,913 bytes and the
maintained native parser forwards zero updates. The small control case is 1,301
bytes and forwards one. Both final results succeed.

For a long build/test command, the browser can therefore stop receiving useful
output precisely when logs become numerous, even with healthy transport. This is
deterministic frame-size rejection, separate from intentional best-effort dropping
under load. Large arguments or JSON escaping can also consume the frame budget;
the proposed bound should apply after encoding, not only to source character count.

Sources: [snapshot duplication](../../packages/tool-sandbox/src/native-tool-output.ts:49),
[full progress serialization](../../packages/tool-sandbox/src/envd-tool-exec.ts:58),
[native size gate](../../deploy/cubesandbox/patches/0003-native-tool-execution.patch:5254),
[late preview trimming](../../packages/cube-completion/src/adapter.ts:103).

Repair direction: create the bounded observation payload at the guest transport
boundary. Carry only the identity, revision and preview needed downstream; omit
repeated Tool arguments and native truncation bodies from this preview. Bound
its encoded bytes before writing. Preserve the full final Tool result and native
metadata policy. Observations remain lossy HTTP/SSE and never enter Kafka/PG or
model context; no second durable stream is needed.

## Checked boundaries and accepted limits

- Split final frames are assembled before receipt. Oversized and duplicate
  final frames fail; the immutable result buffer is not reused for later progress.
- Native output copies are drained before result classification; containerd
  `cio.Wait()` joins output copies, not the independent stdin copier. No stdin
  join deadlock was established.
- Progress adapter writes have nonblocking admission and a bounded write budget;
  this review establishes frame-size loss, not an unbounded HTTP wait.
- Ordinary Tool failure, native abort, timeout and infrastructure uncertainty
  have distinct paths. No automatic command replay is added by reply delivery.
- `scope.received` confirms bytes at Cubelet, not Kafka persistence or canonical
  Pi settlement. Cubelet/node loss before durable reply delivery can lose the
  volatile result. ADR-0210 explicitly accepts UNKNOWN for that boundary. It is
  separate from R16R-01, where the same host has already received the complete
  result and the missing reverse receipt unnecessarily changes the effect policy.
- The reviewed return hop needs no database query, guest Kafka credentials,
  additional callback server or guest Agent Loop.

## Verification and limits

- Existing targeted TypeScript suites: six files, 75 passing tests covering guest
  execution/cancellation, native Tools/output truncation and completion frames/adapter.
- The complete original patched Cubelet execution package passes with the Go race
  detector before the review probes are installed.
- Two additional native probe families pass with the race detector, including
  normal/lost-receipt controls and actual small/large guest progress frames.
- The reproducible runner verifies patch/source identities, records its toolchain
  and removes its temporary native checkout and synthetic fixtures. An initial
  probe filename shadowed Python's standard `pty` module; that fixture error was
  corrected before the reported characterization run and is not a runtime defect.
- No model request, live VM/link failure, production data mutation, runtime source
  fix or deployment was performed. The review makes no fleet-capacity or live
  process-destruction claim.

Prioritize R16R-01's completion/cleanup boundary, then R16R-02's source-side preview
bound. Keep the present component ownership and discuss any protocol change before
implementation.
