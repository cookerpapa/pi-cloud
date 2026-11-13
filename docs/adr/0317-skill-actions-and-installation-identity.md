# ADR-0317: Two Skill tools and exact installation removal

Date: 2026-11-12. Status: accepted; implemented and live-verified on 2026-11-13. Tracking: #34.

Expose `skill` with list/read/inspect/uninstall actions and retain `publish_skill`.
Remove the former model-facing reader/inspector names after coordinated retirement
of pending calls. Worker prompt/capability references change with the Tool catalog;
no old-name aliases or Pi core changes are introduced.

Read keeps the Run's frozen installed versions. Execution resources are prepared
in the current Workspace and the actual directory is returned; pure text and
inspection remain storage-only. The combined tool is conservatively non-replayable
because activation/uninstall can mutate state. It does not introduce an action
replay framework just to optimize read-only inspection.

Uninstall removes an exact personal installation on behalf of the root Session
owner, with the observed package/revision precondition. It does not grant an Agent
organization-owner authority, delete a published object, change another scope or
remove Workspace files. List/inspect supply the personal installation revision;
after an uncertain response, inspection reports actual current installation state.
Current Runs and already-read native context retain their existing versions.
Wider project/organization installations may still apply to later Runs.

Use a PG sequence for installation revisions. A deleted and recreated row must
not restart at revision 1: otherwise a delayed uninstall could remove the new
installation. Revisions identify mutations, not a per-row update count. The same
PG revision protects Web and Tool changes; no tombstone table or command ledger
is added. An absent row can be reported as absent without claiming which request
deleted it; a different current revision remains a conflict.

PG metadata, immutable S3 packages and Workspace execution copies keep their
existing owners. Check published requirements and pending old-name invocations
before cutover. Preserve originals/history; unsupported old references must not
silently select another package. This reuses the existing Skill service, public
Pi sections, ordinary tool registry and native effect/UNKNOWN mechanisms.

Validate read/activation/inspection, name ambiguity, publication, root/personal
scope, revision conflicts, duplicate removal, reinstallation and frozen selection.
Run matching real model/Guest behavior after the integrated publication.

Implementation and measured limits: [November 13 delivery](../reports/decoupling-delivery-20261113.md).
