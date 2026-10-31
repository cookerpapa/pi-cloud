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
GET    /v1/sessions/:sessionId/queued-inputs
POST   /v1/sessions/:sessionId/queued-inputs/:inputId/actions
GET    /v1/sessions/:sessionId/events

GET    /v1/sessions/:sessionId/workspace/directory
GET    /v1/sessions/:sessionId/workspace/file
```

Mutations use tenant authorization and idempotency keys where they can produce
durable side effects.

### Input and pending queue protocol

An idle conversation request returns `kind:run` after one PG transaction records
its initial input and execution. A running conversation's ordinary message uses
native Pi follow-up; `whenBusy:steer` selects native steer on that same endpoint. Both
return only after the Worker's native Storage/Kafka acknowledgement:

```text
{ kind:"input", inputId, runId, turnId, sessionId,
  delivery:"follow_up"|"steer", state:"accepted", acceptedAt, replayed }
```

`runId` and root `turnId` identify the current execution. `inputId` identifies
the individual native submission; no second Run or PG input payload is created.
503 `input_delivery_unavailable` leaves the browser draft unconfirmed. Reuse
the same idempotency key on retry, even if the first native ACK was lost.

Queue reads return `{ sessionId, revision, viewVersion, activeTurnId,
hasReturnedInputs, afterPosition, hasMore, items }`. Each item has `inputId`,
`runId`, `text`, optional `uploads`, `mailboxPosition`, `acceptedAt` and status
`queued|steering`. Pages contain at most 20 inputs, without a total queue quota.
Use the opaque string `revision` plus `afterPosition` to continue a page.
`viewVersion` is a decimal bigint encoding native sequence and Session row
version; compare it only with other view versions, never control-reference IDs.

Actions require `Idempotency-Key` and the latest opaque queue revision. Edit
accepts `{action:"edit",revision,text,uploadIds?}`. Other variants are `cancel`,
`move` with `direction:"up"|"down"`, and `steer` with optional edited `text`.
Promotion keeps the original input identity and inherits the active Run's
settings. A successful mutation returns `{queue,replayed}`. Stale revisions,
consumed inputs and claim races return 409; foreign Sessions return 404 and
viewers cannot mutate. Unsaved edits remain local. Repeated saves append native
document changes through public Pi APIs.

Initial/reconnect/focus reads materialize one current PG/native snapshot.
Relevant native commits and PG control changes wake `input.queue` SSE updates;
there is no background delivery reconciler or periodic queue GET.
Stop returns only unconsumed human inputs after native abort and ordered closure.
`GET /returned-inputs` under the Session path pages by `requestId/afterPosition`;
`POST /returned-inputs/acknowledgements` clears the pending marker after recovery.
Text/uploads stay in native metadata, and pages remain stable for another browser
that is still restoring the same acknowledged batch.

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
