# Resource and interaction repair plan

Status: proposed, 2026-10-20. This document implements no runtime change.
Source baseline: `a89e97a2`; serving runtime: `model-runtime-058925bb`, schema 192.
Scope: the [16 review findings](resource-interaction-review-20261020.md), SAR-D1
recovery/discovery discussion, and the measured simplification/documentation items.

## Outcome and boundaries

Repair the existing architecture in six independently verifiable slices.
Protect live resource users first, stop repeated no-change control work next,
then finish child recovery, Volume reference recovery, attachments and connections.
The proposed child-recovery contract is recorded in
[ADR-0264](../adr/0264-subagent-recovery-and-discovery.md); it is not yet accepted
or deployed. Volume/reference and attachment-retention changes need their own
focused decisions before implementation.

Keep PG as control authority, native Pi as task/continuation authority, one
physical Session lease/writer, one Session Projector group, existing Cube
execution and persistent Volume ownership. Add no child Run queue, scheduler,
cross-boot raw-result store, per-Tool PG lease polling or second checkpoint head.
Model tools expose bounded business operations, not arbitrary control-plane or
database access. Approval functionality and independent long-lived Agent teams
remain outside this repair.

Same-boot Kafka reconnection retains its current mailbox progress. A new Worker
still uses a new boot mailbox: this plan does not turn its starting point into
the old Topic's latest offset. For an eligible child-control invocation, recover
its original logical operation and route a fresh response to the current owner.
Ordinary interrupted Bash and arbitrary scripts retain native unsafe semantics.
Do not change an already committed cancellation or other native terminal result.

There is no overall Agent or Subagent duration limit. Bounds on network
establishment, individual Tool execution, shutdown, buffers and result size are
different contracts. Where an operation has a persisted business deadline,
recovery must retain it rather than restart a fresh full budget.

## Native evidence and design choice

The pinned Pi Durable 1.0.0 is the existing adopted runtime, with an MIT-licensed
public SDK. Its official examples provide the relevant patterns:

- [Foreground example 22](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/test/examples/22-subagent-foreground.ts)
  declares a replay-safe delegation Tool, reuses a child by source Task identity,
  reuses the input request identity and waits for the original Submission.
- [Background example 23](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/test/examples/23-subagent-background.ts)
  keeps a durable name-to-Conversation directory, offers status/list/message/stop,
  and leaves the combined management Tool unsafe because repeated Stop can affect
  newer work. Its background reporters separately resume message/report delivery.

Adopt stable source identity and recoverable foreground waiting, plus a scoped
read-only discovery operation. Do not copy background survival semantics or the
foreground example's Tool-owned child relationship wholesale: PiCloud currently
uses generation ownership so a blocked delegation can return and let the parent
answer a supervisor question. Keep that behavior.

Cross-boot mailbox replay is a viable separate design, but would require result
application cursors, unresolved-result retention, new-owner routing and native
terminal deduplication. It cannot recover a response never published. This plan
uses existing child records and native outcomes instead. A new workflow engine
or generic operation ledger would duplicate authorities we already have.

## Slice 1 — Live compute ownership and admission

Addresses WVL-01, WVL-02, WVL-04, WVL-O1 and WVL-O2.
Primary files: `sandbox-controller.ts`, `workspace-runtime-state-repository.ts`,
the admission/deletion methods in `control-plane-store.ts`, and
`sandbox-provider.ts` / the Cube provider's obsolete policy initializer.

### Changes

- Define one consistent predicate for live users of physical compute: root and
  native-child bindings under the shared Session authority, active/materializing
  human terminals, and the applicable physical lifecycle owner. Follow the
  child's actual compute scope; do not infer it from the root Run's compute ID.
- Recheck admission versus retirement atomically at the existing PG boundary.
  A delayed memory/Kafka view is insufficient to authorize deletion.
- Make local recovery, warm admission and eviction resolve the same physical
  runtime object, including terminal-only holders. Reuse the existing controller
  identity/registry; never adopt an already held VM as a second warm object.
- Standardize Session/Workspace lock ordering across Run intake, terminal
  admission, deletion and rebind. Retain deletion/admission exclusion and
  bounded lock waits; removing a lock is not the fix.
- Combine compatible deletion occupancy reads under the same transaction/lock,
  preserving refusal reasons. Measure against the recorded 13-statement sample.
  Remove the unused `turnWallClockTimeoutMs` policy field and its initializer.

