# ADR-0229: Adopt Pi Durable 1.0 execution semantics

Status: accepted for implementation, 2026-10-05. Not deployed.

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

An admitted user request is logical work which may survive Worker replacement.
Recovery must first revoke the old publication owner and close its ordered
writer incarnation, then acquire the current PG lease. Only that holder may
open/resume the native Harness. Native pending state alone grants no execution
permission. No RunAttempt table, channel lease or competing task scheduler is
introduced. The mapping from logical work to its cloud execution grant must
keep public input identity and accepted settings across recovery.

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
Current document/task projections are derived from this same canonical log,
not independent control queues or external-operation result ledgers.

Native model/task documents required for recovery are durable state. Disposable
network health and guest preview observations retain the current HTTP/SSE path;
do not feed ordinary guest previews into `api.output()` by default. Immutable
image references must cover new native record/document locations; Worker decoding
still gives Pi ordinary image content. Cube Volumes retain Workspace byte ownership.

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
Only code-owned tools/extensions are installed. MCP/Codemode product exposure
is a separate capability decision, not an implicit effect of dependency upgrade.

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
