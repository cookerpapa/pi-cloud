# Stock sandbox portability validation — 2026-11-11

Tracking: [#27](https://github.com/cookerpapa/pi-managed-agents/issues/27).
Decision: [ADR-0312](../adr/0312-unmodified-alternate-sandbox-validation.md).
Preceding [template/node cleanup](cube-metadata-cleanup-20261111.md) is complete.

## Result and scope

The same fixed Linux Guest runs on unmodified BoxLite, and the retained Android
target works with official automation packages. Neither experiment changes Pi's
agent loop or patches a sandbox engine. Cube remains the supported default.
This proves execution portability; it is not a completed general-purpose
BoxLite resource-management integration or full parity between all targets.

| Target | Verified result | Remaining boundary |
| --- | --- | --- |
| Stock Cube R5 | Current serving path; old templates and private node buckets removed | Compute observations remain unconfirmed/unpriced |
| BoxLite 0.12.0 | Real KVM, the unchanged fixed Guest and HTTPS completion | Operator adapter only; production selection, managed Workspace/quota integration and elastic expiry are not enabled |
| Android/Cuttlefish | Updated target images, real Luna/API/Worker/Projector execution, retained screenshots and device restart | Existing operator prototype; phone UI remains hidden, physical phones and Linux-style pending-wait recovery are not implemented |

## BoxLite: configuration matters

Pinned upstream version: `0.12.0`, commit
`f5593da68c23cb0c0a0d230eb9cb01e04cccd610`. All 37 hashed installed SDK files
matched their package records. No Rust, native Guest, libkrun or engine dependency
source was edited. The probe reused the current PiCloud Guest image and its
existing admission/cancellation/result code.

The default jailer configuration on this WSL host failed two requirements:
changing the mounted Workspace to Guest UID 1000 returned `EINVAL`, and detached
stop/removal left shim processes after the SDK reported removal. These are
observed failures of this version/configuration, not a claim about every BoxLite
deployment. Exact owned fixture processes were reconciled and removed; they
were not silently counted as native cleanup success.

An explicit alternate **official configuration** passed: trusted SDK as host
root, `detach=True`, `auto_delete=0`, Guest-container `privileged=True`, and
`SecurityOptions(jailer_enabled=False, seccomp_enabled=True)`. The Guest supervisor
can manage its VM-local cgroups; actual Tools still run as UID 1000 with
no-new-privileges. KVM remains, but the optional host shim jailer is disabled.
The pinned [shim source](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/src/shim/src/main.rs)
also gates its VMM seccomp filter on `jailer_enabled`: the configured `True` flag
does **not** activate that filter in this trial. This is a real defense-in-depth
tradeoff, not an equivalent configuration
hidden behind the same production policy.

Seven real execution checks passed in that configuration:

- Killing the SDK caller leaves its detached VM running; a replacement reconnects.
- The fixed Guest rejects changed/duplicate execution and returns the original
  result through scoped HTTPS after caller loss, with one observed file effect.
- A 200 KB Bash output is reduced at source to the existing approximately 50 KiB bound.
- Native write/edit/read and a real PNG read return through the same Guest callback.
- Cancellation targets the selected running operation and returns the aborted result.
- Killing/replacing the Guest service preserves the already accepted child operation.
- VM stop/start retains Workspace files and rejects the previous boot's operation.

The final native stop/removal also passed, with no owned shim processes left.
Test caches were removed after process absence; private failure/success evidence
was retained. Initial fixture errors in Pi 1.0 edit arguments and PNG bytes were
corrected before the complete passing run.

The probe's callback uses the real HTTPS admission/Guest protocol with an isolated
receiver. It does **not** demonstrate a complete production BoxLite
PG/Worker/Projector/Kafka deployment. The adapter never invents a second scheduler,
result database or command-replay mechanism.

Local BoxLite AutoStop is unsupported, and standalone `boxlite serve`'s managed
Volume routes are also unsupported. Host-directory mounting does work in the
passing configuration. Do not pretend these APIs equal the full BoxLite cloud
service, add a competing PiCloud expiry clock, or enable BoxLite as a silent Cube
fallback. A dedicated-provider vertical slice remains a possible next step.

## Android: independent publication and live path

Published `stock-android-20261111-r2` from source `25a6425f`, using the unchanged
Cuttlefish build `16644040`, Appium `3.8.0` and UiAutomator2 `8.7.3` inputs.
All four owned wrapper images passed the existing release gates with zero
fixable High/Critical findings; no new exception was used. Core application
images remain stock-Cube R5. A fresh SHA-512 archive check and byte comparison
verified 133 Appium/driver runtime/manifest files, including all three bundled
APKs, against official npm archives. No engine/runtime-code rewrite was added.

Two retained-prototype integration assumptions were corrected: private device
access now includes the separate Session Runtime and Session API, and the egress
configuration endpoint uses the actual Session Runtime service instead of the
removed Control Plane port. No Worker or Pi-core changes were required.

A real GPT-6 Luna conversation exercised `android_key`, `android_open_app`,
`android_observe`, `android_swipe`, `android_tap` and `android_input_text`.
Chinese input was observed, three screenshots were retained and displayed in the
browser, and no Cube VM was allocated. The API screen read and hidden phone-picker
check passed. Its temporary conversation, Workspace and credential were cleaned.

A subsequent device restart changed the guest boot identity while retaining an
owned SettingsProvider value and filesystem marker. Both markers were removed
after verification. The original userdata file identity was retained; the target
was restored to its original **zero replicas**, with no Pod left running.
The external receiver initially retried while Android was booting, then became
Ready; this was not an engine crash or userdata reset.

Android is a different execution shape: the trusted external receiver uses
Appium and the official automation APK, then the existing Kafka/image adapter.
The Android OS/APK does not hold Kafka/PG/S3 credentials. This is zero engine
patching, not a claim that the Linux Node Guest binary runs inside Android.
Interrupted UI actions remain UNKNOWN and are never automatically replayed;
full replacement-Worker restoration of those pending waits remains separate work.

## Final state and follow-up

Original accounts, model/provider configuration, credentials, both development
machine intents and 394 original source/image files passed preservation checks.
Original machines remain Ready. No original Workspace or device userdata was
deleted. Compute pricing remains unchanged and unconfirmed intervals stay unpriced.

Relevant source checks passed: Android type checking and seven executor tests,
Android chart assertions and documentation validation. The earlier cleanup has
its own ten JavaScript and five bbolt tests. Builds and resource-intensive live
checks were run in separate phases. Package-download proxy failures were resolved
using direct official Debian downloads for this build, without changing model
traffic or the configured proxy port.

#27 remains open for **production promotion**, including the general BoxLite
provider/Workspace contract, accepted host isolation policy, native elastic
lifetime support and Android pending-operation continuation. The requested
zero-source-patch execution experiments are complete; these remaining capabilities
must not be inferred from them.

Sources: [BoxLite release](https://github.com/boxlite-ai/boxlite/releases/tag/v0.12.0),
[native lifecycle options](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/src/boxlite/src/runtime/options.rs),
[standalone Volume handler](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/src/cli/src/commands/serve/handlers/volumes.rs),
and [Android operator contract](../ANDROID_EXECUTION.md).
