# ADR-0302: Separate Session runtime from resource management

Date: 2026-11-07
Status: Accepted for implementation; matched acceptance pending

## Context and acceptance

Issue #9 requires management outages to leave already-owned Sessions usable.
Moving only Kafka consumption leaves hidden dependencies in authentication,
observations, workflow host calls, image/Skill preparation and Cube retention.
The existing resource-owner lease must not become the execution data-path lease.

Acceptance is an already-owned native family with a valid binding continuing
commits, PG projection, fixed/control/workflow Tools, keepalive and HTTP/SSE while
resource management is stopped. Authenticated cold history and cost statements
must remain readable. New resource allocation and physical recovery may wait for
management. No second Projector group, Session writer or shell replay is allowed.

## Decision

The `session-runtime` API endpoint runs the Session runtime. It owns the
single Session Projector group, public authentication/API/history/statements,
HTTP observations/SSE, Worker registration/catalog transport, ordered control
publication, native child/control Tools and execution on admitted Cube bindings.
Its readiness depends on its own PG/Kafka paths, not management uptime.
Worker membership remains beside execution; this slice leaves lease predicates
and renewal/revocation timing unchanged (Issue #10 evaluates them separately).

A separate `control-plane` management process owns `SandboxController`, its PG resource
owner lease, VM admission/recovery/release, Volume cleanup and resource maintenance.
The same immutable host image supplies distinct entrypoints. It never constructs
a Projector or native/control Tool dispatcher. Existing HTTP lifecycle requests
remain bounded and fail explicitly if this controller is unavailable. Scheduled
and source-control admission and attachment reclamation run only in management.

A binding carries encrypted, immutable Cube data-channel metadata for its exact
physical allocation/node/boot. Session runtime may open this existing data channel
without adopting resource ownership, creating/resuming a VM, renewing a PG lease,
or consulting management. Fixed Tools retain Cubelet boot/ordered-position fencing;
workflow/Skill/image operations retain capability/context checks and the partition
owner's prepared binding revocation. Provider data handles are disposable caches.
They do not replace the allocation journal or prove physical health/absence.
Normal Session release closes PG routing and retains the immutable cleanup target;
management reconciles that closed binding without deleting shared/background
processes or releasing VM/Volume quota from routing closure alone.

Workflow channels live with the partition that committed dispatch. A private
attachment relay routes a Worker's existing duplex host-call connection to that
owner; it grants no new authority. Rebalance/shutdown closes those in-memory
channels and reports uncertainty; it never reruns an accepted workflow. Scoped
replacement quiescence includes in-flight bound operations and workflow replies,
and the attachment relay refuses a second forwarding hop.

Typed keepalive continues directly from the same Projector to Cubelet. Missing
management or probes cannot expire a PG Session lease or release compute/storage
quota. New VM activation, replacement, deliberate pause/release and lifecycle
reconciliation require management and the existing physical-absence rules.
Public APIs may durably accept new Run/configuration intent during an outage;
this does not promise execution without registered Workers and usable resources.

## Build versus adopt and tradeoffs

This is process composition of the already adopted Kafka, PostgreSQL, Cube and
Fastify adapters. It adds no queue, scheduler, event store, storage protocol or
cluster layer. Reusing one Projector group is essential: a separate Tool/live
consumer would reintroduce competing dispatch/replay authorities.

The Session API still shares a failure domain with projection and execution-side
control handlers. Isolating those further needs measured pressure and a separate
decision. Public resource APIs can report intent while lifecycle work is pending;
there is no false claim of a successful physical change during a management outage.

## Delivery and rollback

Ship both entrypoints, deployment/services, routing and the matching binding
transport together after writer drain. Preserve accounts, credentials, Volumes,
allocation identities and cleanup intent. No old combined production mode is
retained. Rollback requires the existing matched writer drain and a matching
artifact set; it must not discard ownership records before physical cleanup.
The public ordinary-tool release scope is `session-runtime`; the obsolete
`control-plane` scope and helper/check names are removed. One scanned host
artifact expands to three independent role records on matched publication.
Scoped publication changes only the Session role and verifies the exact live
management/metering image bindings. Its replacement journal waits on quiescence
and old Session Pod absence, never the unrelated resource-owner lease.

Tests must cover route/capability refusal, closed bindings, data-only restart,
management-off execution/read availability, cancellation and partition changes.
Source checks and live evidence are recorded separately in the backlog.
