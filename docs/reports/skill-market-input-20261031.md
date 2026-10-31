# Human input boundaries and internal Skill market

The matched runtime `skill-market-input-20261031-r2` is deployed from
`341f8644a2535631ad177237349487acb6b4ef9b`, on schema 206 and platform Helm revision
132. The subsequent `5ce4b293` change corrects an acceptance-driver query only.
Final browser-runtime, original-application and asset checks have passed.

## Input behavior

The composer now submits through one human-input endpoint. `whenBusy` expresses
steer/follow-up preference; the server chooses active native input or a new root
Run from its receipt and authoritative state. An old browser-selected Turn cannot
trap a new steer on completed work. A closed native target causes one fresh
admission check; uncertain delivery preserves the same retry identity and draft.

Pending steers remain editable, cancellable and reorderable until Pi consumes
them. Refreshes received during queue mutation are deferred instead of discarded.
Completion and queue observations reconcile against Run status without inventing
transcript coverage. An accepted initial prompt survives the interval between
leaving the queue and receiving its start event. Absolute Run order is distinct
from relative pending-queue position.

The browser shows captured outgoing text and attachment preparation immediately
as local sending feedback. This is separate from canonical user history; durable
acceptance still determines successful submission. Later edits and another
conversation are protected from stale replies.

Three baseline owned Luna requests acknowledged in approximately 32, 55 and 18 ms.
The deployed Skill acceptance requests acknowledged in 31, 21 and 25 ms. This did
not reproduce a seconds-long ordinary PG admission bottleneck. Historical state
of the reported long conversation showed completed work and consumed native input;
it does not prove why every earlier unclaimed, subsequently cancelled Run waited.
The repaired queue-response ordering was independently reproduced in a browser:
the old source failed and the repaired source passed.

## Skill behavior

[ADR-0291](../adr/0291-internal-skill-market.md) adopts the portable Agent Skills
directory format. The internal market supports public GitHub directory imports
at resolved commits, local directory/text publication, export, explicit version
selection, personal/project/tenant installation, disable and uninstall.

PG owns catalog, installation and immutable per-Run selection metadata. Existing
S3 storage owns separately inventoried package bytes. `read_skill` discovers and
reads bounded instruction/reference pages without starting a VM. `prepare_skill`
copies the selected files through the current Workspace binding; ordinary Sandbox
Tools execute scripts. It neither loads extensions into the Worker nor introduces
a new Tool hosting platform, scheduler or native-history authority.

The first Skill use fixes the installed versions for that root Run and its native
children. Updates/uninstall affect later Runs. Requirements describe platform
capabilities separately from human compatibility prose; software prerequisites
remain explicitly unverified until ordinary Sandbox work checks them. See
[usage, limits and API](../SKILLS.md).

## Verification

- `npm run check`: 2,426 tests passed, 11 intentionally skipped. Focused new input,
  Skill PG/guest, cancellation and cleanup tests also passed.
- The 379-case deterministic fault run passed 378 cases; its only failure was a
  stale selector for the removed standalone-steer test. The corrected test now
  exercises `whenBusy: steer`; its exact recheck and the full composer/owned-cleanup
  group passed. The initial failed report and recheck are retained separately.
  This is not presented as a second complete 379-case execution.
- Browser queue, complete presentation and Skill-market interaction checks passed.
  A real Luna request also accepted the exact Skill schemas and produced the
  requested `read_skill` call through the configured provider.
- Matched source/image provenance, 12-image SBOM/vulnerability scans, Helm,
  runtime-policy, formatting, documentation and Docker input checks passed.
- Real Skill acceptance completed all three Runs: instructions without a VM;
  package preparation followed by Node script execution in Cube; and version
  update followed by an idle preferred-steer request that became a new Run.
  Previous Run version selections remained unchanged. Owned resources were purged.
- Native input/live recovery acceptance passed consumption, Stop, Worker crash,
  streaming Stop and simultaneous Worker/Control Plane crash. Retry identities,
  single-Run semantics and native partial-output recovery held; transient streaming
  bodies were not retained in PG. Its owned resources were purged.
- Live Cube/Chromium acceptance passed interaction, canvas/screenshot vision,
  inline images, retained-image reads and live/cold application links. Its owned
  VM, Volume, images and tenant were purged.

The first image build found a missing narrow Skill protocol input in the guest
Dockerfile; the explicit guest export/COPY boundary was repaired and rebuilt.
The first Skill live driver read instructions successfully, then failed on a test
query for nonexistent `workspace_runtimes.id`. It cleaned up its fixture; the
corrected `workspace_id` query passed the complete live check. Neither failure is
counted as successful acceptance.

## Preservation and publication

The two original dedicated allocations were closed only after intake/writers
were quiescent, and physical absence was confirmed. Their Workspace Volumes and
desired running state remained. The restored generations are 34 and 4. Original
applications on ports 4189 and 8000 were restarted from captured commands and
served matching HTML. One allocation lookup returned a transient HTTP 500 before
startup; a read retry succeeded without repeating an uncertain application action.

Before application restart, strict verification matched 14 protected tables,
27 configuration/credential file hashes, 5,941 Workspace files and 121 retained
images. Pre-retirement differences were only normal application-log appends.
After all live fixtures, the protected tables, configurations and all 121 images
still matched. Workspace changes were limited to two application logs and the
already-running application's refreshed data snapshot. Both original allocations
survived the later recovery tests, both application HTML checks passed, and all
29 serving Pods were Ready with no active Run, writer, Tool binding or elastic
fixture remaining. No originals were replaced by test data.

Private evidence is under
`deploy/production/runtime/work-evidence/skill-market-input-20261031/` and
`deploy/production/runtime/release-evidence/skill-market-input-20261031-r2/`.
No user transcript, repository contents or credential values are included here.
The deferred 131 MiB cold-image experiment was not reopened, and the original
conversation was not resubmitted or compacted as a fixture.
