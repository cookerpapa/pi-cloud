# Cubelet → guest execution repair

Status: source implemented and required CI passed; matched deployment pending,
2026-10-15. Baseline `a0886962`; runtime repair `2b3909af`;
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
configuration and credentials must be preserved across the matched cutover.

## Source verification

The complete `npm run ci` passes on the clean runtime repair commit: build,
all workspace typechecks/tests, real RF3 Kafka/PG transport (eight tests), all
244 deterministic fault cases and dependency security audit. The audit reports
no vulnerabilities. Native admission/allocation/service, installer, Helm,
observability and image-closure checks also pass.

- Native lifetime regressions and the full patched execution package pass under
  the race detector, including stalled Kill, expired/cancelled preparation, lost
  Start reply and namespace retention.
- Seven focused protocol/guest/provider/dispatch/controller suites pass all 197
  tests. Updated Sandbox Control, guest and Control Plane typechecks pass.
- The maintained browser driver now requires actual Read calls with `@`-prefixed
  paths through guest, completion and canonical model history; live execution is pending.
- Review-only reproductions are replaced by maintained regressions. Their original
  source is archived in Git `a0886962`; the review's JSON evidence remains.

These source checks do not represent a completed deployment. Record
artifact scans, matched rollout, real Luna/Cube/browser/native-input/child
recovery, failed samples and confirmed fixture cleanup before marking delivery done.
