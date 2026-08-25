# Control Plane

The Control Plane is the authoritative multi-tenant business service for
PiCloud.

## Responsibilities

- accounts, browser sessions, tenant roles and platform administrator identity;
- Projects, named Workspaces and named conversations;
- Run/Attempt admission, idempotency and Session ordering;
- leases, fencing tokens, heartbeats and terminal commit;
- canonical Pi Session persistence and resumable SSE cursors;
- bounded Workspace revision/index references;
- PostgreSQL-backed Run queue publication and cancellation;
- model/proxy configuration and usage;
- tenant-scoped file/version APIs.

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
POST   /v1/sessions/:sessionId/turns/:turnId/cancellation
GET    /v1/sessions/:sessionId/events

GET    /v1/sessions/:sessionId/workspace-versions
GET    /v1/workspace-versions/:versionId/files
GET    /v1/workspace-versions/:versionId/file
```

Mutations use tenant authorization and idempotency keys where they can produce
durable side effects.

## State

PostgreSQL is authoritative for business state, complete Pi Session records,
Run history and settled conversation projections. JetStream owns the
bounded live-event tail; persistent Cube Volumes own Workspace bytes.

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
