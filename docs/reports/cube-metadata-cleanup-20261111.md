# Obsolete Cube metadata cleanup — 2026-11-11

Tracking: [#28](https://github.com/cookerpapa/pi-managed-agents/issues/28).
Decision: [ADR-0311](../adr/0311-obsolete-cube-metadata-maintenance.md).

Completed on the unchanged stock-Cube R5 deployment. Four old templates and their
four rootfs artifact records were deleted by native Cube operations. The four
selected current templates remain READY. Native deletions took approximately
three seconds each after repairing their stale Pod-IP locators. No Cube image,
source, dependency or running network topology was patched.

The removed extension data occupied two node databases. The first guarded attempt
refused a mismatched database marker and changed no node buckets. Inspection then
confirmed containerd `meta.db` contains the two old allocation/lifecycle buckets,
while `volume_refcount.db` contains the old private reference-clock bucket.
The corrected, separately scoped cleanup removed these three buckets. The old
resource-usage bucket was already absent. Every retained native bucket, nested
key/value and sequence had the same before/after hash in each transaction.

The operator drained application writers, retired both old VMs through the native
provider, stopped native writers, performed the bounded repair/removal, restored
Cube, deleted the templates, and restored the application. Both original stable
development machines recovered to READY with new native VM identities, the same
Workspace identities and the same running intent. All active application Pods
are Ready; the completed database bootstrap Job is not a failing service.

Preservation checks passed for 394 original source/image files, both machine
intents, accounts, model/provider configuration and credentials. No original
Workspace or Android userdata was removed. Compute observations remain
unconfirmed and unpriced. Ten focused JavaScript tests, five bbolt tests and the
documentation check passed. Private inventories and preservation hashes remain
outside Git under the operator evidence directory.

This maintenance is complete. It is not BoxLite or Android integration evidence;
that independent work continues in #27.
