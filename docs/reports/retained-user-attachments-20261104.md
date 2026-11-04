# Retained user attachments — 2026-11-04

Source implementation and isolated acceptance are complete. Matched publication
and real Cube acceptance are pending. Tracking:
[Issue #2](https://github.com/cookerpapa/pi-cloud/issues/2),
[ADR-0294](../adr/0294-retained-user-attachments.md), schema 208.

## Behavior

Pasting more than 4,000 Unicode code points creates an editable UTF-8 attachment.
The browser retains generated drafts locally until Send, and edits create new
upload identities. Normal typing and shorter pastes remain ordinary text. The
text viewer is bounded to 8 MiB; larger files remain uploadable/downloadable.

All new uploads retain immutable originals in the existing object store before
streaming Workspace placement. PG and native messages carry references/metadata.
The original inventory and reference indexes are generalized in place, retaining
existing image object keys and the image-only native codec. No Pi core change,
new service, input queue or Workspace archive is introduced. Originals are not
injected as full text into model context; ordinary read/bash uses the working copy.

Native edits and edited Steer atomically replace queued references. A consumed
input rejects the mutation and the Web retains edited files for restoration to
the composer. History originals are read-only and can be downloaded/reused. Reuse
authorizes the retained object and creates a new Workspace placement without
duplicating S3 bytes. Local/restored drafts handle Workspace/directory changes.

Shared Fork roots retain selected originals independently of source deletion.
GC and cold asset recovery include generic attachments. Accepted originals retain
the existing conservative Session lifetime, including after withdrawal. Historical
Workspace-only files do not acquire fictitious originals; new admission requires
a retained source. Mutable Workspace contents are not backed up or synchronized.

## Source acceptance

Checks ran in the feature worktree based on `1ae43c021e6caf31a7d7fb43b24a423149b82c49`.
They are not represented as live production or clean-revision results.

- All 23 workspace suites: **2,379 passed**, 11 existing opt-in cases skipped.
  Full-workspace types passed; final affected-scope types passed again.
- Operator/release helpers: **133 passed**. The initial aggregate check found a
  missing explicit Guest COPY input for `attachment-reference.ts`; the Dockerfile
  was corrected and the complete helper suite passed on repeat.
- **383/383** deterministic fault cases passed; the updated fault report records
  the dirty-worktree scope rather than inventing a deployed revision.
- Real PG/Kafka transport: **9 passed** across 8 files, including Session producer
  fencing, closure and replay boundaries.
- Full browser presentation checks passed. Focused attachment acceptance also
  verified 50,000+ characters, local editing, failed-send exact retry, read-only
  originals, edited Steer, reuse and consumed-input draft restoration.
- Focused upload/source access checks: **12 passed**; retained text was readable
  after Workspace loss, reusing it did not create another object, and failed
  archival did not start placement. Generic and image Fork/last-reference GC
  passed through the actual shared-history implementation.
- Native Inbox tests: **5 passed**, including replay of the latest attachment
  selection and atomic promotion without creating another submission.
- The real cold recovery drill exported images and an ordinary text original,
  destroyed its owned source storage, and read the exact bytes after restoration
  with new Workspaces. It used isolated PostgreSQL and SeaweedFS containers.
- Build, documentation, runtime-policy, image-closure and dependency audit gates
  passed. No model/provider request or production resource mutation was needed
  for these source checks.

## Publication

The owner explicitly authorized resuming the paused deployment and publishing
this feature on 2026-11-04. Preserve accounts, configuration, existing originals
and Workspace bytes; use the maintained matched-release operator and verify old
allocation absence before discarding ownership. Record release identifiers and
real Luna/Cube results here after they actually pass.
