# BoxLite compute provider

Status: integrated under [ADR-0313](adr/0313-alternate-runtime-production-integration.md)
and issue #27, with [production-path acceptance](reports/alternate-runtimes-20261112.md).
Independent persistence and dynamic registration are
[live-verified under #30/#31](reports/decoupling-delivery-20261113.md).
Cube remains the default; the optional node is stopped and its registration
disabled when unused.
This is an explicitly selected, single-node operator backend, not a fallback or
a new placement scheduler. BoxLite engine/SDK source is unmodified and pinned to
`@boxlite-ai/boxlite` 0.12.0.

## Boundaries

Workers and public APIs do not load the native BoxLite SDK. Resource management
and the Session Projector use a private mechanical HTTP/stream adapter. The node
uses the SDK's lifecycle, process and TCP interfaces. Shared fixed-Guest code
provides the same complete Pi Tools, admission, exact cancellation, source output
bounds and scoped HTTPS completion used on Cube. Canonical results still pass
through the Worker Harness and the Session log.

PostgreSQL and the existing resource controller own creation admission, user
intent, idle deadlines and quota. [ADR-0314](adr/0314-platform-owned-elastic-expiry.md)
supplies elastic expiry. Native AutoStop/AutoDelete are disabled; diagnostics do
not renew resources. Dedicated machines do not expire.

Workspace bytes belong to the independent persistence backend under ADR-0318.
The local XFS storage helper/Gateway initializes and deletes bytes; BoxLite uses
the SDK to mount only the guarded Workspace leaf. It does not construct a Cube
client or call Cube volume APIs. The same opaque attachment receipts and pool/
generation checks are used by Cube's supported plugin. Missing metadata is never
zero references. No second Workspace copy or archive head is introduced.
The matched adoption, Cube-unavailable public upload/capacity/lifecycle checks and
sequential Cube/Box use of the same host file inode have passed. This does not
claim a public live-migration API or distributed storage.

The node keeps bounded immutable creation/attachment connection metadata beside
native SDK state, because native Box info does not expose arbitrary creation
metadata. A lost creation reply is correlated by its original native name; a
creation is never blindly repeated. Confirmed SDK stop/removal and recorded
physical-process absence gate exact detach. The encrypted PG capsule retains
that receipt so a lost delete acknowledgement can be reconciled. Ambiguity
retains ownership and quota.

## Process and failure behavior

The trusted node Pod has KVM access, the host PID namespace and only the managed
storage/state mounts. It has no Docker socket or host-home mount. Its API holds
one private admission credential, and no Kafka, PG, S3 or model credential.
The Guest receives only an operation-scoped HTTPS completion capability.

The validated operator experiment required the stock no-jailer configuration.
The source deployment makes that choice explicit: no BoxLite VMM seccomp filter
is claimed. KVM remains the untrusted execution boundary; fixed Tools and
untrusted workflow processes use UID 1000, dropped capabilities and
no-new-privileges inside the VM. The complete node/provider deployment passed the applicable integration and
failure acceptance; this does not establish parity with a jailed host profile.

The Box container's default user is also UID/GID 1000. BoxLite automatically
maps host volume ownership to that default user; choosing root here would swap
Workspace IDs and break shared access. Infrastructure commands explicitly use
root without changing the container default. The live node check verifies host
and Guest ownership, not only the command's exit status.

The VM init process starts in `/`, independently of the image's `/workspace`
working directory, which dedicated-machine preparation removes. Tools and human
terminals select their own cwd. A missing working folder must not prevent the
native VM itself from resuming.

Supervisor manages only the node API child, allowing that process to restart
without ending its container or detached VMM children. It does not schedule
Agents, Tools or resource expiry. Full Pod or host loss is a VM-failure boundary.
Pending unsafe work is never reissued merely because its caller disappeared.

BoxLite pause uses native stop/start: persistent disks and Workspace files are
retained, but RAM and background processes are not. The refreshed Guest boot
identity is propagated through the normal environment-recovery path. Ordinary
SDK execution is forbidden on stopped resources; only management resume may
start them. Admission closes and short SDK handoffs drain before deletion, so
late control calls cannot implicitly restart a resource being removed.

Preview uses the embedded SDK's one-connection TCP tunnel, which has no published
URL or listener. BoxLite's `isPublic: false` option is for its hosted service and
is rejected by the local SDK. The adapter uses the local default and verifies no
URI was published; Pi Managed Agents' existing preview authorization still applies.

## Publication

Prepare the main matched candidate, then the optional node image using its
matching Control Plane and fixed Guest images:

```sh
node --import tsx scripts/run-boxlite-release.mjs prepare \
  PRIVATE_CANDIDATE_DIRECTORY VERSION CONTROL_IMAGE GUEST_IMAGE
node --import tsx scripts/run-boxlite-release.mjs apply PRIVATE_CANDIDATE_DIRECTORY
```

The node operator verifies image identities/scans, uses an owned state directory
and pins the Guest OCI digest. Registry TLS skipping is scoped to that private
registry with an immutable digest; no global TLS/image policy is disabled.
It records and closes new admission for this node's registered backends in PG,
requires all allocations/unresolved requests and native receipts to be retired,
and preserves unrelated Cube backends. Before native mutation a failed check can
restore unchanged prior admission; partial replacement stays drained for forward
repair. Parent/Guest image IDs and the actual installed node identity are checked.

Register the compatible node in the administration page or the versioned
[backend API](RESOURCE_BACKENDS.md). An already-open Resources page discovers it
without a restart/reload; users explicitly select its environment/profile. The
initial `PI_CLOUD_SANDBOX_PROVIDER` settings seed the first domain only and no
longer switch an established registry. There is no provider fallback. Keep the
node available while retiring its resources; missing inventory is not proof of
delete completion. Android keeps its separate existing-device semantics.

## Acceptance

Run source/PG/transport checks and image builds serially on the WSL host, then
real model Tools/images, Worker handoff to original replies, API-child restart,
Guest/VM loss, cancellation, terminal/preview, expiry and retained Workspace
checks. Keep Android device acceptance separate and serial. Compute observations
remain unconfirmed/unpriced; model and capacity billing retain their own evidence.
BoxLite currently registers allocation identity/size but has no compute-observation
collector. It therefore does not accumulate a priced compute duration. The owned
acceptance cleanup distinguishes this absent producer from pending Cube receipts,
and requires confirmed Workspace purge before discarding test registrations.
Do not infer production readiness from the earlier SDK-only experiment.

The maintained node and lifecycle checks use disposable owned fixtures:

```sh
PI_CLOUD_LIVE_BOXLITE_CHECK=1 node --import tsx scripts/run-boxlite-node-live-check.mjs PRIVATE_NODE_REPORT
PI_CLOUD_LIVE_BOXLITE_CHECK=1 node --import tsx scripts/run-live-boxlite-lifecycle-check.mjs PRIVATE_LIFECYCLE_REPORT
```

The lifecycle check advances only its own settled Session's PG idle deadline.
It verifies provider deletion and retained Workspace recovery without claiming
an actual 30-minute elapsed-time sample. Production retention policy is unchanged.
Run these serially with the existing model Tool, Worker handoff, cancellation,
browser/image and lost-reply acceptance scripts.
