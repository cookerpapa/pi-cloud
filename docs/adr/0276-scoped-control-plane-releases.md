# ADR-0276: Scoped Control Plane releases

Status: accepted; implementation in progress.
Date: 2026-10-25.

## Scope and reuse

The owner approved narrower releases and explicitly excluded browser update
notifications. Extend ADR-0267's existing operator with a `control-plane` scope.
Keep Helm/Kubernetes, immutable image evidence and the existing release lock;
do not add a deployment service, plugin loader, workflow engine or version router.
The initial scope covers code-owned ordinary Tool definitions/implementations and
their registration module. Ownership, lifecycle, storage, transport, dependency,
chart and native Pi changes retain matched release. A file classification is an
admission constraint, not proof of semantic compatibility; review and contract
tests remain required.

Reuse [Helm upgrade](https://v3.helm.sh/docs/helm/helm_upgrade/) with retained
values and disabled hooks, and Kubernetes' existing
[Pod termination lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/).
Neither knows whether a non-replayable image request is waiting for a reply, so
a bounded application quiescence port is necessary. No infrastructure product
can supply that PiCloud-specific completion predicate from Pod readiness alone.

## Publication boundary

Prepare/build/scan one Control Plane image; retain every other component's exact
provenance. Preflight verifies source scope, dependency inputs, installed baseline,
image evidence and the complete rendered manifest. The only allowed Kubernetes
change is the Control Plane container image. No migration hook, Worker drain,
Cube reconciliation, template registration, VM retirement or data reset runs.
The first installation of the quiescence contract uses the maintained matched
procedure. Later scoped operations require that contract; no old-binary fallback.

The supported first slice is a single Control Plane with no autoscaler. Import
the prepared image before disruption. Acquire an expiring local quiescence hold,
stop the exact old Pod, wait for its existing PG sandbox-owner lease to close or
expire, then apply the new image and restore the declared replica count. A new
Control Plane adopts retained VMs and Workers reconnect through their existing
management paths. Kafka buffers new records during the short outage. Worker
Session leases, producer identity, running Cube tools and VM identity stay intact
when replacement completes within existing recovery budgets. This is not zero
downtime or an extended execution lease.

## Quiescence, without another execution authority

An authenticated internal operation on the existing publication HTTP service
arms a process-local hold. Projection continues while Control Plane handlers or
non-replayable replies are outstanding. Successful reply publication alone is
insufficient: wait until native Task settlement/closure has been projected.
Repeatable child waits do not require the child or root Run to finish.

At a boundary with no active projection, no executing Control Tool and no
unsettled non-replayable effect, atomically hold admission before the next record
can materialize PG state or commit dispatch progress. Assignment recovery uses
the same gate, and dispatcher timers cannot start new work while held. This avoids
both losing an admitted effect and recovering a deliberately unadmitted effect as
UNKNOWN. Existing generation checks still govern rebalances and closure.

The hold is keyed to the operator's request and process incarnation. It carries
no execution authorization, changes no Kafka/PG ownership and allocates no new
lease or durable queue. Cancellation or expiry resumes the old process. Timeout
leaves the serving version in place; it never kills a still-running image call
merely to meet a release deadline. Shutdown rejects parked records so Kafka cannot
acknowledge work that never ran. Unexpected process loss retains existing UNKNOWN
semantics; no exact-once external effect or durable result cache is claimed.
SIGTERM repeats the same quiescence check at actual process termination, so a
delayed Kubernetes scale cannot rely on an expired earlier hold. The existing
Pod termination grace remains the outer failure boundary; forced process loss
does not acquire successful Tool semantics.

## Failure handling and acceptance

Record replacement phases before changing replicas. Before Helm mutation,
failure restores the observed old Deployment, provided its identity/template
still match. After Helm begins, reconcile the actual release and resume the same
candidate; do not blindly roll back or overwrite another operator. A process
crash may require rerunning the candidate. Local holds expire independently.

Verify busy handlers, reply delivery and native settlement; cancellation, expiry,
shutdown and a parked unprojected record; assignment recovery; forbidden source/
manifest changes; interrupted replacement and candidate reconciliation. Live
acceptance replaces only the Control Plane during a real Luna/Cube Run and checks
unchanged Worker boots, Session lease/writer and VM allocation, continued native
execution and ordinary catalog visibility at the next model request. Confirm
physical fixture cleanup and preservation of existing user assets.
