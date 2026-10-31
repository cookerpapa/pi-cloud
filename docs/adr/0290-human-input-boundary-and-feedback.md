# ADR-0290: Human input across Run completion and immediate submission feedback

Status: accepted for implementation, 2026-10-31. The owner requested repair of
late steer/follow-up submission and delayed outgoing-message presentation.

## Decision

The composer's steer/follow-up preference expresses what to do **when busy**.
Use one human-input admission endpoint with that preference. PG and the native
receipt decide whether the input belongs to active work or starts a new root Run.
Remove the human API that requires the browser to target a particular Turn for
new steer input. Promoting an existing queued input remains a revision-checked
mutation of its original native Submission.

Keep one idempotency identity across retries and across the active/idle boundary.
Read an existing native or PG receipt before deciding a new destination. A local
closed-input refusal may trigger a fresh admission check; it never independently
authorizes a second Run. Only PG-confirmed closure plus absence of a native receipt
permits new root admission. Uncertain delivery preserves the draft and identity.
Pi's public submit/Inbox APIs remain the sole input queue; no second payload queue,
RunAttempt, loop patch or forced restart is introduced.

Pending native steers remain editable/cancellable/reorderable while their
Submission is queued. The browser must not confuse the pending mode with proof
that the Agent has already consumed the input. Consumption still wins an edit
race through the native transaction.

Refresh queue presentation after an authoritative terminal event. A refresh that
arrives during an input mutation must run after that mutation, including after a
successful response carrying an older snapshot. Queue observations that disagree
with the browser's active Run should trigger bounded state reconciliation rather
than keeping a stale running/steering view indefinitely. Do not poll per token.

Display an explicit local sending state immediately on submission, including
attachment preparation. It is not canonical conversation history or a durable
acknowledgement. Only confirmed PG/native acceptance clears the submitted draft;
failure or uncertainty keeps its text, attachments and retry identity. New edits
and a different conversation must not be cleared by an older reply.

## Evidence and limits

Three owned real Luna initial submissions on the deployed baseline acknowledged
in approximately 32, 55 and 18 ms and completed sequentially. Read-only queries
against the reported long conversation did not reproduce a seconds-long database
lookup. The reported session has completed native work and no pending native
input at inspection; several later initial Runs were cancelled before claim.
Historical row state alone does not establish why each cancelled Run waited.
Do not conflate that evidence with proof of a native Agent-loop failure or a
provider-stream completion issue.

Source review confirms a separate presentation gap: queued steers are shown as
uneditable, terminal events do not refresh the queue, and refreshes are discarded
while mutations are in flight. Browser tests must reproduce the stale-response
ordering before repair. Retain existing model-stream waiting and writer closure.

Queue items expose `runMailboxPosition` only for unclaimed initial Runs. This is
the absolute transcript order, distinct from the relative pending-queue position.
Queue absence never deletes an accepted message without confirming its Run state.

## Acceptance

Require active native steer, idle preferred-steer admission, completion races,
lost acknowledgements, unchanged-payload retries across API instances, changed
payload rejection and uncertain-delivery refusal without duplicate work. Verify
queued steer editing and consumption races, deferred queue refresh and immediate
local feedback in a real browser. Measure HTTP acknowledgement separately from
Worker claim, model latency and rendering. Use owned fixtures and preserve the
original conversation. Publish through matched API/Worker/Web verification.
