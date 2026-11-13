# ADR-0319: Dynamic resource backends using the existing resource authority

Date: 2026-11-12. Status: accepted for implementation. Tracking: #31, #36.

## Decision

Extend `sandbox_domains`, not the Worker or a new scheduler. Each backend has a
stable identity, revision, public location/template/profile catalog and encrypted
private adapter configuration. The existing resource-management role validates
and commits administrator changes. The public API authorizes and relays those
changes; it does not receive a persistent-state key or instantiate native clients.
Registry reads exposed to users omit endpoints, credentials and connection receipts.

The resource manager instantiates one existing lifecycle controller/ownership
scope per registered Linux backend behind its existing listener. Known Cube and
BoxLite adapters are configuration, not dynamically loaded code. Registry
notifications are hints; bounded revision reconciliation also runs on reconnect
and missed notifications. A failed new backend cannot retire unrelated owners.

Session execution loads only data clients and fixed-Guest transport. Bound
operations select an already-loaded client by the exact immutable endpoint in
their binding/capsule. Cold directory loading is permitted; ordinary Tool dispatch
does not query the registry or Worker leases. Native endpoint identity is unique
within the registry. No arbitrary endpoint obtained from model output is used.

The existing ownership leases, PG allocation admission, Kafka binding updates,
original completion targets and attachment holds remain. Resource requests record
the selected backend/template. Templates describe a supported fixed Guest and
offered profiles, not arbitrary images assumed compatible with the runtime.

## Mutation boundary

New backend registration does not restart any existing process. Compatible
template additions preserve earlier template definitions. Changing an endpoint,
credential or storage identity requires the affected backend to have no retained
resource/Workspace users or unresolved allocations. An existing template can be
replaced under verified physical quiescence while retaining Workspace bytes;
matched Guest upgrades use that boundary, not a registry bypass.
Disabling a backend blocks new allocations, while existing resources keep their
management and data paths. Removal is logical retirement, not deletion of its
resources or evidence. Re-enabling performs validation again. The initial version
does not promise moving live allocations to a new native endpoint.

The initial configured backend is bootstrapped into PG once. Subsequent startup
must not overwrite administrator revisions from deployment environment variables.
The Web catalog refreshes while open, including when no machines exist, and on
visibility/reconnect. UI availability is advisory; the creation transaction locks
and rechecks the selected current backend/template/profile.

## Provider and storage limits

ADR-0318 owns persistence. A local pool identifier must match its storage endpoint
and native mount; registration creates no cross-node replication or VPN. Cube and
BoxLite use unchanged upstream engines. Android retains its existing device-target
registration and device capabilities; no Linux Workspace or self-service emulator
pool is invented. A genuinely new vendor protocol needs a code-owned adapter and
its acceptance, independently of registering another installed adapter instance.

Device registration is an administrator operation with an explicit destination
organization: `{ tenantId, device: { targetId, name, endpoint } }`. The API must
not substitute the administrator's own tenant. Management verifies the real
executor and retains its existing tenant ownership on retries; a conflicting
owner is rejected. Ordinary users still list and bind only their own tenant's
devices. Registration creates no new emulator or device-sharing scheduler.

## Evidence and acceptance

Reuse PG rows/notifications, existing native adapters and lifecycle controllers.
Kubernetes/CSI-style stable resource identity and reconciled desired state inform
the directory; a new service-discovery cluster, scheduler or plug-in loader would
add competing ownership without solving a measured gap.

Verify idempotent registration, revision conflicts, disabled admission, missed
notifications, wrong protocol/pool and credential failures. Keep a real Session,
writer and original resource running while adding BoxLite; the already-open Web
page must offer it without Pod replacement. Complete a new resource's real Tool
and cleanup path serially, preserve original files/device data, and report hosted
and multi-node limits separately from the local acceptance.
