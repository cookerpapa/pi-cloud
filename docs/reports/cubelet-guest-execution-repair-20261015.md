# Cubelet → guest execution repair

Status: implemented, deployed and accepted as `guest-execution-5536fc73`,
2026-10-16. Baseline `a0886962`; runtime repair `2b3909af`; release revision `5536fc73`;
decision [ADR-0251](../adr/0251-guest-attachment-and-execution-bounds.md).
The owner approved all four findings from the
[review](cubelet-guest-execution-review-20261015.md).

## Changes and acceptance

- R15G-01: after the cleanup helper's parent expires, final Kill receives its own
  five-second context with the native namespace preserved. Missing stopping proof
  retains the existing unsafe/UNKNOWN outcome and Control Plane recovery ownership.
- O15G-02: known expiry/cancellation is checked before setup and again immediately
  before issuing Start. Unstarted native handles still get bounded deletion.
  An already-issued Start with a lost reply never becomes definitely unexecuted.
  Pinned CubeShim source confirms `create_exec` registers metadata and the actual
  guest `exec_process` request is issued by `start_exec`; unstarted deletion removes
  its metadata without waiting for a process to run.
  The maintained native change is `0008-bounded-tool-process-lifetime.patch`.
- R15G-02: the guest Read adapter matches pinned Pi path normalization and existing
  filename-variant precedence. Existing file guards run after interpretation;
  native Edit/Write retain their own single normalization. Public SDK comparisons
  cover leading/doubled `@`, Unicode variants, conflicting filenames, Write→Edit→Read
  and image paths. Bounded streamed reads and source image processing remain.
- O15G-01: guest protocol 6 distinguishes full `worker.initialize` from fixed
  `worker.operation` with a minimal attachment and request. Descriptor version 2
  carries the attachment. Remove unused recipe/seed metadata and the outer wrapper,
  parse the native guest message once, and verify attachment identity before effects.
  Workflow remains on its separate transport. The release gate also waits for
  zero Tool bindings before changing their transient descriptor shape.

Contracts: PG 189 / execution Topic v17 / boot reply v3 / guest 6 / Cube management 7.
No compatibility decoder, storage migration or business-data reset is introduced.
Full environment preflight remains at activation/adoption. Accounts, model/provider
configuration and credentials are preserved across the matched cutover.

## Source verification

The complete `npm run ci` passes on the clean runtime repair commit: build,
all workspace typechecks, 1,804 workspace/helper tests (ten conditional skips),
real RF3 Kafka/PG transport (eight tests), all
244 deterministic fault cases and dependency security audit. The audit reports
no vulnerabilities. Native admission/allocation/service, installer, Helm,
observability and image-closure checks also pass.

- Native lifetime regressions and the full patched execution package pass under
  the race detector, including stalled Kill, expired/cancelled preparation, lost
  Start reply and namespace retention.
- Seven focused protocol/guest/provider/dispatch/controller suites pass all 197
  tests. Updated Sandbox Control, guest and Control Plane typechecks pass.
- The maintained browser driver now requires actual Read calls with `@`-prefixed
  paths through guest, completion and canonical model history; live acceptance passes.
- Review-only reproductions are replaced by maintained regressions. Their original
  source is archived in Git `a0886962`; the review's JSON evidence remains.

## Matched release and live acceptance

The clean verification commit prepared eleven images and passed the maintained
source/SBOM/vulnerability gates. The new guest build identity is
`b75b4567acab45e73b8e0c4d088ad23cdc72b004`. PG ownership counts, Tool bindings and
complete native inventory were zero before cutover. Writers were drained before
Cube/guest/application replacement; new templates were registered and the matched
operator completed without a partial fallback.

All model-backed acceptance uses GPT-6 Luna:

- Full Cube suite passes on the first attempt: chat without activation, real
  file/Bash execution, preview, warm reuse, background-service preservation,
  tenant isolation, deletion/late-admission rejection and 1,024-file restoration
  into a fresh VM from the existing persistent Volume.
- Native input acceptance passes all five scenarios on its complete retry:
  consume, Stop, Worker crash recovery, stream Stop and simultaneous loss of Worker
  and Control Plane memory. The same Run and native partial output are preserved;
  streamed text bodies stay out of PG. Faults include actual exit-137 evidence.
- Real browser acceptance passes Stop/returned input/image resend with fresh input
  identity and direct vision. Both oversized ASCII/Unicode Read calls actually carry
  `@`-prefixed paths and produce correct bounded content and native diagnostics.
- All five native child scenarios pass: supervisor interaction, messaging,
  parallel children, cancellation and guest workflow boundary, with one Session owner.
- Same-image Control Plane replacement during an active native child completes
  in 13,041 ms. The original Worker continues, the control reply recovers and Bash
  executes once. The child completes after readiness. This does not establish
  compatibility of arbitrary cross-version upgrades or a user-visible outage bound.

## Failed samples and acceptance diagnostics

The first native-input attempt passed consume, Stop and Worker recovery, then the
`stream_stop` fixture ended before observing active output. Its original report
did not preserve the terminal/model outcome, and its resources were purged normally.
The cause is unconfirmed; do not attribute it to TLS, guest execution or a fixed
streaming defect. The complete retry passes all five unchanged assertions.

The operator helper now records bounded unexpected-end metadata before cleanup:
scenario/Run state, failure code, model stop reasons, text count and an EOF indicator,
without model text or credentials. This diagnostic-only change does not alter
deployed guest/completion inputs or weaken acceptance. Syntax and maintained helper
checks accompany the successful live rerun.

During the injected dual crash, one replacement Worker startup also exited 1 at
16:36:24 UTC with a later successful restart. The same-Run recovery and subsequent
handoff pass. This is not a zero-extra-restart claim or a diagnosis of the startup
failure's internal cause; similar behavior was recorded in the preceding release.

## Cleanup and preservation

Normal lifecycle deletion and confirmed node absence preceded metadata removal.
The full Cube fixture's tenant and three owned projects were purged; native-input
and browser drivers removed their own tenants/images. Final inventory scans 1/1
nodes with zero VMs. No unfinished Run/seal, active writer, Tool binding, VM, machine
or terminal remains, and all maintained application Pods are ready. The temporary
build relay is stopped and the private native source checkout is removed.

Before/after counts and SHA-256 digests match for 32 tenants, 32 users, 32 API
credentials, five password credentials, 35 model profiles and 35 credential
bindings; source-control credentials remain empty. API credential comparison
excludes only its usage timestamp on both sides. Original conversation assets and
the execution Topic remain; no business-data reset was needed.

The independent cleanup Kill remains bounded by its own five-second allowance;
an unconfirmed stop still cannot prove physical stopping or authorize replay/quota
release. The known-before-Start refusal does not reinterpret an ambiguous Start
reply. These repairs retain Control Plane VM ownership and ordinary cancellation's
process-group boundary. The next reading hop is the guest result → Cubelet completion
adapter, followed by Kafka delivery.
