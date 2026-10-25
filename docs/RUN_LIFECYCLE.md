# Run lifecycle

The current contract is one root cloud Run, one physical Pi Session execution
lease/writer, and native child Conversations. Pi Durable 1.0 owns task execution
and continuation. PG owns cloud admission and lease decisions. See
[ADR-0247](adr/0247-session-work-and-tool-dispatch.md) and
[ADR-0256](adr/0256-session-publication-and-completion-boundaries.md).

## Intake and native input

### Composer commands (ADR-0277, schema 199)

`GET /v1/conversations/:sessionId/usage` is read-only. It returns committed
Conversation totals, per-model totals, separately attributed descendants and
an estimate of current context/window/compaction threshold. Cache input is a
subset of input, not added a second time. A switched model or compaction head
invalidates older response usage as a context estimate. In-flight output may
not yet be included. No model request, queue row or Workspace activation occurs.

`POST /v1/conversations/:sessionId/compact` accepts `{instructions?: string}`
with the usual idempotency key. During active work it routes through the
management connection to the current Worker; native Task and command receipt
must be committed before acceptance. An unreachable or ambiguous owner leaves
the command editable and retryable under the same identity. When idle it admits
one `operation_kind=compact` Run with the instructions, no upload payload and
no prompt Submission. Ordinary queued chat and compact share Session admission.

`GET /v1/conversations/:sessionId/compact` returns the latest command or null;
append `/:commandId` for a specific receipt. The PiCloud resource includes the
command ID, Run/Turn IDs, whether it was initial work, native sequence and state:
`queued`, `summarizing`, `awaiting_placement`, `applied`, `no_op`, `stale`,
`cancelled` or `failed`. It never reports success merely because the summary
request ended. Pi's write Submission must apply at its native boundary.
Native Task/Submission state remains authoritative; the lookup document is
only a pointer. Completed commands render as control actions, not user prompts.

Cold compact blocks ordinary sending while allowing draft editing; active
compaction keeps ordinary Pi follow-up/steer semantics. Stop uses the existing
Run cancellation path and Pi settlement. A summary already committed for native
placement follows Pi's rules rather than being retroactively discarded.
Worker loss closes the old writer and resumes the same native Task with a new
Session lease. The fixed Pi core is not patched.

For an idle Session, `POST /v1/sessions/{id}/turns` authenticates ownership and
atomically persists initial input, frozen configuration and a Run in PG before
returning `kind:run`. Session/idempotency uniqueness prevents duplicate requests.
The root `turn_id` is a presentation identity on `runs`; there is no `turns`
table. The locked Session serializes intake with readiness/closure updates.

For active work, Enter submits native follow-up and Steer submits native steer
through the original Worker's management endpoint. `kind:input` confirms the
native Storage commit's Kafka acknowledgement. An unreachable/unconfirmed Worker
leaves the browser draft and idempotency key available for retry. It creates no
second cloud Run or cloud payload queue.

Native submissions and InboxDoc own pending membership, order and consumption.
Latest-value human-input metadata preserves original text/uploads and mutation
receipts. Edits, moves, cancellation and promotion use public native transactions;
consumption winning the race rejects the edit. Input admission closes on the
runner's input line together with its final empty-queue/version decision.

Unclaimed root input can be edited in PG under the Run lock. Claim reads its
latest saved text after obtaining that lock. Model, credentials, environment and
Tool configuration remain frozen for the admitted work. Native children inherit
or receive their configured view within this same root work, without a separate
cloud claim or lease.

## Claim and execution ownership

Workers select ready root Runs with `FOR UPDATE SKIP LOCKED`. PG notifications
reduce idle delay; periodic scanning covers lost hints. The Worker reserves
pending/active physical-family capacity locally. New work requires a current
management connection and local publication/reply readiness.

Claim locks the physical Session ownership, checks prior closure/release, and
atomically issues its Session lease, records the publication scope and marks the
Run running. PG time after locks decides authority. There is no RunAttempt,
claimed stage, per-child occupancy counter or child Run queue.

Each active physical Session occupies one Worker family slot and owns one native
Harness and serial writer. Its main and child Agent Loops can run concurrently.
Model permits are separate, fair Worker-local capacity and are released while
waiting for Tools/children. Children keep native task/input/cancellation identity.

The Worker renews the family lease directly in PG. One Worker-local observer
batches authority reads and consumes renewal evidence; ordinary commits do not
perform another PG lease lookup. Management reconnect does not replace a healthy
Session producer. Lease loss interrupts the family and requires ordered closure
before a replacement owner can proceed.

## Opening Pi and executing Tools

The Worker opens native Storage/Harness under the admitted Session identity.
Initial input uses the logical Run as its native request identity. Recovery finds
that same submission; it does not append another user message. Cold reads load
the latest Compaction and active suffix, with required current input/task state.

World-state comparison records material Workspace/VM continuity changes through
native custom facts. Renewing the same physical owner alone is not a sandbox
change. Compaction preserves the material baseline; user messages are unchanged.
Pure chat does not provision Cube.

