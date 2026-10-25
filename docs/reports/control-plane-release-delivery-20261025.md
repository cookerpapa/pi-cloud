# Scoped Control Plane release delivery — 2026-10-25

[ADR-0276](../adr/0276-scoped-control-plane-releases.md) is implemented and deployed.
The initial `control-foundation-3e2e182d` matched installation (Helm revision 99)
installed quiescence and its deployment contract marker. The final
`control-final-35d715ae` publication (Helm revision 101) built/scanned/replaced only
the Control Plane image. Other components retain their foundation artifacts and
original evidence. Schema 198, Pi 1.0.0 and Cube/guest execution protocols are unchanged.

## Delivered behavior

Ordinary Tool implementations and registration now live under
`packages/control-plane/src/ordinary-tools/`. Adding a tool on the existing
transport does not require editing Worker code or the process startup module.
The maintained `release:component` operator accepts `control-plane` for this
scope, and CI selects one image and the relevant Tool/catalog/dispatch contracts.
Dependencies, ownership, lifecycle, protocol, public API and schema changes remain
outside this narrow source admission. The initial topology is one Control Plane
without an HPA. No browser update notification was added.

Quiescence lets projection continue until Control Plane handlers and
non-replayable native results settle. It then parks subsequent records before
PG projection or dispatch acknowledgement. Repeatable child waits and running
Cube Bash commands do not require the whole Run to finish. Local hold expiry or
cancellation resumes the old process; SIGTERM checks again at actual termination.
The operator uses the existing sandbox-owner lease boundary, Helm and the release
lock, retaining all Worker and VM identities during a compatible replacement.

Effective domain discovery uses `helm get values --all`; image rendering still
uses the original overrides. A missing domain or missing/non-unique live owner
refuses replacement before stopping a Pod. Operator journals support retry of the
same candidate and restore the exact old template before Helm mutation. An
unresolved Helm pending operation still requires inspection; zero downtime and
recovery from arbitrary infrastructure failure are not claimed.

## Verification

- All workspace type checks, relevant formatting/documentation/runtime/Helm/
  image-input checks and source dependency audit passed.
- The final narrow check passed **137 tests in 17 files**, with 48.79 seconds of
  test execution. It covers real PG, native Tool/catalog adapters, non-replayable
  result settlement, hold expiry/cancellation/shutdown, one-image source/manifest
  admission and interrupted operator recovery. Type checking is additional.
- **Nine real RF3 Kafka/PostgreSQL tests passed.** The replacement case parks an
  actual record, confirms it has not reached PG, stops the old consumer and verifies
  the replacement projects it; it is not silently acknowledged during shutdown.
- Initial matched artifacts passed the twelve-image gate. Both scoped candidates
  passed a one-image gate; unchanged images were not relabeled as freshly scanned.
- Final real GPT-6 Luna/Cube acceptance retained the same active Run, Session
  lease/fencing token, Worker boots, VM allocation and every unrelated Pod. Existing
  user development machines retained their allocation and generation too.
- A Bash command remained active through publication and its file counter remained
  exactly one. After the gate opened, that same command completed and the next model
  request used the updated Preview definition. The native Preview call succeeded.
- The final operator receipt names one actual old sandbox owner; PG confirmed its
  authorization had ended. The full apply command took **34.432 seconds**, including
  image import and readiness, not a measurement of pure outage duration.

## Failed samples and corrections

The first broad check reported 522 passes and seven default-5-second timeouts in
the seal-publication PG file. The package's maintained settings are 30 seconds
per test and 60 seconds per hook. The file passed 9/9 when rerun with its original
budget, without changing runtime timing assertions; the scoped runner now uses
the maintained settings.

Early live fixtures exposed invalid test input (`timeout: 600` against the
existing Bash maximum of 300), incompatible operator database budget options,
and a missing operator-test allowlist entry. These attempts did not replace the
serving Control Plane and their owned resources were cleaned up. The first early
fixture lacked enough retained error detail; later attempts preserve bounded
diagnostics. Admission, the actual database constructor, and preflight-before-model
coverage were corrected.

An initial scoped continuity run passed in 45.337 seconds, but inspection found
an empty old-owner list caused by reading only Helm overrides. This was not accepted
as final ownership-boundary proof. Effective-value lookup, positive owner admission
and acceptance assertions were added, then a fresh scoped publication passed all
final checks. Private evidence retains these failed/intermediate samples separately.

## Assets and current state

The initial matched installation confirmed old compute absence before replacing
it, retained the logical development machine and Volume, and restored both original
application servers. Subsequent scoped updates kept that allocation unchanged.
Both applications still serve matching HTTP body hashes. Fifteen protected PG data
sets, 55 Workspace files and 27 credential/configuration files match their preserved
state; only the expected PID/runtime log changed during the initial compute restart.

All owned fixture Sessions, VMs, Volumes and tenants were cleaned up before their
ownership records were purged. Final checks found 28/28 serving Pods ready, no active
Run/writer/Tool binding or elastic fixture, and the user's development machine ready.
Reports are under the ignored private
`deploy/production/runtime/release-evidence/control-release-20261025/` directory;
no credentials, user transcripts or Workspace files are committed.

Commands and boundaries are documented in [component releases](../COMPONENT_RELEASE.md).
