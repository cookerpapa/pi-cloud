# ADR-0265: Preserve and reconcile stale Volume holders

Status: accepted implementation decision under the owner-approved repair plan,
2026-10-20. Extends ADR-0226; deployed in `resource-repair-1cdccb80`, 2026-10-21.
Native loss/race contracts and owned node-restart/Volume cleanup pass in the
[delivery record](../reports/resource-interaction-repair-20261020.md).

## Evidence and adoption

The pinned Apache-2.0 Cube reference store removes holder IDs on startup when
StorageInfo is missing. Our existing patch then marks the Volume unknown, but
has already discarded the identity needed to check and detach that holder.

Checked upstream [v0.7.3 release](https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.7.3)
and its [reference implementation](https://github.com/TencentCloud/CubeSandbox/blob/v0.7.3/Cubelet/plugins/volume/refcount/store.go),
plus the current master file on 2026-10-20. They still discard missing holders
and delete zero-count records; they do not provide the required retained evidence
or versioned physical cleanup. Reuse the existing Bolt store, per-Volume lock,
allocation admission closure, exact-node Observe and idempotent POSIX plugin.
Introducing another controller or storage authority would not supply that evidence.

## Decision

Startup marks missing holders as needing reconciliation, preserving their IDs
and conservative count in the existing Volume record. An unresolved holder
keeps reference state unconfirmed and prevents new attachment. Surviving holders
may detach normally; their IDs are never discarded by the missing-holder scan.
Existing unknown records whose lost identities are unavailable remain unresolved.

The existing reference observation RPC reconciles recorded stale holders under
the same Volume lock. For the supported `picloud-posix` driver, it requires the
original node's durable allocation to be closed and physically absent, then
rechecks exact Sandbox absence through native Observe (metadata, container and
task checks). It never initiates allocation closure or destroys a VM. Missing
allocation metadata, missing runtime evidence, changed stores or unavailable
nodes cannot authorize reconciliation.

Only after proof does BeginDetach atomically move that holder to the existing
pending-detach record. The fixed POSIX detach needs only the recorded identity;
it neither deletes Workspace bytes nor requires success-only Attach metadata.
Finish the hook and durable receipt before confirming reference state. Repeated
restart or failed receipt retries this same pending identity. Other plugin
drivers require their own evidence/metadata contract and are not silently adopted.

Allocation receipt collection retains a closed allocation while the same node
reference store still names its Sandbox, including pending detaches. Collection
checks this in the same Bolt transaction; unrelated expired receipts still
progress. This is a reference-lifetime rule, not another result ledger.

Reference-store incarnation/revision and Master reconciliation remain unchanged.
VM quota release still depends on VM absence; Volume deletion additionally waits
for confirmed reference state and closed attachment admission. A transport
timeout or zero count never substitutes for either condition.

## Acceptance and release

Native race tests cover a lost last holder, shared survivors, repeated restart,
late attachment, interrupted detach/receipt, changed metadata, missing evidence,
receipt retention/collection and unrelated Volume progress. Existing Master
version/admission tests continue to run. A matched Cube build and an owned live
KVM restart/cleanup case are required before declaring deployed completion.
Old unrecoverable unknown state is not erased to make a test pass.
