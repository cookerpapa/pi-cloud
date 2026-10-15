# ADR-0250: Tool takeover outcomes and live-runtime admission

Status: approved for implementation, 2026-10-15. The owner authorized R15H-01/02/03
and O15H-01 from the [handoff review](../reports/projector-cube-handoff-review-20261015.md).
D15H-01 is an upgrade contract check, not a protocol expansion.

## Scope and acceptance

Keep confirmed Kafka dispatch progress before Cube delivery, native producer and
destination fencing, the current UNKNOWN window and independent physical cleanup.
Do not split native Storage batches, add per-Tool PG checks, add a result ledger,
introduce another queue or teach Projector to run Pi.

1. A takeover failure attempts its original Worker reply independently of
   quarantine success, rejection or delay. Start both branches and join their
   settlements; do not detach an unowned background action. Preserve quarantine
   failure reporting and the existing control lifecycle/Outbox recovery path.
   Waiting for lifecycle completion can still delay partition completion; it
   cannot delay starting the Tool failure reply. A lost reply is logged and
   never authorizes replay or proves stopping.
2. Map confirmed rejection codes explicitly to both availability and effect
   evidence. Known pre-admission refusals retain `not_started`; an unavailable
   runtime can still block sampling through its error code. Position/identity
   ambiguity, lost transport replies and unknown rejection codes remain UNKNOWN.
   No result text is used as infrastructure evidence.
3. Cube Manager checks the native VM catalog while holding the same admission
   mutex used to register position/operation and to forget confirmed-absent VMs.
   The Driver port supplies a synchronous catalog-presence predicate. Production
   uses Cube's existing in-memory `cubes.local.Get`/Store index, not a health probe
   or PG request. Both Submit and Cancel use this boundary. An unavailable catalog
   entry prevents new retained state and is never destruction/quota-release proof.
   If native deletion races an admitted request, its final exact absence handling
   joins that admission mutex before discarding position state. A later request
   rechecks the now-absent catalog and cannot recreate it. No permanent tombstone
   list or second VM registry is added.
4. Tools, operation cancellation, probes and other known-binding reads use one
   exact tenant/Run/binding lookup and validate writer identity. Remove the
   redundant family routing index and whole-family `find` API where no maintained
   caller needs it. Native lifecycle inventory/adoption and SQL writer closure
   retain their actual enumeration responsibilities.
5. Test the pinned Pi's two concurrent reads with both executions outstanding:
   their execution intents commit separately while execution overlaps. Preserve
   multiple writes per native commit and the existing transport schema. A future
   Pi change prompts an explicit upgrade decision, not an automatic compatibility
   path or a runtime single-Tool restriction.

## Reuse and ownership

This is a bounded repair to the adopted pinned Pi/Cube/Kafka adapters, not a new
distributed scheduler or storage protocol. ADR-0219 and the prior Cube source
survey remain the adoption evidence. Cube's native catalog already owns whether
a VM identity is loaded; its index supports constant-time exact lookup. Reuse it
under the execution Manager's existing local mutex rather than creating a second
admission ledger. PG remains cloud control authority. Routing revocation, positive
node absence and Volume purge requirements remain unchanged.

The matched contracts remain PG 189, execution Topic v17, boot reply v3, guest 5
and Cube management 7: no request/response shape or ordered-position field changes.
The new native implementation still requires a matched, drained artifact release.
Record source gates, native race tests, actual Luna/Cube/queue/browser/child recovery
acceptance, preserved configuration and physical fixture cleanup before completion.
Rollback remains a complete matched artifact set while drained.

Required failure tests include quarantine error/delay plus reply failure,
recognized and unknown refusals, wrong tenant/writer or closed binding, exact
lookup at large family size, missing VM, Submit/Cancel racing confirmed absence,
duplicate and old-position rejection, and no position allocation by probes.
