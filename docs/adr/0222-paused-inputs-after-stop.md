# ADR-0222: Preserve and pause pending human input after Stop

Status: historical deployed behavior, 2026-10-04. Source queue policy replaced
by [ADR-0229](0229-native-durable-runtime.md); that migration is not deployed. See the
[verification and live acceptance](../reports/paused-inputs-20261004.md).

## Behavior

Chat Stop atomically persists the cancellation request and pauses existing,
unstarted inputs of that conversation. Keep text, attachments, order and frozen
model/environment settings. New messages remain eligible to execute independently.
Old messages resume only through an explicit individual Send, Steer, or Continue
queue action. Editing, removing and ordering paused messages remain available.
Browser refresh, Control Plane replacement and Worker loss cannot resume them.

Already-consumed Steer is history. An in-flight delivery remains held until its
canonical input Entry or target seal decides consumption, as in ADR-0203.
Unconsumed input returns paused after Stop; uncertain delivery is never restored
early. Stop prevents new deliveries to that target. It cannot recall an input
already admitted by the native Agent before interruption wins the race.
The Worker clears Pi's pending memory queues through public `clearAllQueues()`
before `abort()`, matching TUI Esc. Otherwise a cancelled Tool's return can let
Pi consume queued input before observing model-stream cancellation. PG retains
the original human input; canonical Entries still decide any consumption race.
Subagent input and automatic failure recovery retain their existing contracts.

## Authority and ordering

Reuse the existing PostgreSQL Run queue, Session lock, readiness and bounded
control receipts. Add an `input_paused` flag to unowned Run intents; do not add a
second queue or browser-owned execution gate. Stop marks existing pending rows
in its cancellation transaction. New input defaults to unpaused. Readiness and
admission exclude paused rows, and paused predecessors do not block new input.

Mailbox positions also order history and branch anchors. Resuming an old intent
therefore assigns a fresh tail position under the Session lock, preserving the
relative order of resumed inputs. It retains Run/Turn identities and original
acceptance fingerprints. An admitted Run is never moved or executed again.
Reordering stays within paused or eligible inputs, avoiding a swap that moves a
new executable input before already-executed history. Whole-queue resume uses
server-side ordered updates, not an unbounded transfer of message bodies.

Continue queue and individual Send use the current optimistic Session revision
and existing `turn_control_requests` idempotency receipts. A response retry cannot
resume messages submitted or paused after the original command. Queue control
changes use the existing PG Outbox/Kafka memory-view/SSE path. Actual admission
continues to check PG; no per-Step SQL or Pi Agent Loop patch is introduced.

## Adoption and public contract

Pi's interactive editor restores unconsumed queues to editable text on Esc
(`restoreQueuedMessagesToEditor` in the inspected Pi source). Preserve that
user-controlled restart boundary while retaining separate durable message cards
in the Web UI. Reuse the queue/adoption decisions in ADR-0179/0194/0203: the
existing PG primitives already own admission and consumption. Another scheduler
cannot make a native consumption race atomic and would duplicate authority.

Queue snapshots expose `hasPausedInputs` and each item's `paused` flag.
Individual actions add `send`; POST
`/v1/sessions/:sessionId/queued-inputs/resume` accepts a revision and an
Idempotency-Key and returns the existing action result. Steer awaiting definitive
consumption remains visibly pending and cannot be edited or individually sent.
The UI offers Continue queue, Send, existing edit/remove/order/steer controls, and
explains that sending a new message does not resume old paused messages.

## Acceptance and cutover

Test real-PG Stop/admission and Stop/Steer races, canonical consumption versus
seal, idempotent Stop/resume/Send, fresh-input bypass, no auto-resume after restart,
reordering and history order, pagination, tenant/viewer isolation and attachments.
Exercise queue controls and draft preservation in a browser, then run matched
GPT-6 Luna acceptance. Drain executions before schema 173 and deploy matched
API/Worker/Web artifacts without resetting business data or retaining an old
queue behavior mode. Existing pending inputs remain eligible until a new Stop.
