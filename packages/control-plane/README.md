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
- ordered PG control-change publication and bounded owner-local read views;
- direct VM health observations and controller-owned recovery decisions.

It manages Cube through `SandboxProvider`; Cube executes user file/shell Tools.
The Pi Agent Loop runs in the trusted Worker. Publication, projection and sandbox
lifecycle are modules of this process, with no independent Tool Broker.

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

Queue reads return `{ sessionId, revision, viewVersion, activeTurnId, items }`. Items contain
`turnId`, `runId`, `text`, `mailboxPosition`, `acceptedAt` and `status` (`queued`
or `steering`). Reads share a consistent PostgreSQL snapshot; pending input is
separate from conversation history pagination and its Turn count.
`viewVersion` is a bigint string ordering presentation snapshots independently of
the numeric edit `revision`. The initial/reconnect/focus GET reads PG; subsequent
changes arrive as `input.queue` on the existing SSE connection. Successful edits
reuse their returned snapshot. There is no periodic queue GET.

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

Direct `POST /v1/sessions/:sessionId/turns/:turnId/steers` accepts `{ text,
uploadIds? }` with an `Idempotency-Key` and returns HTTP 202:

```text
{ controlRequestId, targetRunId, targetTurnId, sourceRunId, sourceTurnId,
  sessionId, state: "accepted", acceptedAt, replayed }
```

Acceptance creates and holds its source input in the same transaction. The
source inherits the active target's frozen model/environment/credentials and
reserves the next mailbox position. It appears as `steering` in the ordinary
queue until canonical consumption removes it. A sealed target without its input
Entry restores that source as an ordinary queued input, including after Worker
loss or cancellation. An HTTP delivery acknowledgement alone never retires it.
The old `delivered` response and `deliveredAt` field are removed. A repeated
accepted key remains valid after the target closes; different input or target
under the same key returns 409. The queue limit and tenant/viewer rules apply.

## State

PostgreSQL is authoritative for business state, complete Pi Session records,
Run history and settled conversation projections. Kafka durably accepts native
records, display events and Tool/control commands before projection; persistent
Cube Volumes own Workspace bytes.

Conversation titles are independent from Workspace names. A Workspace may be
shared by multiple conversations. Deleting a quiescent conversation permanently
removes its subtree and associated native/control history. Workspace bytes have
an independent lifecycle; branch pruning retains its separate `pruned_at` semantics.

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
