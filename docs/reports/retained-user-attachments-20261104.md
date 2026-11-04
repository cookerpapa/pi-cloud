# Retained user attachments — 2026-11-04

Deployed as `retained-attachments-20261104`, source `ea9e76c5`, schema 208,
Helm revision 142. Source and live acceptance passed.
[Sanitized evidence](retained-user-attachments-20261104.evidence.json). Tracking:
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

The owner explicitly authorized resuming the paused deployment. All 13 matched
artifacts passed the configured provenance/SBOM/vulnerability gates. The two
stopped development machines had allocation admission closed and physical absence
confirmed on their original node before ownership was retired. Both kept their
Workspace and desired running intent, and recovered with new allocations after
publication. Those allocations survived the subsequent recovery tests.

Real GPT-6 Luna/Cube acceptance passed five Runs across three focused invocations:

- Browser paste/edit/send of 60,076 characters, with 155,083 bytes after editing.
  Drafts stayed local before Send; admitted input contained only bounded metadata.
  Native read and Bash returned the expected first/last lines.
- Bash changed the mutable copy while the retained original's digest stayed exact.
- A Fork retained the original after source deletion and confirmed physical
  deletion of the old Workspace. Reuse in a fresh Workspace kept the same S3
  object, and guest Bash verified the complete original digest.
- While Bash was running, an uploaded follow-up was edited and promoted to Steer
  atomically. The same Run read the latest file, without consuming the old draft.
- A small uploaded PNG retained exact original bytes and entered the model as
  visual content directly. Luna read its random six-digit code without a Tool call.

Early live-driver attempts found a too-long fixture slug, navigation being used
before loading completed, and an omitted/invalid tree-view argument. The driver
was corrected and failed fixtures were cleaned. No production workaround or
weakening of an assertion was used to pass these cases.

The maintained native-input suite also passed consume, Stop, Worker recovery,
streaming Stop and combined Worker/Control Plane crash recovery. The deliberate
SIGKILL briefly interrupted kubectl's exec connection; restart and continuation
were then verified. These are owned single-host checks, not fleet-level HA claims.

Final comparisons preserved 17 protected relations, all 6,006 Workspace files,
154 retained originals and 27 credential/configuration files. All owned test
tenants, objects and compute were cleaned. There are 26/26 running Pods ready,
two ready original machines, and no active Runs, writers, bindings or elastic
fixtures. The earlier deferred 131 MiB provider request was not repeated.

To repeat the maintained attachment acceptance against a matching deployment:

```sh
PI_CLOUD_LIVE_RETAINED_ATTACHMENTS_CHECK=1 node --import tsx scripts/run-live-retained-attachments-check.mjs /tmp/retained-attachments.json
```

The optional last argument is `originals`, `queue` or `vision`; the default runs all. The
driver creates owned resources, uses ordinary APIs and requires confirmed physical
cleanup before removing their database metadata.
