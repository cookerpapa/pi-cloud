# ADR-0304: Cold compute retirement for matched maintenance

Status: accepted; deployed and verified on 2026-11-07.
Date: 2026-11-07. Scope: Issues #6 and #8.

## Decision

A matched native-runtime or Workspace filesystem replacement may retire compute
while preserving the stable development machine, its desired running/paused
intent and its persistent Workspace. User Release is unsuitable: its authorized
meaning includes Workspace deletion. This operator never releases a Workspace,
changes user intent, creates a VM, or operates containerd/processes directly.

Reuse ADR-0223's native allocation close and ADR-0273's existing PG ownership and
recovery fields. The operator is a cold maintenance client of those authorities,
not another scheduler, controller lease, lifecycle table or runtime mode. No
additional infrastructure adoption is needed: the existing native allocation
journal already fences delayed creates and confirms recorded-node absence.

The release owner first drains Runs, ordered writer closure, bindings and human
terminals, stops admission/Worker/management/file-gateway processes, and waits for
their recorded owner leases to expire. The operator verifies installed workload
replicas and Pod absence, plus PG Run/seal/lease/binding/terminal/owner predicates,
before every effect boundary. Process absence grants no physical-VM absence.

For each exact existing allocation, a short guarded PG transaction first sets
`allocation_closed=true` and the existing cleanup phase (`reconciling` for a
machine, `cleaning` for elastic compute). It preserves the frozen creation
authorization, runtime/capsule and owner identity. Native close uses only that
allocation UUID and original creation deadline. A recorded capsule/placement node
must agree with the native receipt; its explicit observation must confirm absence.
Unknown, missing routing, errors and cancellation retain the cleanup target.
An authorization that PG proves was never issued needs no native destruction.

Only after positive closure does a second guarded compare-and-swap clear physical
runtime/capsule/holder fields. Machine rows retain stable ID, Workspace, allocation
UUID, generation, frozen creation fields, intent revision and desired state. They
become `reconciling`, `allocation_closed=true`, `allocation_absent=true`, with no
failure code. The exact expired owner reference remains: the existing PG shape
requires it, and recovery already claims rows whose owner is expired/lost. This
reference is not a renewed controller lease. Unowned, unissued requested machines
remain outside this operator's scope and cause preflight refusal rather than an
invented owner. Elastic rows become `released`. Existing HTTP-service
views for that exact retired runtime are ended in the same transaction. The
operator never deletes ownership rows or alters Workspace/account/credential data.
An identity/intent/owner change rejects a stale operator before it can overwrite
the newer allocation. Lost PG/native acknowledgements recover through the same
rows and idempotent native close; no external Tool is replayed.

## Recovery and presentation

The existing manager claims desired-running `reconciling` machines and replaces
only their closed, confirmed-absent allocation with a fresh UUID. It preserves
the stable machine/Workspace and advances the existing generation. Desired-paused
plus confirmed absence is already excluded from automatic recovery. Resume commits
desired running and a new intent revision; the ordinary recovery path then creates
the replacement. No maintenance-only start path is added.

The current API displays the running case as recovering. A deliberately paused
machine whose old VM was retired displays unavailable/unknown with Resume still
available, rather than a false failure or a claim that a suspended VM still exists.
Process memory and disposable system-disk state do not survive compute retirement.
Persistent Workspace bytes do. The matched drain predicate must require the exact
closed/absent/null-runtime/null-capsule/no-holder shape before accepting this phase.

## First cutover and acceptance

The first serving installation has the combined Control Plane. The target has a
separate Session Runtime. The cold operator inventories actual installed labeled
workloads and requires every installed admission/runtime component to be stopped;
an uninstalled Session Runtime is not an alias for a serving Control Plane. It uses
the unchanged allocation close/recorded-node observation interfaces, not guest Tool
capabilities or a legacy execution implementation. No old runtime mode survives.

Port-driven tests cover closure-before-effect, unknown/present/mismatched nodes,
lost close/PG replies, cancellation, late allocation/intent changes, cold gates,
unchanged machine/Workspace intent, and the exact retained drain predicate. The
maintained operator has inspect/apply entry points and emits only bounded identity
and progress information; capsules and credentials are never logged. PG/native
and live preservation verification are serialized by the release owner. This
source change does not claim that a production retirement or upgrade has occurred.

[Matched delivery and validation limits](../reports/runtime-accounting-20261107.md).
