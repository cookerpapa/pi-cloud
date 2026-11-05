# ADR-0295: Resumable Workspace files and explicit attachment retention

Status: implemented and deployed, 2026-11-05, schema 209 / Helm 144.
[Source and live evidence](../reports/workspace-file-transfers-20261105.md).
Tracking: https://github.com/cookerpapa/pi-cloud/issues/3 .

## Decision

An upload entry point does not determine retention. The composer supports retained
conversation attachments (the default, ADR-0294) and explicit Workspace-only
files. Long text paste remains an automatic retained attachment. Select retention
before transferring bytes; ordinary file selection no longer starts an irrevocable
original upload before the user can select its purpose. Changing a started file's
purpose requires a new draft, never a silent mutation of an admitted identity.

The composer begins byte transfer on Send. It persists local draft text, file
metadata, retention/target and submission/upload identities before network work;
it does not persist whole local file bodies. Reopening the same browser restores
the draft and queries authoritative progress. File access may require reselecting
the original; reopening never submits it automatically. Keep the same submission
identity across ambiguous acknowledgements and reconcile acceptance before offering
a duplicate send. Clear the persisted draft only after confirmed admission, without
discarding newer edits. Browser close is interruption, not an explicit cancellation.
Paused data expires after 24 hours of inactivity through receiver-owned cleanup.

Ordinary Agent input describes filename, length and Workspace path, not original
storage URLs/keys or retention mechanics. Historical paths remain historical:
opening, recovering or searching a conversation must not restore old working
files. A future download_attachment tool is an explicit Agent decision and can
retrieve only the uploaded immutable original, not later Workspace modifications.
History search/download Tools are a separate slice; this change adds no such Tool.

The Workspace inspector uploads to a selected existing directory. Composer
Workspace files use the existing uploads/<UUID>/<name> location. Completed files
can be referenced in ordinary prompt text, including native steer/follow-up.
Referencing an existing Workspace file does not transfer it again. A file upload
does not create a Run. Workspace files are not fake UserUpload/attachment records:
they have no retained original and cannot be restored after Workspace deletion.

Cube Volumes own working bytes and resumable staging. Add a bounded PG transfer
grant containing actor, frozen Session/Workspace/directory, target path, content
identity, cancellation/completion state and expiry. It is neither a file inventory
nor an Agent command queue. No file bytes or per-chunk offsets enter PG/Kafka.
The receiving filesystem is the only authority for confirmed upload offset.
Admission is rechecked at the existing Sandbox owner/Volume boundary. Rebinding
does not redirect a transfer. Cancellation revokes admission and removes only
unfinished staging, never a published or user-modified file.

Use tus 1.0 HEAD/PATCH for resumable byte transport, behind a PiCloud-owned port.
The existing API authenticates requests and delegates bounded streams through
SandboxWorkspaceFiles to the Volume Gateway or fixed Guest helper. Elastic
uploads need no VM. Dedicated uploads keep their existing Guest mapping and
ownership checks. Guest transit staging is bounded to one chunk, not another
full-file archive. There is no new daemon, broker, Redis or scheduler.

Staging uses the existing filesystem-held locks and maintenance discovery. Each
transfer has immutable content/destination identity and a recoverable completion
receipt; append rechecks the actual offset while holding its OS lock. A partial
write can resume at its observed durable length. Length/SHA-256 verification and
exclusive atomic publication precede completion. Repeated finalization verifies
its receipt and never recreates a file subsequently edited/deleted by the user.
Same-name different files fail instead of overwriting. Paused staging has finite
retention, renewed by valid activity; cancellation/expiry cannot remove a live
writer's file. Transfer grants are not discarded as proof of physical cleanup.

## Adopt before build

Reviewed official tus protocol, Node server/file-store source and browser client:

- https://tus.io/protocols/resumable-upload
- https://github.com/tus/tus-node-server/tree/main/packages/server
- https://github.com/tus/tus-node-server/tree/main/packages/file-store
- https://github.com/tus/tus-js-client
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html

Adopt MIT-licensed @tus/server 2.4.7 and tus-js-client 4.3.1 (stable releases
checked against npm), not the client's prerelease main branch. Keep vendor types
inside adapters. A temporary official FileStore 2.1.2 contract experiment wrote
four bytes, restarted the receiver, observed offset four, rejected stale offset
zero with 409, and resumed to an exact twelve-byte result with the real client.
This proves the protocol/client seam, not multi-GiB or Cube acceptance.

Do not adopt FileStore's default pathname-based create/write/remove as the
Workspace authority: it truncates on create, lacks our descriptor confinement,
OS-held exclusion, source checksum and atomic destination/receipt semantics.
A bounded DataStore adapter to the existing file port preserves those invariants;
the protocol itself remains the upstream implementation. Its checksum extension
is not provided by the selected Node store; final verification remains explicit.
S3 multipart solves object-store transfer, not Workspace placement; it is deferred
for retained originals rather than creating a hidden S3 copy of Workspace files.

## Failure, verification and release

Browser refresh may require reselecting the original local file. Resume identity
includes content digest and frozen destination, not only filename/size. Lost
acknowledgements reconcile against filesystem progress/receipt. Permanent identity,
checksum, admission and path failures do not retry indefinitely. Failed sends keep
drafts; upload progress is not a durable message acknowledgement.

Verify streaming/backpressure, restart/partial append, conflicting offsets,
exclusive publication, lost completion receipts, cancellation, expiry, changed
directories/bindings, deleted Workspaces and mismatched source bytes. Exercise
both Cube upload paths, real browser/client recovery, 1 GiB and 5 GiB files,
record memory/throughput, and clean only owned fixtures. Preserve retained image,
long-paste, Inbox and Fork behavior. Update BACKLOG, public/API docs and matched
release evidence. No arbitrary product file-size quota or Pi core change.

Protocol/schema/Guest changes require a matched release with writer draining and
preserved accounts, configuration, originals and Workspace bytes. Deployment
rollback is a matched artifact rollback, never a mixed-protocol fallback. Completed
files remain ordinary exportable Workspace files; unfinished transfers can be
cancelled/reuploaded without keeping a second upload authority.
