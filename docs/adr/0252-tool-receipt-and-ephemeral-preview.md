# ADR-0252: Tool receipt outcomes and incremental, terminal-aware previews

Status: proposed, 2026-10-16. The owner requested this repair plan following the
[guest → Cubelet review](../reports/guest-cubelet-result-review-20261016.md) and
the discussion of bandwidth, progress bars and final Tool results. This document
does not authorize treating the proposal as implemented or deployed.

## Behavior and boundaries

- A reverse receipt failure alone must not discard an already-received valid
  result or stop a completed operation's background processes.
- Ordinary log growth transfers new preview text. A progress bar updates the
  existing text instead of concatenating every percentage.
- Browser previews remain disposable observations over native guest I/O, the
  host adapter, HTTP and SSE. They are never Kafka/PG history, model context,
  Run activity authority or evidence authorizing VM destruction.
- Guest `NativeToolOutput` retains the bounded final output independently. The
  guest builds the final Tool reply; Cubelet delivers it through the boot-scoped
  Kafka reply topic; Worker Pi hooks/settlement create the canonical Tool Result.
  Preview loss, parser failure, congestion or browser absence cannot change this
  result, delay its delivery or cause shell replay.
- Native execution, cancellation, Session fencing, VM lifecycle and Workspace
  ownership stay with their existing components. Add no service, queue, PG table,
  result archive, per-Tool lease read or guest Harness.

## 1. Separate local completion from receipt transport

Keep the raw-PTY ready/receipt mechanism: it prevents native process reaping from
racing unread output. Replace the launcher's ambiguous receipt-failure exit with
a reserved, named outcome, provisionally exit code 76 (`SCOPE_RECEIPT_UNCONFIRMED`).
It is assigned only by the fixed launcher after its mode's local work succeeded:

- `run`: the child exited successfully and `finishExecutionCgroup` completed.
  This bookkeeping deliberately permits completed background processes; it is
  not a claim that the operation cgroup is empty.
- `stop`: stopping produced the actual `empty:true` proof.
- `probe`: the fixed probe produced its valid observation.

Only timeout/closure/failure of the final reverse receipt is eligible for that
outcome. Normalize other child failures to the ordinary failure path so a child
exit code cannot impersonate this launcher outcome. Wrong-operation controls,
malformed controls, failed local bookkeeping and uncertain execution are not
receipt-only failures. Do not write a plain error after the final JSON frame for
this expected receipt-only case; host diagnostics record its bounded reason.

Cubelet checks the complete, unique, valid frame and the native exit/settlement
outcome together. A receipt-only exit is acceptable only with the corresponding
complete result/proof. An arbitrary nonzero exit or a partial result is never
accepted as success. `scopeStopRequired:true` still requires the existing scoped
cleanup; a normal Tool error still does not justify whole-VM deletion.

The native Tool-run path also distinguishes execution time from bounded post-result
settlement. When a complete final frame is observed before the execution deadline,
join the launcher with a separate short settlement budget that covers the existing
five-second receipt wait (initial target: seven seconds). Do not let a random
`select` winner between result arrival and deadline expiration discard already
observed completion. If execution expired before that transition, or launcher
settlement cannot be confirmed, retain UNKNOWN and the existing bounded cleanup.
Stop still aborts Pi immediately; late physical replies cannot replace native abort.
Probe and stop-helper budgets retain their existing separate bounds; the Tool-run
settlement grace is not a blanket extension of health probes or cleanup deadlines.

| Evidence at Cubelet | Decision |
| --- | --- |
| Complete valid final + normal or receipt-only settled exit + no scope stop requested | Deliver the result; preserve completed background work. |
| Complete final explicitly requesting timeout/fault cleanup | Perform existing bounded operation cleanup before classification. |
| Missing/invalid/duplicate final, ordinary failed exit or unconfirmed local settlement | Retain failure/UNKNOWN; preserve existing scoped cleanup and quarantine policy. |
| Valid stop result with `empty:true` + receipt-only settled exit | Retain the actual stopping proof; receipt loss alone is not failed stopping. |

