# Workspace file transfers — 2026-11-05

Status: source implementation verified; matched publication and large-file live
acceptance pending. This is not a claim that the new UI is already serving.
[ADR-0295](../adr/0295-workspace-file-transfers.md),
[behavior/API](../WORKSPACE_UPLOADS.md),
[Issue #3](https://github.com/cookerpapa/pi-cloud/issues/3).

## Implemented behavior

The composer selects retained attachment or Workspace-only retention before Send.
Working files use upstream tus continuation, bounded PG admission metadata and
the existing Cube Volume/Guest file ports. The receiving filesystem owns offset
and verified publication, with OS locks, cancellation tombstones and recoverable
receipts. Ordinary binary source bodies do not enter PG/Kafka, browser draft
storage or model context. Completed user files survive retry/cancellation.

Browser-local drafts preserve text, descriptors and frozen submission identity.
Reopening does not automatically send/upload; incomplete disk files need source
reselection and a digest match. A read-only receipt lookup distinguishes confirmed
acceptance from unknown projection. Stop-returned inputs retire old submission
identity. First Workspace attachment is distinguished from rebinding so new-chat
file preparation is not aborted by its own Session creation.

The file panel uploads to an existing selected directory and inserts paths.
Workspace-only references are ordinary user input; they do not masquerade as
retained originals. Historical paths are not restored implicitly. The proposed
history-search/download-attachment Tools remain outside this slice.

## Source validation

Checks ran in the uncommitted worktree based on `6e27d1bc`; the fault report records
that provenance explicitly. No production data was a source-test fixture.

- All workspace type checks passed, with affected-scope checks after repairs.
- The full 23-workspace test run completed with 2,403 passed, one failed and
  11 existing opt-in skips. The failure was the old maintenance fixture requiring
  only the previous Guest operation. It now checks both fixed cleanup operations,
  their respective identities and continued lifecycle isolation. The entire
  Sandbox Control suite passed again (347 passed, two existing opt-in skips).
- Additional final API and receiver regressions cover malformed/deleted targets,
  canonical UUID identity and retryable transport errors. The current additional
  tests are included in the final verification record rather than treating the
  initial aggregate command as an uninterrupted success.
- Real PostgreSQL/HTTP/tus acceptance verifies API replacement, source-owned
  continuation, offset conflict, lost completion with subsequent user edits,
  cancellation/expiry, and read-only input receipts. No original, input or Run is
  created merely by uploading a working file.
- Receiver/Guest tests verify interrupted streams, checksum failure, publication
  uncertainty, conflict, replaced directories, cancellation and expiry. Bounded
  cleanup rotates past unexpired transfers. Disposable Guest source cleanup
  excludes live chunks, ordinary Tool envelopes and user files.
- **391/391** deterministic fault cases passed on repeat after the maintenance
  fixture update. The first failed evaluation is not presented as a success.
- Full browser presentation acceptance passed, including retained originals,
  long paste, native queue edits/Stop, new-chat image input, manual reading and
  unrelated page controls. The new scope verifies remount/reselection, wrong-source
  rejection, confirmed-offset continuation, upload-before-input admission and
  lost input receipt recovery. Actual browser navigation with real Cube is a
  separate live check below.
- All 133 release/operator helper tests passed. Web build, documentation, image
  input/closure and dependency audit gates passed; no HIGH/CRITICAL npm advisory
  remained at the configured audit threshold.

## Publication and live evidence

Pending matched schema-209 publication, owned 5 GiB elastic and 1 GiB dedicated
browser uploads, canonical Luna Bash checksums, retained-attachment/native recovery
regressions and preservation comparison. The live driver samples driver/Control
Plane RSS, browser JS heap and summed Chrome-process RSS; it must not infer a peak
from only the JS heap. Original accounts, configuration, conversations, images and
Workspace bytes remain preservation targets.

The current 24-hour partial retention is not a promise that an unreachable/paused
Guest can be cleaned immediately. Admission is revoked and cleanup is retried;
missing transport replies never prove physical deletion or release VM quota.
