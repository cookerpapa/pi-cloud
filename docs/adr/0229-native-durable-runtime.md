# ADR-0229: Adopt Pi Durable 1.0 execution semantics

Status: implemented, verified and deployed, 2026-10-06. See the
[migration and release record](../reports/pi-durable-migration-20261006.md).

The owner chose native Pi Durable 1.0 cancellation and recovery after
[ADR-0228's executable evaluation](../reports/pi-durable-evaluation-20261005.md).
The former differences are migration requirements, not reasons to reproduce
the 0.84.1 loop or patch upstream. Pin the adopted MIT-licensed packages to
1.0.0. Production adoption must replace the existing runtime and old Session
storage path rather than add a selectable second backend.

## Runtime and execution ownership

One physical PiCloud Session has one open Durable Session/Harness under one
PG-issued renewable execution lease. Native Conversations replace execution
Lanes. Native tasks, submissions, entries and documents own Agent progress,
compaction, input placement and recovery. PG retains cloud admission, worker
ownership, resource lifecycle and the public input queue.

Configured finite budgets retain a conservative floor from native request/Tool
intent checkpoints on recovery; unconfirmed intents still consume budget. The
optional model-consumption count crosses the private assignment port into the
gateway. Unlimited Runs add no budget query. These guards are not an exact
provider billing ledger and never certify completion of an external effect.

An admitted user request is logical work which may survive Worker replacement.
Recovery must first revoke the old publication owner and close its ordered
writer incarnation, then acquire the current PG lease. Only that holder may
open/resume the native Harness. Native pending state alone grants no execution
permission. No RunAttempt table, channel lease or competing task scheduler is
introduced. The mapping from logical work to its cloud execution grant must
keep public input identity and accepted settings across recovery.

Run identifies the accepted logical work. A recoverable Worker loss closes its
old execution incarnation, not that logical work. Re-admission retains the Run,
Turn and native submission identity under a new Session lease; there is no new
attempt entity. Stop, deletion and an actual native terminal outcome remain
logical termination. Native task checkpoints own continuation; the cloud queue
owns admission, never an independent replay decision for each native task.

Delegated Conversations are owned by the requesting native generation, not by
its delegation Tool task. Durable holds a completing task while its owned work
is live; Tool ownership deadlocks a child decision request because the parent
cannot leave that Tool to call the reply Tool. Generation ownership spans those
successive calls and still cascades native parent abort to the child. The public
creation receipt remains keyed by the original delegation request; no ownerless
or extra scheduling authority is introduced.

The storage adapter retains native atomic commits. [ADR-0243](0243-native-input-current-state.md)
supersedes the original full-write retention for Inbox/input metadata and Submissions:
PG stores their current values; other writes remain in the canonical journal. Current-record pointers index retained history and ADR-0243 authoritative current
input state; other document reconstruction indexes are derived from the journal. Native JSON is serialized losslessly as text,
including NUL and lone-surrogate strings covered by upstream conformance; indexing
uses JSON-encoded string identities rather than lossy text coercion. It must not
copy transcript bodies into both a journal and full Entry query tables. Cloud
Session/Run/Turn provenance is retained alongside each canonical write, so the
thin current-record index can be rebuilt without reconstructing old grants.

The active Storage serializes reads and commits and waits for publication ACK
before adopting a prepared state. Its bounded acknowledged overlay serves writes
which PG has not projected yet. Eviction waits for the existing projection
watermark in batches, never a per-Step PG receipt. Cold reads use native IDs,
head markers, current task indexes and document bases. This is a new implementation
of the public Storage port; no upstream private fields or loop patches are used.

Use the public Harness's native abort settlement. A not-yet-committed Tool result
may become `aborted` with retained native output; late physical completions do
not replace it. This supersedes ADR-0221/0227's requirement that every received
final remote result win a concurrent Stop. The remote cancellation still travels
through the same ordered Session path and addresses the original operation.
It uses the guest Tool/process-group boundary, never whole-VM destruction.

Unsafe interrupted Tools are not automatically replayed. Durable may report
their interruption to the model and continue after cloud ownership is established.
Explicitly replay-safe trusted Tools must prove idempotency independently. Model
calls and external effects remain fenced by the existing cloud ports; a throwing
`beforeRequest` hook is not an authorization gate. No arbitrary shell exactly-once
claim is made. VM unavailability and uncertain physical effects remain distinct.

## Storage

The native format is Durable's atomic batch of records and Chord document changes.
Use a PiCloud-owned transport envelope; keep native SDK types inside its trusted
adapter. The owning writer stamps sequence and IDs, prepares a batch, waits for
the existing RF3 Kafka confirmation, then exposes it locally. PostgreSQL projects
the exact native batch and indexed current state for cold reads. There is no
second active sequence allocator or per-commit PG receipt on the hot path.

Implement the upstream Storage contract and conformance suite on PostgreSQL.
Use indexed record/document state and native head markers for bounded context
bootstrap. Never promote the evaluation's complete journal replay to production.
Plain active-conversation reads include the committed native Tool execute
checkpoint even before its live start event receives display coverage. Its stable
native task ID merges with the SSE start; no Tool task/receipt table is added.

Task and historical-document projections remain derived from the canonical log.
ADR-0243 current input values are durable native state; neither store is an
independent control queue or external-operation result ledger.

Native model/task documents required for recovery are durable state. Disposable
network health and guest preview observations retain the current HTTP/SSE path;
do not feed ordinary guest previews into `api.output()` by default. Immutable
image references must cover new native record/document locations; Worker decoding
still gives Pi ordinary image content. Cube Volumes retain Workspace byte ownership.

[ADR-0230](0230-complete-tool-call-publication.md) further restricts the public
Models input: incomplete local Tool calls stay in Worker memory and never enter
native partials. Complete successful calls retain native validation/intent rules.
Storage continues to preserve the exact writes produced by the Harness.

## Product scope and cutover

Public conversation, Tool, Workspace, model selection and Subagent behavior must
remain usable through the migration. On Stop, withdraw every unconsumed human
queued input and return its text and attachments, in queue order, to the composer
for editing. Preserve the existing unsent draft. Consumed Steer inputs stay in
history; a delivery acknowledgement alone cannot establish consumption. Resolve
an in-flight Steer against the canonical input and ordered closure before returning
it. Retrying Stop must not withdraw inputs accepted after that Stop. Remove the
former pause/resume queue policy rather than retaining a compatibility mode.
Returned content remains readable from its accepted Turn until the browser has
recovered it; queue pagination and a lost Stop response must not discard it.
Branched child context retains PiCloud's frozen pre-Run anchor; it does not inherit
the outstanding delegation call or the parent's current user prompt. Native
Conversation ancestry records that boundary. Only code-owned tools/extensions are installed. MCP/Codemode product exposure
is a separate capability decision, not an implicit effect of dependency upgrade.

The private native batch format uses a new execution topic, `pi-cloud.execution-log.v14`.
The old topic remains isolated until verified cutover and explicit drained-log
retirement; the new reader never interprets old append envelopes. Partition ownership and the single Session
queue remain unchanged. PG control views bootstrap the new topic owner.

Independent human forks copy native conversation documents according to their
persisted `asOf`/`current` fork policy as well as immutable entries. Task, Session
and `initial` documents do not transfer execution grants. Project verification
reminders are derived at native yield from committed progress, including their
previous continuation, so lossy display delivery cannot change the decision.

Cutover requires quiescence, matching Worker/Guest/control artifacts, migrated
or explicitly reset development native data, and removal of the old runtime,
storage exports and obsolete tests/docs. Existing unconfirmed physical resources
cannot be deleted or released without their recorded-node evidence. Rollback
uses matched application/database artifacts, not an old-protocol fallback.

## Acceptance

Run upstream Storage conformance against PG; verify atomic duplicate/conflicting
projection, prepared-commit visibility, publication uncertainty, scoped cold reads
and attachment lifetime. Verify native abort/unsafe recovery behavior, PG owner
replacement and stale-owner refusal. Exercise real GPT-6 Luna, Cube file/shell,
images, queue/Steer, Subagents, compaction, Worker replacement and cleanup before
claiming deployment. Keep the production pin unchanged until the complete slice
passes; do not mark partial source integration as a shipped migration.