No receipt gains Kafka-durability meaning, and no new durable process-status
record is introduced. Cubelet/node loss before durable delivery remains the
existing UNKNOWN boundary, without automatic command replay.

## 2. Interpret terminal output at the source

The current guest strips carriage return and serializes native snapshot metadata
as preview data. Replace only that preview branch. Feed the decoded stdout/stderr
stream, in observed arrival order and before carriage-return stripping, into a
PiCloud-owned read-only preview adapter backed by pinned `@xterm/headless@6.0.0`.
The [adoption study](../research/tool-preview-rendering-20261016.md) records its
license, published entry-point issue, isolated parser/bundling results and limits.

The parser maintains a small terminal view; it interprets carriage return,
backspace, erase-line and cursor movement, including sequences split across
chunks. Extract plain text through the public buffer API, redact it, then form
preview updates. The browser continues rendering escaped text, rather than raw
ANSI, HTML, terminal callbacks or clipboard operations. Color reproduction and
interactive/full-screen applications are outside this repair's acceptance.

Use one fixed geometry for the shared preview (initial target 120 columns ×
24 rows, with 100 scrollback rows), rather than changing the source view for each
browser width. Cap exported preview text at 8 KiB of UTF-8 on valid boundaries.
These are preview transport/resource bounds, not product quotas or final Tool
output limits. The existing final-output collector and its result policy remain.

Do not change Bash from pipes to a PTY for this feature. Programs that suppress
progress when attached to pipes may continue doing so; the feature correctly
displays the control sequences a command actually emits, rather than forcing
commands to generate progress bars.

The library's asynchronous `write` callback must complete before reading its
buffer. Keep application-owned pending parser bytes bounded (initial ceiling
256 KiB; feed at most one bounded chunk at a time), rather than relying on the
library's much larger emergency watermark. Parsing must not pause the Bash pipe
or accumulate output indefinitely. If the preview parser falls behind or fails,
mark that preview unavailable, stop feeding it and retire it after bounded pending
work; continue collecting the final Tool output. Do not resume from an arbitrary
raw ANSI tail and claim an accurate terminal state after skipped bytes.

## 3. Send changes, with small self-contained resets

Define a PiCloud preview schema, separate from native Tool events. Keep operation
and Tool identity, revision and the minimum routing fields. Remove Tool arguments,
duplicated `details.truncation.content` and other native result metadata from
observations. Validate the encoded full envelope against the existing 64 KiB
transport ceilings, not only the pre-encoding character count.

Two update forms suffice:

- `reset`: a complete current bounded preview and its revision. Send the first
  preview this way, then a low-frequency reset while that Tool has a preview
  (initial cadence five seconds, including quiet periods to permit reconnect).
- `delta`: a base revision, new revision and a bounded text edit. Support dropping
  an old head, retaining a prefix of the remainder, and replacing the suffix.
  Ordinary output appends; a progress bar replaces the changed tail; scrolling
  drops the old head. Define counts in Unicode code points and enforce UTF-8
  byte budgets separately. If a patch is no smaller than a reset, send the reset.

This is a small display edit, not a general document merge engine. Each operation
has one source and no concurrent browser edits. Never send a zero-change delta.
Retain the current at-most-once-per-second ordinary preview cadence, coalescing
small changes; terminal timers/callbacks do not create new model-visible events.

Use the existing path:

```text
guest preview → native Cubelet I/O → host completion adapter
  → HTTP /internal/v1/tool-progress → Control Plane → SSE tool.progress → browser
```

All lossy boundaries must understand the new semantics. The current “keep the
newest message” rule is safe for snapshots and unsafe for deltas:

- At a pending sender/subscription, apply consecutive edits to one bounded view
  and coalesce from the last sent base. Do not overwrite a pending delta with
  another unrelated delta. When composition would exceed the byte/work budget,
  replace pending work with a bounded reset of the known current view.
