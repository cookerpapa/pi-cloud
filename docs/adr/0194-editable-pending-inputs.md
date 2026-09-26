# ADR-0194: Editable pending conversation inputs

Status: accepted, implemented and locally validated, 2026-09-26, following the
owner's request for individual cancellation, editing, ordering and promotion to
active steer. [Acceptance and matched rollout](../reports/queued-inputs-20260926.md).

## Ownership and admission

Extend the existing PostgreSQL Turn/Run queue (ADR-0179); do not introduce a second
scheduler, browser-owned queue or alternative Agent Loop. A queued, unowned Run
is a mutable input intent. Its text and mailbox order freeze at execution
admission. Model, credentials, environment and Tool snapshots retain acceptance-time
semantics. Admitted Runs and native history cannot be edited or replayed.
This refines ADR-0193's description of immutable queued input.

Pending input APIs use the Session row version for optimistic concurrency and
the existing turn_control_requests table for bounded idempotency receipts of
kind `queue`. Original Run acceptance fingerprints remain immutable, so retrying
the original POST cannot recreate or overwrite an edited/cancelled input.
Cancelled unstarted Runs remain audit/idempotency tombstones and are not rendered
as executed conversation history. User input stays in Turns, not new queue rows.
Pending inputs have their own view and do not occupy conversation history pages;
many pending messages cannot evict the active Turn from the latest-history page.

Queue mutations lock the product Session, then acquire affected queued Run locks
with NOWAIT. Worker admission already locks a Run first: NOWAIT avoids a lock
cycle and returns a clear conflict when admission wins. Adjacent order swaps use
PostgreSQL's deferrable unique constraint on Session/mailbox position. Readiness
is recomputed under the same Session lock. The Worker reads mutable input in a
fresh statement after locking its candidate: the candidate query's original MVCC
snapshot must not freeze an older Turn text after a concurrent edit commits.
This adds one admission read, not a per-Step query or another authority.

## Promotion to steer

In one transaction, hold the queued source Run out of dispatch and persist a
queue/steer control request pinned to the active Run, Worker and source input.
The HTTP response reports a pending promotion; no PG transaction spans delivery.
Use the existing Worker HTTP steer port. The stable control-request ID also
identifies native input consumption, using the existing Agent-input dedup path.
Retries deliver only that same input ID, never arbitrary Tool work.

A bounded reconciler in the pending-input service resumes persisted promotions
after API restart. It uses existing PG control rows and next-attempt times, with
two local deliveries in flight; duplicate replicas remain safe through native
input deduplication. It does not schedule Runs. Queue status remains `steering`
until consumption. Promotions targeting one Run retain acceptance order through
the Session revision: a later delivery waits until an earlier one is acknowledged
or resolved. Unrelated Sessions can deliver concurrently. Queue retirement waits
until the canonical native Entry proves consumption. A consistent read of the
target's projected seal and absent input Entry proves non-consumption; then the
original input returns to its queue position. HTTP failure alone cannot restore
it and risk both delivery paths executing. Seals, quarantined-Session readiness
and no-Run-replay rules remain in force. Shutdown stops new delivery and awaits
bounded existing HTTP requests.

## Product and protocol

GET /v1/sessions/:sessionId/queued-inputs returns one consistent queue snapshot
and revision. POST /v1/sessions/:sessionId/queued-inputs/:turnId/actions accepts
edit, cancel, move up/down or steer with an expected revision and Idempotency-Key.
Only ordinary owned conversations are mutable. A bounded queue of at most 64
pending inputs keeps whole-queue responses bounded at the existing input limit.

The Web UI shows pending items above the composer. Editing is optimistic; a
conflict preserves the unsent draft. A promotion is visibly pending while being
confirmed. Started inputs cannot be edited; already-consumed steer cannot be
recalled. Queue refresh uses bounded HTTP polling/focus refresh and action replies,
not a new durable event stream or model messages. Native execution continues to
use the current SSE/Projector path.

## Adoption, acceptance and cutover

The maintained adoption decision is ADR-0179: existing PostgreSQL row locks,
transactions, constraints, readiness and Worker admission already provide the
required authority. Pi's public queued input API and current HTTP transport supply
delivery. Adding a queue/workflow package would introduce a competing scheduler
and cannot make PG-to-Worker delivery atomic. Retain owned adapters and pinned Pi.

Require tenant/viewer isolation, stale revisions and replayed HTTP requests;
claim-versus-edit/cancel/reorder tests on real PostgreSQL; queue restoration only
after definitive non-consumption; lost HTTP replies and API restart; native input
dedup; browser edit/cancel/order/promotion; and paid Luna/Cube execution in the
resulting order. Drain inputs/executions before schema 152 and deploy matching
API/Worker/Web builds. No compatibility execution mode is added. Rollback requires
no pending promotions and stops new queue mutations before reverting schema.
