# October 7 recovery and Read repair rollout

The owner-authorized release **review-release-49e9b8cc** deploys
`49e9b8ccdc3702603db7d0109a4ed0cc3784e13b`, including the approved
[R07R3 repairs](review-repair-20261007-r3.md) and document-query optimization.
Tool Worker protocol is **4**, guest input protocol **4**, managed Cube protocol
**7**, and PostgreSQL schema **182**. Pi Durable/AI/Chord remain pinned to 1.0.0.
R07R3-04 (CubeMaster configuration logging) remains explicitly owner-deferred.

[Release evidence](review-release-20261007-r3.json) records the matched artifacts,
readiness, native inventory and scoped cleanup. Guest source identity is
`1ab0b6a38aa52ff410a7ab8b527f1f32c91a3b89`; its OCI digest is
`sha256:ca51cee4da900fe15ce168eaf70c61a4eacbad6744cad23eecfb8b59e8a82d61`.
The completion identity is `3b59079823947436b5113d585de528be5c743556`.
Final Helm revisions are PiCloud **29**, infrastructure **28** and Cube **57**.
Both Workers are ready and publication owns **32/32 partitions**.

## Acceptance

All model-bearing checks use **GPT-6 Luna** and owned disposable resources.

- [Real browser Stop and Read checks](review-release-targeted-20261007-r3.json):
  the server accepts an image-bearing queued message before its reply is
  deliberately discarded. After clearing the draft and pressing Stop, the
  browser restores its text/image. Resending uses a new key and admits a new Run;
  the original remains cancelled. Luna reads the restored image directly without
  a Tool. ASCII and Unicode/BOM files then traverse guest → completion → Kafka →
  Worker → native history. A 120,017-byte ASCII line yields 51,200 bytes of actual
  content; the Unicode case yields 51,196 bytes after native BOM handling.
  Both canonical results retain structured and model-visible continuation hints.
- [Native Provider checks](review-release-provider-20261007-r3.json): both actual
  VM cases pass, covering unconfirmed deletion, two-tenant isolation, public and
  private egress boundaries, PTY fencing, warm processes, cancellation and cleanup.
- [Whole-production acceptance](review-release-production-20261007-r3.json):
  seven Runs and **21 model requests** pass pure chat, coding, authenticated
  preview, cross-Run background-process reuse, isolation and the 1,024-file
  Workspace fixture. A fresh VM mounts the same persistent Volume after confirmed
  closure of the old allocation. Final-conversation deletion releases the VM.

All 11 release images pass provenance inspection and the repository's zero
fixable HIGH/CRITICAL gate. Raw unfixed findings remain in the private evidence
set `dist/release-evidence-review-release-49e9b8cc`. The source record separately
documents 1,666 workspace tests, 45 helper tests and 226 confirmed fault cases.

## Cleanup and operational corrections

Old writers and entry points were drained while no Runs or native resources were
active. The approved development reset removed 22 leftover runtime rows across
44 tables and the old execution topic/group. Protected configuration hashes
matched before and after. Four superseded templates were deleted through the
native API. Registry maintenance deleted three old manifests, retained the sole
current tag and verified its complete manifest/blob graph.

After acceptance, only its two new tenants and four physically purged Workspaces
were removed. The foreign-tenant isolation Workspace was identified by the exact
fixture suffix; its pre-existing bootstrap tenant was preserved. One owned image
object was removed after its Session/VM/Volume cleanup. Current consumers and
dispatch offsets remain intact. Twelve obsolete Docker tags, ten K3s image
references, eight inactive ReplicaSets and superseded Helm records were removed.
Final inventory has **zero Sessions, Runs, Workspaces, VMs, Volumes and image
objects**, with the original **29 accounts/tenants and 30 model profiles** intact.

The scanner's direct vulnerability-DB download stalled; the same pinned scanner
updated its cache through the existing host proxy before the unchanged gate ran.
Source-archive verification was rerun under normal `022` permissions after a
private `077` extraction produced a different file-mode fingerprint. The actual
source and guest identities matched; no provenance assertion was weakened.

The native VM assertions passed, but their temporary egress wrapper initially
tried to restore an unconfigured proxy with an unsupported empty URL. A bounded
CAS on its exact revision/URL, with an entry in the existing configuration audit,
restored the original **disabled and unconfigured** state. That restoration was
checked through the public API and PG. No product compatibility path was added.

These checks validate this single-host release, not physical multi-node HA or a
new capacity claim. Earlier cold-host clock initialization remains separately
tracked; this release does not claim to reproduce or repair it.