### Acceptance

Root work ending while a terminal or ephemeral native child remains active must
not select or destroy that VM. Repeated recovery causes zero duplicate adoptions;
warm-TTL and capacity eviction both respect holders. Closing the last holder
still permits ordinary idle retirement. Concurrent admission/deletion and rebind
must have a valid serial outcome without the reproduced lock inversion.

Convert the seven review characterizations into desired-behavior regressions.
Use real PG and a controlled provider first; then verify owned live terminal
and child compute survive the relevant cleanup intervals. Confirm unrelated
VMs and persistent Workspace bytes remain intact.

## Slice 2 — Subagent supervision and Tool-owned memory

Addresses SAR-01–04, SAR-O1 and the relevant SAR-N1 documentation.
Primary files: `subagent-controller.ts`, `control-tool-dispatcher.ts`,
`postgres-subagent-supervisor-channel.ts` and `worker-tool-runtime.ts`.

### Changes

- Emit a wake only for a committed change that can affect a pending operation.
  Re-reading an unchanged question/status must not dirty its own waiter.
  Keep recovery wakes, genuine state-change wakes and known retry/expiry timers;
  avoid replacing the self-wake loop with frequent polling.
- Read actionable pending questions separately from disposable progress.
  Choose a deterministic order for multiple questions and document it.
- Resolve native terminal child state before returning a blocked wait. Pending
  listing, reply and wait paths must consistently exclude or reject questions
  whose child has ended. Preserve historical information without reopening work.
- Scope workflow host-call deduplication/results to the owning live Tool
  invocation. Stop accepting new calls when it closes, join/cancel pending local
  work, then release completed results. Removing cache entries must not allow
  a late duplicate host call to execute again.
- After acknowledged child admission, use current-status reads instead of
  repeating creation-shaped checks. Retain first-admission/uncertain-delivery
  checks; measure the current seven-SQL sample and preserve event-driven waiting.

### Acceptance

The unchanged pending question reaches quiescence after initial processing:
no immediate self-wakes or repeated SQL without a change/deadline. New progress
cannot hide a pending decision. A cancelled/completed child cannot solicit a
new supervisor reply. A long Run with many completed workflows releases their
result objects while preserving same-live-call deduplication. Existing native
family, supervisor reply and cancellation tests must continue to pass.

## Slice 3 — Recover the original delegation and make children discoverable

Addresses SAR-D1 and the subsequent Pi comparison. Requires the public-API
prototype and ADR-0264 before production implementation.

### Intended behavior

For the same logical delegation, Worker replacement keeps the original child,
initial Submission, frozen configuration and result identity. A still-running
child is waited on; a completed child produces its original outcome again.
Model-created distinct delegations remain distinct: similar prompts are not an
idempotency key. An interrupted uncertain shell/script inside a child is still
handled by native unsafe recovery, not replayed by the delegation wrapper.

Add a bounded, paginated family list that works without a child ID. It returns
child execution ID, source-call identity, parent relationship and current state,
with a bounded task summary where useful. Resolve data from existing
native/association indexes, not a separate Agent directory authority. Completed
children must remain discoverable for recovery queries, not just active ones.
Do not require model-generated names or silently deduplicate by display name.

### Tool registration proposal

Pi 1.0's replay policy belongs to the whole Tool registration. The current
`subagent` registration mixes creation, management and arbitrary workflow code.
Split that contract in a matched development upgrade:

| Proposed registration | Responsibility | Native replay policy |
| --- | --- | --- |
| `subagent` | Direct foreground delegation with task/context/cwd/compute/tools; wait for completion or supervisor blocking | `safe`, only after the recovery contract passes |
| `subagent_control` | List/status/wait/send/cancel existing children | `unsafe` in this slice; explicit scoped queries remain available |
| `workflow` | Existing Cube JavaScript workflow and its existing `runs.*` host calls | `unsafe` |

Remove the obsolete action-based combined schema after cutover; do not keep two
model-facing aliases. Existing supervisor Tools retain their own policy. Preserve
workflow capabilities, result bounds and Cube execution location. Tool metadata
declares recovery capability; the generic Worker adapter handles it without
scattering subagent-specific orchestration throughout the Worker.

### Recovery path

1. Finish ordered old-writer closure and obtain the new PG Session lease.
   Restore family/configuration bindings before enabling resumed effects.
