# ADR-0251: Minimal guest attachment and bounded native execution

Status: implemented, verified and deployed as `guest-execution-5536fc73`, 2026-10-16.
[Delivery evidence](../reports/cubelet-guest-execution-repair-20261015.md) records
required gates, real acceptance, failed samples and confirmed cleanup.
The owner authorized all four
findings in the [Cubelet → guest review](../reports/cubelet-guest-execution-review-20261015.md).

## Behavior and ownership

1. Native cleanup retains an independent, finite final Kill budget after the
   cleanup helper's parent deadline. Preserve the containerd namespace, report
   unconfirmed/unsafe cleanup through the existing result path, and leave VM
   lifecycle and physical-absence/quota decisions with the Control Plane.
2. Check execution expiry and already-observed operation cancellation before
   issuing native Start. When no Start was issued, preserve non-execution evidence
   and delete the unstarted native handle with bounded cleanup. An issued Start
   with a lost reply remains uncertain; never reissue it automatically.
3. Match pinned Pi's path normalization and Read filename variants at the fixed
   guest Tool boundary. Apply existing path restrictions to the interpreted path.
   Keep streamed bounded Read, image support, native Edit/Write algorithms and
   ordinary process-group cancellation. Do not import private SDK modules or
   patch Pi's loop. Contract tests compare actual public native Tool behavior.
4. Full environment initialization and ordinary Tool execution have different
   payloads. `worker.initialize` retains environment, recipe and actual seed.
   `worker.operation` carries a small attachment (binding activation ID, selected
   Tool root, optional web proxy) and the fixed Tool request. The guest parses one
   strict protocol message, rather than reconstructing it from a second wrapper.
   Remove operation-mode initializer/recipe/placeholder-seed fields. Root scope
   startup validates the operation identity; guest execution checks attachment
   identity, path and network settings. Workflow's separate transport remains.

No queue, cache, authority, per-Tool PG lease read, guest Harness, process-status
ledger, raw-output archive or alternative runtime is added. The native receipt
still means a full result frame reached Cubelet, not a canonical Worker commit.

## Adopted mechanisms

The review inspected the pinned Cube/containerd execution APIs and Pi Durable
1.0.0 public Tools/Node environment. Reuse their context cancellation, process
handles and file APIs. The small path normalizer is a contract-tested adapter
because Pi's helper is private and its native Read buffers the complete file and
does not support images; replacing bounded cloud Read wholesale would lose those
required properties. This is a repair to existing ports, not a new infrastructure
protocol or competing lifecycle manager.

## Matched cutover

Advance guest/Tool Worker protocol 5 → 6 and fixed execution descriptor 1 → 2.
Remove old wrappers and descriptor fields, without compatibility decoding.
PG schema 189, execution Topic v17, boot reply v3 and Cube management protocol 7
remain: native log requests and Cube's opaque payload endpoint are unchanged.
Full initialization remains available only at its explicit preparation entry.

Use the maintained matched release with drained writers, confirmed physical VM
absence and no remaining Tool bindings. The last condition excludes stale
descriptor bodies before replacing their shape. Preserve accounts, model/provider
settings, credentials and native conversation assets. No business-data reset or
new migration is required for this transient, quiescent descriptor cutover.
Rollback is a complete matched artifact set while equally drained.

## Acceptance

- A stalled cleanup Kill receives a finite independent deadline and cannot pin
  the native driver; lost stopping proof does not become success or replay.
- Expiry/cancellation during setup issues no Start and retains correct evidence;
  a normal Start preserves namespaces, cancellation and uncertain-reply handling.
- Native/cloud path comparisons cover leading `@` (including doubled `@`), Unicode
  spaces, filename variants, ambiguous existing names, Write→Read, images and guards.
- Strict protocol tests distinguish initialization/attachment, reject old/extra
  fields and mismatched IDs, and prove ordinary requests omit recipe and seed.
- Required repository/native/race/real PG+Kafka checks pass, followed by scanned
  matched deployment and real Luna/Cube, browser/image, native input/cancellation,
  child/workflow and recovery acceptance. Record failed samples and physical cleanup.
