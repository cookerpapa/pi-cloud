# Stock sandbox boundaries after conservative resource admission

Date: 2026-11-10. Issues [#26](https://github.com/cookerpapa/pi-managed-agents/issues/26)
and [#27](https://github.com/cookerpapa/pi-managed-agents/issues/27).
This assessment separates implementation, upstream contracts and unverified
alternatives. It does not authorize an incomplete replacement or data deletion.
The [complete patch inventory](cube-patch-inventory-20261110.md) accounts for every
active upstream path and build transformation, rather than only the lifecycle
features discussed with the owner.

## Result

The approved admission rules are implementable in the existing resource control
plane. They prevent cancellation of unresolved machine creation and reject a
second unresolved application by the same user. They also retain Workspace
occupancy through Worker recovery and unfinished native Stop/seal settlement.

These two rules alone do **not** establish that all Cube customizations can be
removed. They affect public machine admission and resource deletion policy;
elastic/subagent preparation, physical lifecycle evidence, finite retention,
credential bootstrap and recoverable metering still have independent contracts.
The production BoxLite gate is therefore not yet satisfied. Keep the known working
Cube integration while recording specific replacement work, rather than installing
another backend that silently loses those capabilities.

## Cube already supplies the normal lifecycle

Pinned production source is [v0.7.3 / 4411c96](https://github.com/TencentCloud/CubeSandbox/tree/4411c96ba8658a959de34693f54f4918db2a432f).
The latest published release remained v0.7.3 when checked. Master was separately
inspected at [84d9ced](https://github.com/TencentCloud/CubeSandbox/tree/84d9cedf806417b8e86794b86e12138503383f70);
its documentation includes unreleased 0.8.0 interfaces. They are not capabilities
of the deployed v0.7.3 binary.

Cube has create/list/inspect/kill/timeout and independent Volume CRUD. Its
[pinned deletion handler](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/CubeMaster/pkg/service/httpservice/cube/volume.go)
already rejects nonzero reference counts. The
[official Volume guide](https://docs.cubesandbox.com/guide/s3-volume) and
[plugin guide](https://docs.cubesandbox.com/guide/volume-plugin) document independent
storage lifetime, binary/RPC plugins and response-based reference-count drift.
Our remaining extensions strengthen failure boundaries; they do not introduce
basic deletion or reference counting from nothing.

Community [proposal #2129](https://github.com/TencentCloud/CubeSandbox/issues/2129)
identifies an in-flight attach before its count reaches Master and proposes a
state/admission guard. It is open, not shipped acceptance. Project collaborators
emphasize storage's independent lifetime and backend/plugin responsibilities.
[Report #2016](https://github.com/TencentCloud/CubeSandbox/issues/2016) describes
inconsistent create/delete inventory in v0.7.3; it remains a user report, not a
maintainer-confirmed universal failure or a proven replacement protocol.

## What each remaining extension requires

| Concern | Effect of the new rules | Remaining boundary / possible replacement |
| --- | --- | --- |
| Known creation outcome | Unresolved public machine applications cannot be released or replaced by another new application. | A missing response can still leave the native VM identity unavailable. Waiting preserves safety but does not recover an identity that Master failed to record. |
| Allocation close-before-create | Public cancellation no longer races an unresolved initial creation. | Internal elastic/child preparation and resource recovery still use immutable allocation authorization. Replacing this contract requires a complete external reconciliation policy, not removal of the guard alone. |
| Cold execution connection | No change. | Ordinary inspection omits private traffic credentials; the current adapter reads the retained allocation receipt to reconstruct its connection. A stock SDK lookup/connect alternative must preserve identity and deliberate pause. |
| Volume deletion | Active and recovery-pending work blocks deletion; PG closes new application admission before cleanup. | Cube's own asynchronous attach/detach and missing node evidence remain. Its public binary/RPC plugin could own persistent holds and deletion admission, but restart, failed hooks and delayed attach must be demonstrated before removing the native proof. |
| Finite elastic retention | No change to the selected thirty-minute policy. | Current renewal carries original activity time to the allocation journal and expires even an unconfirmed Tool. Ordinary Cube traffic/timeout/LCM semantics need an equivalent contract test; do not introduce a second competing expiry clock. |
| Compute accounting | No change. | Independent metering currently reads retained raw provider history. Upstream lifecycle publication is best-effort and cannot by itself recover a missed transition. Removing this extension requires an accepted alternative source/coverage policy. |
| Template/node cleanup and dependencies | No change. | These fixes are unrelated to public resource admission. Compare upstream fixes and image scans independently; zero business patches and zero build/dependency changes are distinct claims. |

The v0.7.3
[create path](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/CubeMaster/pkg/service/sandbox/sandbox_run.go)
learns the sandbox ID from the Cubelet reply, updates Volume references from that
reply and persists the sandbox spec after successful node creation. Spec write
failure is logged rather than made a durable pre-effect reservation. This is the
specific identity gap an external consumer must account for.

The native [lifecycle store](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/CubeMaster/pkg/lifecycle/store.go)
uses Redis hashes/streams, but deliberately logs and swallows publication errors.
The [lifecycle manager](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/cube-lifecycle-manager/README.md)
coordinates auto-pause/resume and idle actions. An existing stream is not evidence
that every physical transition is recorded or that it provides metering's selected
history/gap contract. Reuse it where appropriate; do not mistake it for that proof.

## External implementation options

Prefer the existing resource controller for intent, serialized admission and
reconciliation. Prefer Cube's official Volume Plugin for backend-specific
Create/Destroy and node Attach/Detach. The pinned Attach/Detach requests include
the sandbox identity and opaque cleanup metadata, so a separate plugin is a real
extension point, not a fork of Cube. PiCloud already uses a POSIX plugin.

Moving holds there still requires durable registration before exposing a mount,
atomic exclusion against deletion, idempotent recovery and positive release
evidence. A missing hook or unreachable node must retain an uncertain hold. Merely
adding a PG counter or waiting a fixed number of seconds is insufficient. Such a
replacement should have exactly one physical reference authority at cutover.

An external controller can promise eventual cleanup of identifiable late-created
resources. It cannot promise to reject a request already accepted inside Cube,
or reconstruct a resource absent from every authoritative lookup. Any relaxation
from immutable close-before-create must explicitly preserve pending uncertainty,
quota/resource ownership and Workspace safety.

## Android and BoxLite audit

The retained Android operator prototype uses stock hash-pinned Cuttlefish host and
system archives, stock Appium, and a PiCloud-owned external execution adapter.
No Android/Cuttlefish, UiAutomator2 runtime JavaScript or APK source patch was found.
The previous build rewrote the UiAutomator2 8.7.0 package manifest to remove bundled
dependency handling and raise optional Sharp. That is a packaging customization,
not an Android VM fork, and is a candidate for removal with upstream packaging.

UiAutomator2 8.7.3 is compatible with Appium 3 and already pins Sharp 0.35.5 in its
[official npm distribution](https://registry.npmjs.org/appium-uiautomator2-driver/8.7.3).
The source implementation now uses this integrity-locked registry package and
removes the generated manifest, extraction script and separate archive pin.
Ordinary npm installation and Appium driver discovery passed; the driver reports
`installType: npm`, version 8.7.3, with Appium 3.8.0 and Sharp 0.35.5. The high/
critical npm audit gate passes; image and real-device acceptance remain separate.
Root dependency overrides are deployment configuration, not upstream runtime
source changes. The latest 9.0.1 instead
requires Appium 4 beta; there is no reason to force that major migration merely
for this cleanup. No Android product picker is re-enabled by the audit.

BoxLite's latest published release remained [v0.12.0](https://github.com/boxlite-ai/boxlite/releases/tag/v0.12.0).
The earlier [pinned study and real isolated probe](execution-boundaries-20261108.md)
remain applicable: ordinary OCI execution and source clipping worked without
BoxLite source changes; the inspected local configuration stopped the Box when
its owner process exited. The separate long-lived Runner, fixed Guest privileges,
callback transport, storage ownership and metering require integration acceptance.
Do not translate that local probe into a claim of production backend parity.