2. Let Pi resume the eligible nonterminal Tool through its public replay-safe
   execution path. Recover the original source Task/operation from committed
   records; never generate a new child identity during recovery.
3. Register the current callback before publishing a fresh, ordered recovery
   reference through the same Session Kafka path. It points to the original
   immutable intent and carries current delivery/lease identity. Do not rewrite
   old scopes, duplicate the full arguments or impersonate the old boot.
4. Projector validates current authority/task state and resolves the same child.
   Complete a partially acknowledged creation/input admission only with the
   original idempotency identities. Projection lag alone never proves absence.
5. For running work, reconstruct the wait; for terminal work, read the outcome
   associated with the original Submission. Do not substitute the child's latest
   unrelated assistant message after subsequent inputs.
6. Send a fresh response to the current boot mailbox. Pi performs `afterTool`,
   bounds and canonical result settlement normally. A cancelled/terminal caller
   rejects continuation; an old response cannot replace its committed outcome.

Current creation receipts and source links already supply much of this identity.
Where delivery identity must change, separate it from logical operation identity
within the existing native dispatch metadata. No PG raw-result cache or new
control command queue is introduced.

### Prototype and acceptance gates

Use pinned native Harness/Storage first, then real PG/RF3 and actual worker
management transport. Recovery skips the normal `beforeTool` call, so prove that
the safe `execute` path can rebuild its wait through public APIs instead of
depending on the old in-memory prepared map.

Inject failure at intent commit, PG child reservation, native creation commit,
initial Submission ACK, result publication and canonical Tool Result commit.
Cover both isolated Projector replacement and full Worker replacement. Assert
one original child and initial Submission, one canonical caller result, current
ownership, no automatic unsafe child Tool replay, and correct source-result
selection. Include repeated replacement, nested children, parent Stop during
restore, supervisor blocking/reply and model-permit release while waiting.

Query without a target must find an existing child after interrupted creation.
Re-delivery of the same invocation must reuse it; a deliberately new invocation
may create another. Invalid/out-of-family targets remain rejected.

If the public API prototype cannot preserve these contracts, report that exact
gap before changing the design. Do not silently mark the whole combined Tool
safe, patch Pi's private scheduler, emulate cancelled results or adopt background
survival as a workaround.

## Slice 4 — Converging Cube Volume reference recovery

Addresses WVL-03. Primary boundary: the pinned Cube allocation/reference patch
and fixed POSIX Volume plugin, with existing Master/node version reconciliation.

First check the current upstream implementation/releases for a fitting repair;
prefer adopting one over extending the patch. Record the evidence and the exact
recovery protocol in a focused ADR before code changes.

Preserve stale holder, original sandbox/allocation, recorded node and reference
generation identity as recoverable cleanup work before dropping a holder.
Under existing attachment-admission closure, use positive physical evidence on
the recorded node and the fixed idempotent detach path to reconcile that holder.
Update reference state monotonically and retain surviving shared holders.

Do not clear `Unknown` because count is zero, a probe timed out, a master route
is missing or node metadata was replaced. Evidence that cannot be established
remains unresolved and observable; it must not block unrelated Volumes.
Old records whose identity was already discarded cannot be repaired by inventing
it. Keep explicit operator verification for those records. VM quota and Volume
byte deletion remain separate decisions.

Acceptance covers lost last holder, one surviving shared holder, repeated node
restart, delayed create/attach, reference-version races, interrupted detach and
ordinary cleanup. Restart recovery must eventually converge when sufficient
evidence exists; incomplete evidence must preserve refusal. Run native Bolt/
Manager tests under the race detector, maintained allocation contracts and an
owned live KVM restart/cleanup case with physical absence verification.

## Slice 5 — Attachment references and source/write lifetimes

Addresses UPL-01–04 and UPL-O1.
Primary boundaries: queued-input service, upload service/API and the existing
attachment store/source port. Record any retention/schema change in a focused
ADR before implementation; native Inbox remains the sole input authority.

- Separate provisional reachability from confirmed acceptance. Validate before
  pinning; associate provisional references with exact native input/mutation
  identity. Definite non-delivery releases only that provisional reference.
  Lost ACK retains protection until the existing native receipt/projection
  proves its outcome. A catch block must not globally reset `accepted_at`.
- Cover concurrent reuse of one upload, input edits, original admission followed
  by withdrawal, and a crashed API process. A receipt's temporary absence cannot
  prove non-acceptance before the old writer's tail is settled. Attachment
  bookkeeping stores references, never a second queue of input text.
