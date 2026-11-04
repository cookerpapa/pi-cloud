# ADR-0294: Retained user originals and editable long-paste attachments

Status: deployed as `retained-attachments-20261104`, 2026-11-04; source and live
Luna/Cube/browser/recovery acceptance passed on schema 208.
Tracking: https://github.com/cookerpapa/pi-cloud/issues/2 .

[Implementation and verification](../reports/retained-user-attachments-20261104.md).

## Decision

A user attachment's immutable original belongs to the conversation. Existing
private S3 owns its bytes; the existing PG inventory, native input references and
shared history roots own reachability. Cube Volumes remain the sole authority for
mutable Workspace files. This is not a Workspace backup or a second input queue.

Generalize the existing image inventory, streamed object transport, reference
validation and collection to all user uploads. Keep the image codec and native
visual-input contract image-specific. Original references are bounded typed
metadata, never inline file bodies, signed URLs or Workspace paths as identity.
Keep the existing S3 bucket/physical key namespace; it is an opaque storage
location, not a second versioned adapter or alternate authority.

The browser converts a plain-text paste exceeding 4,000 Unicode code points into
a UTF-8 file. The original paste is preserved without trimming or normalization.
Small pastes and ordinary typing remain text. Each generated file has a compact
character-count card and a browser text editor. Edits remain local until sending;
changing a previously uploaded draft creates a new immutable upload identity.
History originals are read-only and can be downloaded or reused in the composer.
No arbitrary document parser, full-context injection, RAG service or new library
is introduced.

Original upload completes and verifies its size/digest before Workspace placement.
Placement streams from the retained source through the existing upload port,
without a whole-file Control Plane buffer. The existing claim spans both stages;
failed or uncertain placement does not erase the original. Final ready receipt
requires original integrity, matching placement and current admission. No network
I/O occurs under a PG transaction. Idempotent retry verifies the supplied bytes
and cannot overwrite a conflicting Workspace file.

Ordinary input still acknowledges PG admission; steer/follow-up still acknowledges
Pi's Kafka-durable Inbox commit. Provisional upload pins bridge native admission
and projection, including lost acknowledgements. Inbox editing atomically replaces
references under its existing revision/consumption checks. Stop-returned drafts
keep references. No extra PG projection wait or duplicate cloud queue is added.

An attachment source can be read with conversation authorization while its old
Workspace is gone. Reusing it in another Workspace creates a new placement/upload
identity and uses current admission; it does not rewrite old Entries. Preparation
covers submitted/reused attachments, not lifetime history. Fork retains only the
selected path's source references through existing shared roots. Source deletion
cannot collect a Fork's original. Collection excludes active upload claims,
provisional pins, native current inputs and retained history. Replaced unconsumed
versions become collectible only after their last reference is gone; the Web does
not infer this from a removed card. User/Agent-modified files are never silently
overwritten by restoration.

## Adopt before build

The source comparison preceding this decision examined Open WebUI, Kortix,
OpenHands and bolt.diy. Relevant primary implementations:

- Open WebUI at `c38885a1a737da4968f157092f304f3b5481d0bf`,
  `src/lib/components/chat/MessageInput.svelte`, demonstrates automatic pasted
  text files. Its full-document and filesystem paths have different storage and
  context semantics; a file card alone does not keep the body out of model input.
  https://github.com/open-webui/open-webui/blob/c38885a1a737da4968f157092f304f3b5481d0bf/src/lib/components/chat/MessageInput.svelte
- Kortix/CompanyOS at `87e5ecefcfa258ffea64bac8d3230e97dda046b2`,
  `apps/api/src/projects/prompt-attachment-upload.ts` and its Session lifecycle
  materializer, separates object-store originals from Workspace placement. Its
  inline paste tiles still send full text; optional saved copies are not a
  demonstrated replacement for PiCloud's durable reference/cleanup contract.
  https://github.com/kortix-ai/CompanyOS/blob/87e5ecefcfa258ffea64bac8d3230e97dda046b2/apps/api/src/projects/prompt-attachment-upload.ts

Adopt these UX/storage separation patterns, not their runtimes or schedulers.
No source code or dependency is imported from either project. Reuse PiCloud's
existing pinned S3 client, PG authority and Pi 1.0 public APIs. A new attachment
service/framework would duplicate working lifecycle and reference machinery.

## Verification and release

Verify exact 50,000-character text/Unicode/newlines, editing without repeated
uploads, bounded input metadata, original and placement failures, ambiguous
acknowledgement retry, edit/consume races, Stop-return, Worker recovery, independent
Fork deletion, and last-reference collection. Browser checks exercise paste,
editing, read-only history, reuse and failed-send draft retention. Image direct
vision, streaming/backpressure and stale-upload cleanup must continue to pass.

Update API/storage and recovery documentation. Schema/protocol changes require a
matched release; source completion and live publication must be reported
separately. No compatibility adapter, Pi core patch, old-writer retry or automatic
unsafe Tool replay is permitted.
