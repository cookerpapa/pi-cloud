# ADR-0223: Recoverable VM allocation and irreversible closure

Status: implemented and deployed, 2026-10-04.
[Verification and matched release](../reports/vm-allocation-20261004.md).

## Scope and authority

Extend the existing physical VM lifecycle. A stable allocation identity must
resolve creation after a lost reply and remain closed after retirement, including
a delayed Create that arrives after Close. PostgreSQL and Sandbox Controller
remain the product intent/ownership authority; Cube owns physical placement and
accepted allocation execution. Pi, native Session history, Tool dispatch and
Workspace byte ownership do not change. VM recovery never replays an Agent Run
or arbitrary shell work.

The current pinned Cube v0.6.0 source (`8721dd151971ce3c2966482bbd32904ad98f378e`)
generates the VM ID at the node and persists its Master sandbox spec only after
success, best-effort. PiCloud persists its allocation before materialization,
but a failed RPC can leave no recoverable VM/node mapping. Master currently
permits rescheduling after an uncertain Cubelet Create. Those contracts are
insufficient for managed PiCloud allocations.

## Adopt before build

Reviewed primary documentation/source, releases and licenses on 2026-10-04:

- [AWS idempotent API design](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
  covers response loss, late creation after deletion, changed parameters and
  bounded idempotency retention. Adopt stable caller identity and immutable
  request parameters; this design reference is not an added runtime dependency.
- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
  and [finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
  separate desired state from observations and retain management records through
  external cleanup. Kubernetes is already deployed. Its Apache-2.0
  [controller utilities](https://github.com/kubernetes-sigs/controller-runtime/blob/main/pkg/controller/controllerutil/controllerutil.go)
  require Kubernetes API authority; adding an Operator would move VM ownership
  from PG rather than fix Cube's uncertain physical API boundary.
- [Crossplane](https://github.com/crossplane/crossplane) is Apache-2.0 and actively
  maintained ([releases](https://github.com/crossplane/crossplane/releases),
  current documentation v2.4). Its
  [creation tracking](https://docs.crossplane.io/latest/managed-resources/managed-resources/#creation-annotations)
  explicitly retains uncertainty when an external ID was not recorded; it cannot
  supply an external provider's missing idempotency/identity contract. Adopting it
  would require a Cube provider and replacement of our existing VM controller.
- [Cube v0.6.0](https://docs.cubesandbox.com/blog/posts/2026-07-24-cubesandbox-v0.6.0-release)
  is the already adopted Apache-2.0 runtime. Retain its scheduler, native create/
  destroy workflows, MySQL metadata and node metadata, behind `SandboxProvider`.

Keep a bounded allocation adapter in Cube instead of a second resource scheduler,
queue, database service or K8s/PG dual authority. Native changes remain a pinned
patch with contract, persistence and failure tests. Normal creation may still
wait synchronously; queries and reconciliation resolve interrupted requests.

## Allocation contract

PG issues and persists one create authorization for the physical allocation,
including an immutable creation deadline. Retries reuse it. They cannot extend
the authorization or assign a second node after uncertain acceptance. A newly
requested physical lifetime receives a new allocation ID. Existing development
machine pause/resume is not deletion and retains its current lifetime.

The authorization has a five-minute initial creation window. Cubelet placement
also records its boot identity before dispatch; an old Create cannot start on a
new node incarnation even if its journal is missing. Complete original receipts
remain queryable after the creation window. Confirmed closed receipts can be
collected one hour after that window; durable clock floors prevent backward
clock steps from making collected authorizations valid again. Clock divergence
fails new admission conservatively and remains an operator concern.

PG retains the bounded, immutable creation configuration on the existing
Workspace runtime, development environment or independently allocated terminal
resource. It contains infrastructure configuration, not model payloads or
Workspace bytes, and permits recovery before a runtime capsule exists. Closing
sets an irreversible flag and lifecycle state in the same owned transaction.
Startup capability probes retain their existing short-lived diagnostic lifetime;
they also have a unique Cube allocation identity and Close in their cleanup path.

Cube durably admits the identity and request fingerprint before invoking a node.
Placement fixes a VM ID and node under that record before any creation RPC. A
duplicate Create returns the original progress/result; different parameters
conflict. DB unavailability prevents new physical effects. The mutable route
cache is not the allocation catalog. Querying an allocation works independently
of whether normal sandbox inventory/routing has finished publishing it.

The node admits managed creation under the same allocation identity and fixed VM
ID. Its durable receipt precedes the native create workflow. Duplicate RPCs do
not launch another workflow; an interrupted node incarnation never silently
re-executes a partially completed creation. Original results remain queryable;
unrecoverable partial execution retains UNKNOWN with its physical identity.
The declarative Cube renderer sets the existing Bolt metadata plugin's `no_sync`
to `false`; upstream's throughput-oriented default is insufficient for admission
receipts. Node startup refuses asynchronous metadata. This adds synchronous
metadata writes at physical lifecycle boundaries and must be measured at scale.

Close is irreversible for that allocation and idempotent. Persist closure before
waiting for physical cleanup. Creation and closure share the node's allocation
admission/lifecycle boundary. A create not yet admitted is rejected; an already
admitted create must finish or be joined/cancelled before absence can be confirmed.
Native failure cleanup cannot race a second creation of the same identity.
An absence response requires both closed creation admission and confirmed absence
on the recorded node. A missing Master route, heartbeat or in-memory handle is
never enough. An unplaced allocation can close atomically without contacting a
node because no physical create was authorized.

Compact terminal receipts have explicit retention tied to the immutable creation
authorization. Expired create requests must be rejected even after receipt GC;
active, uncertain or incompletely closed allocations must not be collected.
Clock/restart behavior is part of that contract. Do not restore a lifetime
in-memory closed-ID set or a global capacity-exhaustion latch.

## PiCloud integration and recovery

Keep creation/cleanup policy in Sandbox Controller and transport/mechanics in
`SandboxProvider`. Persist authorization before calling Cube. On a lost create
reply, query the same allocation and adopt only its exact matching result after
normal Guest/environment verification. If creation remains uncertain, retain
identity and resources for the existing recovery loop. No replacement VM is
admitted on the assumption that the first does not exist.

Record cleanup intent before Close. Recovery after controller replacement resumes
the same intent, including allocations which never produced a runtime capsule.
Successful closure is the release prerequisite; temporary transport failures keep
the existing retry path. Existing capsule-backed running VM adoption remains
intact. Human terminals and dedicated machines use the same physical contract.

Historical UNKNOWN allocations lacking the new authorization cannot be magically
reconstructed. Preserve them until independently verified; do not fabricate
identity or bulk-delete uncertain records. No old creation transport fallback is
maintained for new PiCloud allocations.

## Acceptance and cutover

Require concurrent same-ID creates, changed-parameter rejection, missing/lost
replies before and after node admission, restart after durable intent, Close
before Create, Close while native creation is in flight, old Create after Close,
node loss, expiry/receipt GC, unrelated allocation isolation and no automatic
shell replay. Test the real metadata adapters, not only in-memory mocks.

Deploy matching native Cube/API/client versions after draining executions and
checking physical VM inventory; preserve business data and Workspace Volumes.
Rollback requires a drained matched native/application/database restore, not mixed
protocols. Demonstrate normal Luna Tool execution, dedicated-machine lifecycle,
lost-create-reply recovery and delayed-create closure on real Cube. Document the
tested topology and unresolved physical-node recovery limits.