- Ignore duplicates and stale revisions. If a base revision is missing, do not
  append onto the wrong text; mark the view unsynchronized and await a newer reset.
  A new source reset supersedes pending deltas based on older views.
- Cubelet's best-effort progress write may still drop a frame. Adapter restart,
  HTTP failure, partition-owner replacement, SSE backpressure and browser reconnect
  may also lose observations. Periodic source resets permit convergence when
  delivery resumes; they are not a guaranteed delivery deadline or replay service.
- Where an existing HTTP sender knows its route/connection outcome became
  uncertain, its next send may use a reset from its bounded known view. No new
  resynchronization RPC, durable ACK or consumer offset is introduced.
- Keep views only for active operations and existing active subscribers, with
  explicit byte/count bounds and cleanup on completion/Stop/disconnect. Control
  Plane does not retain per-viewer output histories or query PG per update.
- Formal Tool/Run completion still wins over queued or late observations. Guest
  final output does not wait for browser display, reset delivery or preview ACKs.
  At Tool completion, stop preview timers, discard unsent/coalesced updates and
  dispose parser resources without awaiting another rendering callback. A frame
  already being written must finish within the existing bounded I/O path before
  the final frame; never interrupt it halfway and corrupt framing. Verify that
  preview callbacks/handles cannot keep an otherwise completed guest alive.

## 4. Matched protocol change and removal

Proposed cutover: guest/Tool Worker protocol 6 → 7; trusted Cubelet/completion
adapter startup protocol 2 → 3; a versioned replacement for internal HTTP/SSE
preview bodies. Retain management HTTP schema 7, descriptor 2, PG schema 189,
Session topic v17 and Worker reply v3 unless implementation reveals an actual
change to those contracts. Native patch/source identities still require matching
Cubelet artifacts; management schema equality alone never authorizes a mixed set.

Remove the old full-native-event progress body and its snapshot-only forwarding
path after cutover, without compatibility decoding. Keep native final Tool events
and history formats intact. Drain writers and accepted operations, confirm the
required physical cleanup, then replace guest, native executor, adapter, Control
Plane and web artifacts through the maintained matched release. Preserve accounts,
provider/model settings and credentials. No business-history migration or reset is
needed for a disposable preview protocol. Rollback requires a drained, matched set.

## Acceptance and implementation order

1. **Completion boundary:** convert the receipt-loss characterization into
   regression tests. Cover normal/lost/delayed receipt, final/deadline races,
   child/local-bookkeeping failures, partial/duplicate frames, stop-helper receipts
   and required timeout cleanup. A completed background server and a sibling
   operation in the same VM must survive receipt-only failure. Missing proof
   remains UNKNOWN; normal Stop and native abort settlement do not regress.
2. **Source preview:** contract-test the pinned parser using actual guest stdout/
   stderr, CR, CRLF, backspace, clear-line, split ANSI, multi-line redraw, Chinese,
   emoji and a shrinking progress label. Verify redaction before publication and
   encoded byte bounds. Measure incremental bundle/CPU/memory cost; flood output
   must retire only the preview, preserve final output and stay bounded.
3. **End-to-end observations:** cover delta coalescing, head trim, suffix overwrite,
   duplicate/out-of-order/missing updates, parser/adapter restart, HTTP owner change,
   slow SSE, reconnect during silence and completion overtaking pending previews.
   Compare displayed text to the latest source reset. Measure wire bytes at both
   guest→Cubelet and HTTP/SSE; ordinary append must not resend the retained 50 KiB.
   Verify no preview enters Kafka/PG, Pi Storage or model context.
4. **Matched acceptance:** run required source/native/race/transport/fault gates,
   scanned release and real GPT-6 Luna/Cube/browser checks. Inject a receipt-only
   failure around a completed background launch, exercise ordinary Stop and
   Worker's recovery, and confirm preserved configuration and fixture cleanup.

Implement these slices in order, finishing one before the next. Source protocol
changes are deployed together after complete acceptance. The source preview
contract, not a vendor terminal object, is exposed to the rest of PiCloud.