Before a Tool executes, Pi commits complete model output, validates arguments
and runs its before-Tool processing. The fixed Tool execute checkpoint and compact
cloud dispatch share one native commit. Projector materializes that intent and
confirms the monotonic dispatch offset before calling Cube. Projection replay
never repeats arbitrary shell work. Cube owns accepted execution and final
boot-scoped Kafka reply delivery; Worker Pi processing owns the canonical result.

The first required Tool binding prepares or reuses the Workspace's Cube VM.
Different Sessions may share that VM. Control Plane owns lifecycle/admission;
Cubelet owns accepted operation lifetimes and its boot/ordered-position fence.
An ambiguous handoff or missing result remains UNKNOWN, without automatic replay
or a whole-VM cleanup inference. Persistent Volume bytes outlive VM loss.

## Native publication

Worker initializes one Kafka transactional producer with a stable ID derived
from Topic, tenant and physical Session. It verifies its exact PG grant before
and after initialization. Run/lease/Boot changes do not change that Kafka identity.
A delayed stale initializer may disrupt a valid producer, but cannot publish
business data after failing its fresh authorization check.

Native `Storage.commit()` prepares the exact batch and sequence, externalizes
images and publishes directly to Kafka in a short transaction. Kafka ACK precedes
local adoption. Native state, dispatch/cancellation descriptions and text
presentation references travel together. No Worker append HTTP ingress or
per-Step PG receipt remains. PG asynchronously materializes cold native storage;
a bounded Worker overlay may wait for that projection before eviction.

A trusted pre-send rejection becomes native `StorageRejected`: the draft is
rejected while the Session remains usable. Pi owns subsequent task failure.
This adds no automatic storage retry and does not guarantee retention of an
uncommitted Tool Result. Unknown/mismatched ACK, fencing or post-ACK adoption
failure interrupts the entire writer and requests ordered recovery.

## Normal completion

A final assistant message alone does not finish a root Run. The runner waits for
native descendant-aware idle, closes input admission and joins child runner and
publication cleanup. The last handle closes the native Harness while its
publication anchor is still available for cleanup writes.

The root writer drains all publications, refuses remaining child log handles,
and commits `work_finished` with its final native/display positions. This is an
ordinary record from the same Session producer. It does not make a separate
PG-to-Outbox terminal round trip.

Projector first closes routing admission. Its PG transaction locks the root Run
and writer, checks identity/closure and the last native commit, checkpoints any
required live state, and commits the terminal event, Run outcome and progress.
Normal voluntary retirement closes/releases the writer in that transaction.
Under the Session lock it advances successor readiness. The completion code
reuses its already locked Run data, preserving version checks across cancellation
transitions.

The stored terminal then reaches the live view/browser. If the PG commit
succeeded but its return was lost, replay returns that same persisted event and
coverage; duplicate delivery changes neither the Run nor its event identity.
Browser acknowledgement is not a condition for releasing execution ownership.

If forced writer closure was already requested, normal completion may determine
the logical outcome, but cannot discard the pending seal or release that writer
early. The seal still completes the ownership boundary. Closure does not prove
that any physical Cube process exited.

## Stop and abnormal recovery

Chat Stop is recorded durably in PG and delivered to the owning Worker. Pi aborts
the root Conversation and its owned tasks. Native abort state and operation
cancellation co-commit through the same Session Kafka path. Cube cancellation
follows the guest Tool/process-group boundary; completed background launches are
not cancelled retroactively. A late reply cannot replace native abort settlement.

Unconsumed stopped human inputs are returned to the composer after native
reconciliation and ordered closure. There is no paused cloud follow-up queue.
Missing cancellation acknowledgement never proves physical process termination.

On uncertain publication, Worker loss or revoked ownership, PG requests one
physical-Session seal. Routing admission closes before the control publisher
initializes the same Kafka transactional ID, rechecks the closure intent and
publishes under its Projector group guard. Projector commits exact handoff state
and closure proof before a fresh PG lease may resume the same Run/submission.

An interrupted unsafe Tool receives native interruption settlement and is never
automatically rerun. A stopped recovering Run opens only to record abort, with
model/effect ports gated. An already committed native result is reused. The new
owner may be on the original Worker or another one; native task state cannot
self-authorize either.

Abnormal VM cleanup retains immutable recorded-node targets in the existing
control Outbox. Quota release requires positive physical absence. Normal Tool
failure, lease expiry, probe loss and writer closure alone do not authorize VM
or Volume destruction. A quarantined Session additionally needs its committed
closure and positive Agent exit evidence before returning to idle.

## Delivery semantics

| Boundary | Contract |
| --- | --- |
| Root Run queue | Durable PG input, transactional claim, repeatable wakeups |
| Native commit | One Session writer, Kafka transaction ACK, idempotent PG projection |
| Tool dispatch | Confirm dispatch position first; ambiguous effects are not replayed |
| Normal completion | Ordered `work_finished`, idempotent PG terminal and voluntary retirement |
| Forced handoff | Revocation, native producer fencing, ordered seal, fresh PG grant |
| Browser terminal | Persisted event identity; replay/reconnect can restore delivery |
| Workspace bytes | Persistent Cube Volume, independent of a Run's completion |
