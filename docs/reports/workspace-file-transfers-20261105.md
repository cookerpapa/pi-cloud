# Workspace file transfers — 2026-11-05

Deployed: matched `workspace-transfers-20261105` from `e0f2bc69`, schema 209,
then Web-only `workspace-transfer-web-20261105-r2` from `a94f762c`, Helm 144.
Source checks, actual large-file/browser/model acceptance and final preservation
checks passed. [Sanitized evidence](workspace-file-transfers-20261105.evidence.json).
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

All 13 matched artifacts passed provenance/SBOM/vulnerability checks. The two
original machines had no user application listeners; their recorded allocations
were closed and physically confirmed absent before retirement. Both kept their
Workspace and running intent, and recovered on new allocations after publication.

- **5 GiB elastic upload:** paused at 16 MiB and resumed with the same identity;
  completed in about 140 seconds. No VM, Run or retained original was created by
  the upload. A subsequent real Luna Bash independently verified the digest.
- **1 GiB dedicated browser upload:** actually navigated away after at least
  8 MiB had arrived, reopened the conversation, restored its draft, reselected
  the disk file and continued. Luna verified the canonical Bash digest. The final
  browser scenario, including verification and file-panel checks, took about
  135 seconds; this is not a pure network-throughput measurement.
- **File panel:** uploaded into a nested directory, retained its displayed target
  after refresh and inserted the path without creating another Run.
- The large files produced only **189 / 383 bytes of user-input text** in the two
  verification Runs. File bodies and object-store locations did not enter prompts.
- Existing retained-attachment acceptance passed five real Runs: edited long paste,
  original-versus-working-copy independence, Fork/reuse after Workspace loss,
  edited/promoted native input and direct image vision.
- Native consume, Stop, Worker replacement, streaming Stop and combined
  Worker/Control Plane crash recovery all passed. The logged container connection
  loss came from the deliberate fault, followed by verified recovery.

The first live driver exposed a fixture-cleanup FK ordering error: the test
machine was physically released, but its metadata preceded environment-version
deletion. The helper now requires released/absent evidence and deletes dependent
machine records first. An isolated regression and actual cleanup passed; the
subsequent browser driver completed with successful cleanup. Initial failed
cleanup evidence remains private rather than being erased from the record.

The nested-directory presentation fix used a Web-only release from an isolated
source slice. The combined development commit also changed an acceptance helper,
so the original scope guard correctly refused it. No guard was relaxed. The
isolated checkout needed its local Helm dependency packaged before preparation;
the retry passed existing Web, browser, manifest and one-image scan gates. The
release commit was merged into main. Backend images and machine lifetimes were
not replaced by this Web publication.

Memory was sampled every second. In the final 1 GiB browser run, summed private
memory grew from about **176 MiB** to a sampled peak of **261 MiB**; JS heap peaked
at about **7 MiB**. Summed Chrome-process RSS was about 1,011 MiB, already about
930 MiB before upload because that sum counts shared mappings repeatedly. Control
Plane RSS peaked at about **465 MiB** across the first large-file scenarios.
These measurements do not establish arbitrary-size or fleet guarantees.

Final checks preserved all **17 protected relations, 6,006 Workspace files,
154 originals and 27 credential/configuration files**. All owned fixtures were
cleaned; 26/26 running Pods and both original machines were ready, with no active
Runs, writers, bindings, terminals or elastic test VMs remaining. Nine real
PostgreSQL/Kafka transport tests also passed.

The current 24-hour partial retention is not a promise that an unreachable/paused
Guest can be cleaned immediately. Admission is revoked and cleanup is retried;
missing transport replies never prove physical deletion or release VM quota.

Byte-level continuation currently covers Workspace-only uploads. Retained-original
uploads still retry the whole stream. Browser drafts are local, ordinary source
files may need reselection, and history-search/download Tools remain deferred.
