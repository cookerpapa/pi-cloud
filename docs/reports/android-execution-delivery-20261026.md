# Android execution target delivery

Status: deployed. Core `android-a37491f4`, source
`a37491f4f202320e7e62682dbc27454bb6ace008`, schema 201 / tool catalog v2 / Helm 110.
Device release `android-7aa30c34`, source
`7aa30c349c00920888c6f45ad3979153bf797e56`, device Helm revision 3.
The owner approved [ADR-0279](../adr/0279-android-execution-targets.md).

## Behavior and authority

An idle coding Session can bind one tenant-owned cloud Android target in the
Cloud phone picker. Root Conversations receive `android_observe`, `android_tap`,
`android_swipe`, `android_input_text`, `android_key` and `android_open_app`.
Children do not inherit device control. Existing Cube Workspace tools remain
available; the Android path does not allocate a Cube VM.

PG owns target selection and the Run's frozen capability grants. Worker native
intent follows the existing Session Kafka log. The same Projector confirms its
dispatch position, then sends the operation to the trusted Android executor.
Appium/UiAutomator2 drives Cuttlefish; the executor uploads screenshots to the
existing object store and publishes replies to the original Worker's boot-scoped
Kafka transport. Pi processing still precedes canonical Tool Results. No second
queue, broker, scheduler or result ledger was introduced.

The Android guest holds no Kafka/PG/provider credentials. Destination admission
uses target identity, executor boot, generation, writer and offset plus index.
Uncertain actions are not replayed. Native Stop/cancellation does not undo an
already-delivered tap or kill the device/application. Device userdata is distinct
from the coding Workspace and retained across device replacement.

## Verification

- Fixed public-Pi native tool/catalog contracts, target binding races and frozen
  grants, root/child isolation, ordered dispatch and executor cancellation/unknown
  behavior pass. The full workspace run identified two stale admission SQL-count
  expectations; after updating them for the new capability lookup, the focused
  Control Plane rerun passed all 82 cases. Other workspace checks passed. Final
  Web API regression checks pass all 25 cases, including JSON bind and unbind.
- The existing real PG/Kafka transport suite passes nine cases, and all 375
  deterministic fault cases pass. These are not a claim of 375 live cluster crashes.
- A real device plus isolated RF3 Kafka reply transport passes observation and
  revoked-binding rejection. Its test image store is not counted as S3 acceptance.
- Real Luna on the deployed core and restarted production device passes all six
  tools in nine model requests. It opens Android Settings, observes, swipes, taps,
  enters and reads back `PiCloud你好`. Three PNGs (713,048, 93,560 and 35,628 bytes)
  are retained as image references and independently read/hashed from S3.
- The actual deployed Web binds the owned test Session, renders all three retained
  images, shows the bound device and refreshes its current screen. A private
  browser capture was visually checked. The device-only Run creates no Cube
  allocation. Its Session, Workspace and temporary credential are cleaned up.
- A real Pod/guest restart changes both identities while retaining a synced file
  and a persisted Android setting. The test-owned markers are then removed.
- Existing real Luna/Cube checks pass coding, warm-VM reuse, background service
  retention, authenticated Preview, persistent files after VM replacement, stale
  VM dispatch rejection and physical fixture cleanup.
- Native input acceptance passes consume/edit, Stop and Worker recovery, plus
  stopping streamed text and simultaneous Worker/Control Plane crashes. Partial
  text is preserved, streaming bodies are not accumulated in PG, and recovery
  stays in the same logical Run. These checks used the same schema/Worker runtime
  before the final browser-header-only fix; the final device run used the final
  deployed core artifact.

## Corrected failures and limits of the evidence

Early deployment attempts exposed an OnDelete rollout-wait assumption, the
replacement Pod's creation gap, symlinked directory secret mounts rejected by
existing readers, and a missing private Control Plane egress rule for the device
endpoint. The maintained release helper/chart now handles those cases.

The first native acceptance stopped before model execution because the browser
API helper omitted the JSON Content-Type on binding. It now uses the existing
JSON request helper. Browser fixtures also initially raced an unloaded selection
and clicked the Cloud phone button while it was still disabled. The maintained
check waits for an enabled button/loaded selection and captures failure evidence.
No failed run is counted as final acceptance.

The first restart probe wrote a setting and immediately stopped the VM; the
setting was absent afterward, while older persisted settings remained. Android's
[SettingsState implementation](https://android.googlesource.com/platform/frameworks/base/+/4fa4b29890a85da661403ac85fad56d21acc093f/packages/SettingsProvider/src/com/android/providers/settings/SettingsState.java)
updates memory before an asynchronous disk write. The successful probe waited
2.5 seconds, synced an independent file, then restarted and verified both. This
proves persistence of committed guest data, not zero loss of application memory
on power failure. Android startup can take several minutes; the executor becomes
Ready after the guest and Appium are ready.

## Publication and preservation

All 12 matched images and four Android images pass the maintained provenance/SBOM
and zero-fixable-HIGH/CRITICAL gate. This does not claim zero vendor vulnerabilities.
The original Workspace Volume was retained while its previous compute allocation
was closed and physical absence confirmed. The same logical development machine
recovered and its three original applications were restarted; their response
hashes match. No account, model/provider configuration or credential was reset.

Final reconciliation preserves all protected rows across 15 tables, the three
original Sessions/native histories, 5,701 Workspace files and 37 original image
objects. Expected PID/log/WAL runtime changes are distinguished from user bytes.
All 29 non-completed Pods are Ready. The device is left unbound for the owner;
there are no active fixture Runs, writers or device admissions. Seven test image
objects from the two successful native runs were removed after their Sessions
and all references were gone. Earlier failed diagnostics remain private.

Evidence is retained privately under
`deploy/production/runtime/release-evidence/android-execution-20261026/`:
`android-live-attempt4.json` and its PNG, `android-restart.json`,
`native-input-live.json`, `cube-live.json`, `preservation-after.json`,
`images-verify.json`, `android-image-cleanup.json`, and
`binding-fix-maintenance/final-state.json`. These contain local fixture identities
and are not committed as public data.

The first slice deliberately remains one operator-provisioned, node-affine cloud
Android target beside a coding Workspace. Pure-phone Sessions, physical-phone
apps, APK installation, camera tools, automatic allocation/pools, multi-node
placement and simultaneous human/Agent interactive control are later work.
