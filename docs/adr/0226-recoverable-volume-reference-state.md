# ADR-0226: Recoverable Cube Volume reference state

Status: implemented and deployed, 2026-10-05.
[Verification and matched release](../reports/review-repair-20261005.md).

R04-03 loses Master reference bookkeeping when physical deletion succeeds but
its allocation reply cannot be persisted. Keeping replies longer cannot recover
the first failed write. The owner approved state-based reconciliation with
shared-volume and concurrent-attachment protection.

## Reuse and ownership

Reviewed the pinned Cube v0.6.0 source, Apache-2.0 license and native plugin
reference store, Master Volume model and attach/detach/delete paths. Reuse its
per-volume lock, persistent node holder set, existing Bolt/MySQL and fixed
allocation catalog. Workspace bytes remain on the adopted persistent Volume.

The maintained Apache-2.0 [Kubernetes CSI external-attacher](https://github.com/kubernetes-csi/external-attacher)
watches VolumeAttachment desired state and reconciles CSI controller calls,
including timeouts and periodic resync. [VolumeAttachment](https://kubernetes.io/docs/reference/kubernetes-api/storage/volume-attachment-v1/)
separates attach/detach intent from execution status. Adopting the sidecar here
would require a new Cube CSI driver and Kubernetes storage authority for VM
attachments which currently belong to Cube; it would not supply the missing
node detach evidence. Retain a bounded Cube adapter and its failure tests instead
of adding another controller service, broker or PG Tool ledger. This decision
amends ADR-0223's reply-based managed Volume bookkeeping.

## Contract

Master records a managed allocation's Volume holds before its first node Create,
in the same placement transaction. The native Volume row identity distinguishes
successive lifetimes with the same public name. A deleting Volume refuses new
holds. Pending creates count as holds until irreversible allocation closure and
exact-node VM absence. A stale request cannot bypass the allocation closure.

Cubelet exposes a bounded reference-state query under the existing per-volume
lock. State includes the durable reference-store incarnation, monotonic revision,
holders/count and confirmed detach status. Node restart retains the incarnation;
lost/recreated metadata changes it and cannot erase a previously recorded hold.
Zero count alone is not a detach receipt. Persist unfinished detach identity and
plugin metadata before the physical hook; retry that idempotent cleanup before
reporting confirmed zero or allowing a conflicting attach. Unknown recovery
state remains held. The supported PiCloud POSIX plugin has an idempotent no-op
detach; this does not claim arbitrary third-party plugin recovery.

Master materializes the newest reference state per Volume/node. Repeated or
out-of-order replies cannot add/subtract counts or replace a newer state. VM
absence and Volume bookkeeping are independent: missing Volume evidence cannot
fabricate an absent VM, while an absent VM's quota need not wait for Volume GC.
Volume deletion first closes attachment admission, waits for existing allocation
holds, and refreshes all recorded node states. Unreachable nodes, changed store
incarnations or uncertain detach prevent deletion. Historical untracked state
cannot be repaired by a guessed zero count.

Use current create/close responses as opportunities to refresh state and the
existing Volume deletion retry path to complete missed refreshes. Queries do
not execute arbitrary shell work. Persisted pending detach belongs solely to
Cube's physical Volume lifecycle. Allocation receipt GC cannot remove the
Volume/node identity needed for a later refresh. Zero-state records may be
collected only while preserving the store revision/incarnation fence; state is
bounded by Volume/node lifetimes, not historical Tools.

## Cutover and acceptance

Replace managed reference deltas, without a legacy managed fallback. Apply
additive Cube metadata migration and matching native/application protocol
versions after draining; preserve PG sessions, Workspace bytes and historical
UNKNOWN allocations. Old allocations lacking recoverable Volume/node evidence
remain conservative. Rollback requires a drained matched metadata/binary restore.

Test real Bolt/MySQL, lost first cleanup receipt, detach-state write failure,
duplicate/old state, node restart/store replacement, shared VM holders, concurrent
new admission versus Volume deletion, pending creation, receipt GC and unrelated
Volume isolation. Require real paused VM, shared Volume, Luna and image acceptance.
