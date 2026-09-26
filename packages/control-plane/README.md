# Control Plane

The Control Plane is the authoritative multi-tenant business service for
PiCloud.

## Responsibilities

- accounts, browser sessions, tenant roles and platform administrator identity;
- Projects, named Workspaces and named conversations;
- single-Run admission, idempotency and Session ownership/ordering;
- leases, fencing tokens, heartbeats and terminal commit;
- canonical Pi Session persistence and replacement-snapshot SSE reconnects;
- Workspace/machine lifecycle and live directory/file browsing;
- PostgreSQL-backed Run queue publication and cancellation;
- model/proxy configuration and usage;
- Session Projector: native history, live views and ordered Tool/Subagent routing.

It does not execute user commands and does not control Cube directly.

## Public product APIs

```text
POST   /v1/auth/register
POST   /v1/auth/login
POST   /v1/auth/logout
GET    /v1/identity

GET    /v1/conversations
GET    /v1/conversations/:sessionId
DELETE /v1/conversations/:sessionId
GET    /v1/workspaces

POST   /v1/projects
POST   /v1/projects/:projectId/sessions
POST   /v1/sessions/:sessionId/turns
POST   /v1/sessions/:sessionId/turns/:turnId/cancellations
POST   /v1/sessions/:sessionId/turns/:turnId/steers
GET    /v1/sessions/:sessionId/queued-inputs
POST   /v1/sessions/:sessionId/queued-inputs/:turnId/actions
GET    /v1/sessions/:sessionId/events

GET    /v1/sessions/:sessionId/workspace/directory
GET    /v1/sessions/:sessionId/workspace/file
```

Mutations use tenant authorization and idempotency keys where they can produce
durable side effects.

### Pending input protocol

Queue reads return `{ sessionId, revision, activeTurnId, items }`. Items contain
`turnId`, `runId`, `text`, `mailboxPosition`, `acceptedAt` and `status` (`queued`
or `steering`). Reads share a consistent PostgreSQL snapshot; pending input is
separate from conversation history pagination and its Turn count.

Actions require `Idempotency-Key` and the `revision` from the last queue read:

```json
{ "action": "edit", "revision": 12, "text": "Revised instruction" }
```

Other variants are `cancel`, `move` with `direction: "up" | "down"`, and `steer`
with the active `targetTurnId` UUID. Steer accepts optional `text` to edit and
promote atomically. The HTTP 200 response is `{ queue, replayed }`; promotion can
still be `steering` until consumed. Retrying the same command identity returns
the current queue without repeating its mutation. A changed body under the same
key conflicts. Stale revisions, started inputs and admission-lock races return
409; foreign Sessions return 404 and viewers cannot mutate.

The queue is bounded to 64 inputs, each using the existing 100,000-character
prompt limit. Queue actions do not change accepted model or environment settings.
Promotion uses the active Run's settings; a non-consumed input retains its original
queued Run settings on restoration. A delivered/consumed steer cannot be recalled.

## State

PostgreSQL is authoritative for business state, complete Pi Session records,
Run history and settled conversation projections. Kafka durably accepts native
records, display events and Tool/control commands before projection; persistent
Cube Volumes own Workspace bytes.

Conversation titles are independent from Workspace names. A Workspace may be
shared by multiple conversations. Archived conversations are excluded from
ordinary list/direct-read APIs.

## Administration

The configured platform-operator tenant is exposed as
`platformAdministrator: true` in the authenticated identity. Only that identity
can read or replace platform model and Cube proxy settings. Ordinary tenant
owners receive `false`.

For a one-host installation, register the account first and then run:

```bash
npm run production:administrator -- --username <registered-username>
```

## Verification

```bash
npm run typecheck --workspace @pi-cloud/control-plane
npm test --workspace @pi-cloud/control-plane
```

The API tests cover tenant hiding, idempotency, Workspace sharing, conversation
deletion, Run/lease/fence transitions, event replay, cancellation and
administrator boundaries.
