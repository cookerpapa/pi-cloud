# ADR-0212: ordered control changes and bounded memory views

Status: accepted by the owner, implementation in progress, 2026-10-02.

## Scope and adoption

The owner approved the architecture review's sequence: Sandbox binding views,
queued-input presentation, then Session-local Subagent routing and pending work.
Shared Workspace/preview routing and global configuration remain separate decisions.
This does not resume the deferred observability expansion or change VM recovery policy.

Reuse the existing PostgreSQL Outbox, Kafka Session ingress/consumer group and
HTTP/SSE transports. The [transactional Outbox pattern](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
addresses database/event dual writes; [Kafka's partition model](https://kafka.apache.org/41/design/design/)
provides the ordering already used by PiCloud. Adding Debezium/Kafka Connect or
another state store solely for these bounded notifications would duplicate the
existing publication/ownership path. PostgreSQL remains the single control
authority and recovery source. There is no second scheduler or native writer.

## Control facts

Control changes use the physical Session key and the same fenced partition
producer as native publications and seals. A committed PG Outbox reference
authorizes control publication, including changes without an active Run.
Workers cannot publish these facts through ordinary append admission.
Control changes do not allocate native sequence, create Pi Entries or enter
model context. Runtime phase and health observations remain disposable.

Outbox rows contain bounded entity references and change identity, never Tool
output, user file bytes or full runtime snapshots. PG reads occur at control
publication admission and entity changes; ordinary view reads and Tool/probe routing use
memory. Reading a newer committed entity version coalesces obsolete notifications.
Missing/released bindings are closed, never implicitly reconstructed as open.
Duplicate/reordered change deliveries cannot reopen closed bindings.

Retain cold PG reads for bootstrap and current-state recovery. View ownership
matches the existing Kafka partition assignment; HTTP reads on another replica
route to that owner. Assignment reset closes admission to uninitialized views.
Bootstrap and concurrent invalidation must be generation checked. PG snapshots
and committed change references must cover every mutation, including deletes,
controller adoption and changes made by failure/cleanup transactions.
Retention progress may cover consumed control facts because their current state
is recoverable from PG; unsealed native prefixes retain their existing floors.

## Sandbox bindings

Bindings retain immutable VM/node/executor-boot identities. Replacement creates
a new binding; an old command is never redirected to a new VM. Registration
commits PG state and an Outbox change atomically, then confirms publication before
returning the binding to the Worker. Ordered consumption makes a separate
per-Tool projection receipt unnecessary.

Revocation also has a synchronous dispatch barrier at the current partition
owner. Commit closure in PG, install closed state at the current owner, stop the
Cube scope, and finish ordered closure. A delayed notification cannot be the only
revocation mechanism. Already admitted effects remain subject to native stopping;
an unconfirmed owner/stop leaves closure pending or quarantined, never permission
to replay effects or release quota. New owners load PG closure before dispatch.
Shared-VM quarantine must close every affected binding across Session partitions.

This replaces ADR-0210's per-Tool binding lookup only after the corresponding
closure/rebalance tests pass. PG Run/lease checks and lifecycle decisions are not
replaced with eventually consistent caches. The native commit-before-dispatch
boundary, scoped Cube fencing and Worker final-result processing stay intact.

## Queued inputs and Subagents

Queued input changes drive a bounded presentation snapshot on the Session owner
and SSE updates. Editing, ordering, promotion and Run claims retain their PG
transactions. Initial/reconnect reads recover a current snapshot; a lagging
notification cannot regress its revision. Mutations remain possible without a
Worker. Input payloads stay in their existing durable storage.

Session-local Subagent directories and Worker routes are read views. Parent/main
resolution, invocation completion and sealed results can reuse already consumed
facts. Preparation failure and cancellation before execution need PG-originated
control changes too. Canonical native messages plus projected seals determine
completed output; raw Cube replies never do. Durable command/consumption receipts,
tree-limit admission and cancellation remain PG decisions.

Pending input/Agent work uses bounded owner-local indexes and deadlines, with
startup/reassignment recovery and bounded retry/reconciliation. Removing steady
global scans must not lose wakeups, expired requests, unconsumed inputs or
progress during ownership replacement. Do not turn the memory view into another
durable work queue.

## Acceptance and rollout

- Prove zero binding SELECTs on repeated hot Tool/probe dispatch; reads remain
  measurable at changes/bootstrap and are not hidden in another per-Tool hook.
- Exercise lost publication ACK, duplicate changes, PG rollback, deletion,
  stale bootstrap, partition replacement, cancellation before delayed dispatch,
  shared-VM quarantine and unconfirmed closure. No arbitrary Tool is replayed.
- Queue presentation must work across tabs/replicas and reconnect, including
  edit/reorder/cancel/Steer and no-active-Worker transitions, without two-second
  HTTP polling.
- Subagent completion, blocked supervisor requests, input consumption, expiry,
  restart and reassignment must preserve durable outcomes without idle global
  scans. Retain the existing preparation/admission constraints.
- Use a matched drained application/log-generation cutover. Preserve native
  history and Workspace Volumes; no legacy-reader production fallback. Run the
  relevant PG/Kafka fault tests and real GPT-6 Luna acceptance, record query
  counts separately from latency, and update maintained documentation.