- Keep inventory/cleanup identity while a PUT is unfinished or uncertain.
  Draft deletion signals active cancellation, but does not erase the writer's
  cleanup obligation. Join known local writes; dispose late completions.
  If a crashed writer's remote completion is uncertain, retain a small cleanup
  marker and reconcile it. A DELETE or absent-object response by itself cannot
  prove that an older PUT will never complete afterwards.
- Propagate browser cancellation through metadata, capacity waits and blob
  reads. Own and close the original started upload iterator even when MIME or
  claim validation rejects it before the returned generator is entered.
- Forward original-image previews through the existing streaming source port
  when length/hash and completion guarantees can be preserved. Join source and
  HTTP teardown; a late integrity failure must not end as a successful complete
  response. Avoid a second full-image Control Plane buffer.

Acceptance repeats definite no-send, accepted-but-ACK-lost, concurrent reference,
edit/withdrawal and API-crash cases. The long-upload fixture must permit a late
PUT without losing its cleanup identity, and cleanup must eventually remove the
unreferenced blob when the write's outcome is known. Test abort at each placement
stage, early MIME refusal and source integrity failure. Then verify actual Cube/
S3 upload, native input/Stop, image recall and preview cancellation with owned
resources. Ordinary Workspace files remain user files after draft removal.

## Slice 6 — Terminal and preview connection ownership

Addresses TPR-01–04. Primary files: terminal gateway, preview CONNECT adapter,
preview gateway and Sandbox control server.

- Mark redirect pending before awaiting owner validation. Old-connection close
  must not end a valid successor attempt; failed validation and user disconnect
  still close it. Use connection identity to reject late callbacks.
- Set an explicit upstream WebSocket handshake deadline and return a retryable
  UI error. Budget connection establishment separately from VM materialization
  and the unlimited lifetime of a healthy active connection.
- Make caller teardown cancel pending internal preview CONNECT requests,
  including redirects. Destroy a late successful socket after cancellation.
- Track establishing preview connections before the asynchronous open. Shutdown
  closes admission, cancels/joins pending opens, and disposes late streams before
  returning. No late 200 is emitted after shutdown admission closes.

Acceptance uses controlled redirect/lookup, stalled handshake, caller-close and
server-close barriers; all owned sockets, streams and timers must settle.
Re-run binary HTTP, SSE, WebSocket and terminal input/resize/close tests. Live
acceptance covers reconnect after compatible Control Plane replacement and
continued application/Agent behavior. Keep explicit terminal reconnect; do not
replay keystrokes or promise restoration of an old PTY. Closing preview targets
its relay, never the application server or whole VM.

## Completion, documentation and release

Every slice has a separate implementation commit and source/contract evidence.
Promote review probes into maintained regression tests asserting the repaired
behavior; a test that still asserts the defect is not acceptance. Existing
isolated-provider probes are not relabelled as real VM or S3 verification.

Update `docs/SUBAGENTS.md` for native Conversations, generation ownership,
50 KiB/2,000-line results, the new proposed Tool contracts and recovery behavior.
Update attachment/lifecycle documents where contracts change, then README,
ARCHITECTURE, ROADMAP, BACKLOG and READING_PROGRESS with actual completion status.
Remove obsolete fields/schemas/docs rather than retaining development-era
compatibility. Keep useful historical review evidence explicitly dated.

After implementation is authorized, follow the maintained required source,
artifact and matched-release checks and relevant live acceptance. Priority
repairs may ship before the larger recovery slice; schema/Worker/Pi/Cube
contract changes ship together with their matching artifacts. Routine deployment
already has standing authorization; this plan-only turn performs none.

Use controlled providers first and the configured `gpt-6-luna` for required live
model tests. No search-capability experiment or model-catalog change is part
of this work. Preserve accounts, model/provider settings and credentials.
Drain writers before matched cutover; confirm physical cleanup before removing
ownership records. Development data may be replaced when required without a
compatibility layer, but uncertain ownership/effects must not be discarded to
make a gate pass. Capture source failures separately from provider/network faults.

The final combined acceptance must include active shared/ephemeral children,
human terminals, attachment cancellation/recall, ordinary long work without a
total duration limit, Worker and Projector replacement, native Stop and owned
resource cleanup. Record measured query reductions and idle wake behavior;
do not infer fleet-scale reliability from these bounded checks.
