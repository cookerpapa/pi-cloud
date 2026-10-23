# ADR-0273: Resource intent and dedicated-machine recovery

Status: implemented; source checks passed, matched delivery and live verification pending.
Date: 2026-10-23.

## Decision

PostgreSQL owns resource intent, ownership, binding admission and unfinished
lifecycle operations. Cube owns actual VM state. Disposable observations remain
in controller memory; neither heartbeat samples nor a mirror of Cube inventory
are a PostgreSQL authority. Lifecycle management calls Cube directly through
SandboxProvider. Only changes to Session Tool bindings use the existing ordered
Kafka control-reference path.

A dedicated development machine has a stable business ID and desired state
(`running`, `paused`, `released`). Each physical allocation has a different UUID.
The existing machine row keeps the current allocation, its frozen creation
authorization, reconnect capsule and confirmed closure. A new allocation can
replace those fields only after the old allocation is durably closed and physical
absence is confirmed. Closed Cube identities are never reopened. No allocation
history table, scheduler, queue or second resource authority is added.

Machine lifecycle phase records work, not observed VM health: admission,
provisioning, settled intent, reconciliation, release and confirmed termination.
Intent revisions fence late acknowledgements. User actions commit desired state
and their idempotency receipt before Cube calls. Reconciliation and user actions
serialize per machine, recheck current PG ownership/intent at effect boundaries,
and never apply an older result to a newer allocation. User pause/release prevents
automatic start. A missing response is not completion.

The existing controller recovery loop adopts live allocations, resumes paused
allocations only when running is desired, and replaces positively stopped/absent
allocations after revoking bindings and confirming old physical cleanup. Unknown
observations retain the old identity and retry. Completed shell commands are not
replayed. A new physical runtime enters the existing environment continuity and
World State path. Persistent Volume bytes survive; root-disk modifications and
process memory are not promised across cold replacement. Pause/resume retains
Cube's existing snapshot contract.

Elastic compute remains demand-created. Its allocated/unallocated lifecycle is
separate from whether bindings currently use it; Cube owns finite idle expiry
under ADR-0272. Observing expiry closes the old control record, never initiates
replacement without new demand. Terminal and Tool binding reservations retain
their own admission roles. Binding mutation, cleanup and lifecycle transactions
retain PG locks; ordinary Tool routing adds no PG query.

Resource presentation combines lifecycle intent/progress with current-owner
observations. After controller replacement, observation is unavailable until
adoption; an old PG completion cannot claim a VM is still running. Paused,
recovering, unavailable and released conditions have distinct user messages.

## Adopt-before-build evidence

Reuse the [Kubernetes controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/)
inside the existing resource controller. Adding Kubernetes custom resources or
another workflow system would duplicate the already authoritative PG resources
and Cube allocation journal. No new framework or lifecycle engine is required.

[Cube lifecycle documentation](https://docs.cubesandbox.com/guide/lifecycle)
distinguishes pause/resume from terminated instances. The pinned Apache-2.0
source `8721dd151971ce3c2966482bbd32904ad98f378e`,
`Cubelet/services/cubebox/update.go:UpdateWithResume`, rejects exited instances;
its restart code recovers metadata, not arbitrary dead process memory. Reuse
existing create/connect/observation/allocation-close APIs and ADR-0223's managed
allocation journal. No Cube protocol extension is needed for this decision.

## Delivery and acceptance

Use a matched application/schema upgrade, preserving accounts, configuration,
credentials, conversation history and the existing dedicated Workspace. Drain
writers and confirm old physical cleanup before discarding any ownership.
Remove superseded state paths, without runtime compatibility aliases.

Required cases include: lost creation reply and controller restart; intent
commit before crash; pause preserved across restart; stale action/result rejected;
stopped VM replaced with a different allocation and the same Workspace; unknown
node never authorizing replacement; explicit release never recreating a machine;
elastic expiry without automatic restart; unchanged Tool hot-path queries;
resource UI observation after adoption; confirmed fixture cleanup. Relevant
native/Cube, browser, migration, fault and matched-release gates remain required.

Source verification covers all 22 workspace suites, 368 fault cases, isolated RF3,
native Cube contracts and the required static/audit gates. The initial protocol
and Web fixtures were updated for required desiredState. An initial isolated
Kafka topic-creation failure passed an unchanged repeat. Live acceptance remains
a separate deployment gate.
