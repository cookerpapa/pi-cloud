# ADR-0318: Workspace persistence independent of native compute

Date: 2026-11-12. Status: accepted; implemented and live-verified on 2026-11-13. Tracking: #30.

## Authority and supported implementations

Workspace persistence is a Pi Managed Agents port, not a requirement that every
sandbox implement Cube Volumes. Its capabilities distinguish independent volumes,
provider-retained sandboxes and temporary filesystems. A retained-sandbox adapter
must preserve files through its native stop/pause operation and cannot advertise
shared/new-sandbox attachment without evidence. No hosted vendor is enabled here.

The first concrete implementation retains the existing local XFS bytes and
generation/attachment guards. PG owns Workspace initialization/deletion intent;
the existing trusted storage helper owns physical initialization and deletion,
beside kernel capacity enforcement. The Volume Gateway exposes the typed storage
port and file operations. It does not execute user programs. Native compute
clients no longer own Workspace creation/deletion.

Cube's supported plugin becomes a mount/registration adapter: Create verifies
already-provisioned storage; native Destroy retires its registration but does not
delete Workspace bytes. Attach/Detach retain exact opaque holds and the shared
deletion lock. BoxLite uses the same guarded attachment contract directly, without
a Cube API dependency. Root storage deletion checks the existing deletion marker,
exact generation and zero unresolved holds before removing bytes; the Gateway
finishes its envelope and quota cleanup. No native engine patch is introduced.

## Initialization and placement

Record bounded initialization state and generation on the existing Workspace row.
An uninitialized Workspace claims one initialization send in PG with its exact
generation. An initializing Workspace only inspects the original operation; it
does not resend an uncertain create. Inspection is serialized with physical
initialization, so a positive ready observation follows its completed file effects.
A ready Workspace whose storage disappears is unavailable, never recreated empty.
Unknown initialization blocks deletion until reconciled; use existing resource
maintenance/admission paths and cold operator proof, not a scheduler or permanent
closed-volume tombstone service. The physical operation accepts exact idempotent
requests, but this does not authorize automatic uncertain sends after deletion.

The storage helper verifies the actual pool/mount identity. Persist a pool marker
for native mount adapters; per-volume metadata and mount preparation must match
that identity. A directory with the same name on another node is insufficient.
Local storage remains local; unsupported node placement fails explicitly. No
cross-node replication or HA is claimed. Network storage requires separate backend
selection and acceptance, including its own locking and capacity semantics.

## Cutover

Drain Writers, uploads and physical attachments using the maintained operator.
Adopt existing volume generations/pool identity under quiescence without changing
user files. An ambiguous/missing previously initialized volume remains unresolved.
After installing the new supported plugin, retire old managed native registrations
through ordinary Cube APIs without deleting their bytes; recreate registrations
only when a new Cube allocation actually needs them. Preserve accounts, provider
configuration, credentials, originals and device userdata. No old-mode fallback.

## Validation

Prove initialization identity/retry, missing-known storage, wrong pool, attach vs
delete, stale/exact detach, root-owned file cleanup and quota behavior. With Cube
unavailable, BoxLite must complete Workspace creation/upload, VM replacement,
retained-file reads and explicit deletion. Sequential provider reuse preserves
bytes and ownership. Android userdata is not converted to a Linux Workspace.

Reuse the existing storage helper/Gateway and native Volume/SDK mechanisms.
CSI's create/publish/unpublish/delete and topology vocabulary informs the port;
no CSI engine, second storage catalog, archive head or new distributed filesystem
is introduced. The build-versus-adopt evidence remains ADR-0301, ADR-0309 and #30.

Implementation and measured limits: [November 13 delivery](../reports/decoupling-delivery-20261113.md).
