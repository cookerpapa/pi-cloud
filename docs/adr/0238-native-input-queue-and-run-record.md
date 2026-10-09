# ADR-0238: Native input queues and one cloud execution record

Status: accepted for implementation, 2026-10-08. The owner approved native
follow-up, durable pending-input editing, Session/Run consolidation, and the
intake acknowledgement boundary below. Implemented in source on 2026-10-09;
[source verification](../reports/native-input-run-consolidation-20261009.md) is followed
by the [matched deployment](../reports/native-input-release-20261009.md) on the same date.

## Execution and input identity

Retain `sessions` for product identity, current preferences and resource binding.
Merge the former Turn payload/model fields into `runs`; remove the `turns`
table and its duplicate lifecycle. A Run is one cloud-authorized execution of
a native Conversation and can process multiple human inputs. Its public root
Turn identity remains a presentation/provenance identity in that same row,
not another execution, scheduler or mirrored state machine. Native submissions
identify the individual follow-up/steer inputs within that execution.

An idle Session's initial request is still accepted atomically into PostgreSQL
before HTTP success. Workers claim only actual executions and acquire the same
physical-Session lease. A running Session's follow-up/steer is sent to its
current Worker, which calls the public Durable `Conversation.submit()` with a
stable request identity and `whenBusy: followUp/steer`. No placeholder Run is
created for an input delivered to another Run. No native loop patches or raw
Storage-batch filtering are allowed.

An appended human input is acknowledged only after the native Storage commit
has received its existing RF3 Kafka acknowledgement. When the Worker is not
available or admission is uncertain, keep the browser draft and retry the same
input identity. The owner explicitly chose this over maintaining another
durable cloud input-payload queue. PG control receipts may retain bounded
identity, target, fingerprint and response metadata; never the input body or
another independently consumable queue. An ambiguous delivery must not create
a second input or silently start a new Run. A proven closed target without
native acceptance may permit a fresh execution through the ordinary PG path.

## Native queue ownership

Durable owns `submission` state and the public `pi.inbox` document. Its normal
commit stream persists acceptance, queue mutations, consumption and abort.
The Worker remains the only active native writer; the API does not run Pi or
write native Storage directly. A replacement Worker first obtains the existing
ordered-closure/new-lease grant and resumes the same logical Run.

Code-owned native documents retain the human-editable text, upload references,
original request fingerprint and bounded mutation receipts needed by the UI.
These are records in the existing Pi Storage, not PG queue payloads or another
execution log. Queue membership/consumption always comes from native
submissions and InboxDoc. Metadata written before native submission is not
considered an accepted input by itself. Retrying the same request reuses its
identity and must not overwrite later user edits.

Edit, move, cancel and promote-to-steer are public native document transactions
executed by the authorized Worker. Check the input remains queued and the
expected queue revision still matches. Mutations and native consumption share
the Session commit line; consumption winning the race rejects the edit.
Cancellation co-commits submission settlement and Inbox removal. Promotion
changes that pending input's mode rather than submitting a duplicate input.
Keep stable input identity and mutation idempotency across lost replies and
Worker replacement. Editing drafts locally produces no native writes until
the user saves.

The pending-input API presents native queue order, original human text and
opaque attachment references. Its edit revision describes queue state, not
unrelated model-token writes. Pagination is invalidated by queue changes only.
Presentation ordering still rejects older HTTP/SSE snapshots. Projector wakes
the queue view on relevant native commits; it does not poll every token or
introduce a second consumer group.

## Stop and rendering

Stop first closes further human-input admission, then uses native Durable abort
and the existing ordered Tool cancellation. Queued human inputs withdrawn by
that Stop return to the composer with original text/uploads. Consumed inputs
are never returned or replayed. Reading/acknowledging returned pages remains
idempotent across browsers. Logical Run closure, writer recovery seals and
physical Tool cancellation remain separate facts.

Render every consumed human follow-up/steer at its native position between
assistant/Tool messages. Do not collapse them into the root prompt or show
pending drafts as consumed history. Native entries retain their existing
cloud Run/root-Turn provenance; individual input identity comes from the
native submission. One cloud Run may contain several model generations.

## Schema cleanup

Move input text/uploads, model/provider/thinking/service-tier/credential
snapshots and pruning metadata into Run. Keep one execution state, failure
record and set of lifecycle timestamps. Migrate all foreign keys, tenant
constraints and the active-Lane uniqueness rule before removing Turn; no
compatibility view or duplicate-write path remains.

Remove the reviewed unused `sessions.forked_from_session_id`,
`runs.conversation_base_seq`, `runs.output_projected_offset` and
`runs.last_heartbeat_at`; remove constant `input_kind` storage and duplicate
`queued_at`. Keep current configuration distinct from accepted execution
snapshots, and keep each real ownership/closure boundary. Clarify Run's
historical Worker-owner `sandbox_id` name. Native projection still validates
lease/seal authority on every commit; only an already-initialized redundant
first-position UPDATE may be skipped.

The two core business tables do not replace Session leases, native log/indexes,
Workspace lifecycle or bounded control receipts. This preserves one authority
per concern. Native Pi owns continuation; PG owns cloud execution admission.

## Adopt before build and acceptance

The pinned Pi Durable 1.0 public `Conversation.submit`, `InboxDoc`, `Tx.doc`,
`Tx.submissionByRequest` and `Tx.settleSubmission` provide the queue primitives.
Isolated probes confirmed final-boundary follow-up, stable-request deduplication,
two edits to the same queued input, persisted-journal reconstruction, stale-edit
refusal and consumption-before-edit refusal. Reuse these APIs instead of
building another consumer/scheduler. Their public types remain behind the
trusted Runner/native-storage adapters and PiCloud-owned HTTP schemas.

Require native, PG, API and browser tests for: same-Run follow-up; post-Tool
steer; multiple user messages in live/cold history; edit/move/cancel/promote;
attachments; lost intake/mutation replies; unavailable or replaced Worker;
late input versus closure; Stop/return/acknowledgement; initial PG input edits;
root/subagent Run lifecycle; tenant constraints and unique active Lane;
native projection replay and first-position preservation. Run relevant type,
unit/integration and browser gates, then matched live acceptance when deploying.
No arbitrary Tool replay, new per-Step receipt, second queue or compatibility
runtime is introduced. Drain old owners and resolve pending returned-input batches before any matched
schema cutover. The permitted development cleanup can remove obsolete business
state after ownership/physical cleanup proofs; accounts and configuration remain.
