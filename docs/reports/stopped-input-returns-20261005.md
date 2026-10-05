# Stopped queued inputs return to the composer

Status: implemented and locally verified, not deployed. This is the queue-policy
slice of [ADR-0229](../adr/0229-native-durable-runtime.md). The application still
pins Pi 0.84.1; this report does not establish a Durable 1.0 runtime migration.

## Behavior and storage

Stop captures existing unadmitted inputs under the Session lock in the same
transaction as cancellation acceptance. Ordinary queued inputs become cancelled.
Held Steer waits for canonical consumption or the ordered target seal. Only
unconsumed inputs return; retrying Stop cannot capture newly submitted input.

Text, attachment metadata and accepted identities stay in the original Turns.
`runs.input_return_request_id` identifies an immutable Stop batch. The existing
control receipt carries one bounded pending-return flag; there is no new queue,
message-body copy, lease or native-history event.

The browser restores the batch in pages of 20, retaining its existing draft and
attachment identities. It acknowledges the Stop only after recovering every page.
Page membership survives another browser's acknowledgement. A failed/lost response
retains the local cursor and cannot duplicate text in the open composer. An early
SSE acknowledgement clears the waiting notice; navigation aborts restoration into
another Session. After successful recovery, the text has the same browser-local
lifetime as an ordinary unsent draft.

The former pause flag, individual Send action and resume-queue endpoint are
removed. Schema 176 requires drained execution ownership and seals. It converts
existing paused drafts to pending returns, preserving held Steer for reconciliation;
a paused draft without its durable Stop receipt rejects the migration.
The API contract is described in [Architecture](../ARCHITECTURE.md).

## Verification

- 47 real-PostgreSQL cases across queued inputs, queue views and Workspace uploads.
  The queue suite was rerun after the final acknowledgement query change: 32 passed.
  Coverage includes Stop replay, fresh-input admission, frozen order, images,
  held/consumed Steer, seal reconciliation, service replacement, tenant isolation,
  acknowledgement before reconciliation, and reading later pages after another
  browser acknowledges the batch.
- 71 cases across protocol, browser API/SSE/state, return recovery, input-queue
  events, full schema creation and conversion of paused drafts. The schema tests
  use PGlite; the queue/admission tests above use real PostgreSQL.
- `node scripts/run-browser-queue-check.mjs`: passed. Includes 45 returned inputs,
  pending consumption, lost acknowledgements, early committed-state notification,
  retries without duplicate text, editing/reordering and queue pagination.
- `node scripts/run-browser-presentation-check.mjs`: passed, including existing
  draft, upload, Steer, navigation and Workspace behavior.
- Control Plane, Web UI and database TypeScript checks, Web UI production build,
  documentation checks, formatting and `git diff --check`: passed.

These tests do not exercise a deployed schema-176 application or make model calls.
No production Pods, database, Cube resources or stored attachments were changed.
Durable storage conformance, native cancellation/recovery cutover, and matched
GPT-6 Luna/Cube deployment remain in the migration backlog.
