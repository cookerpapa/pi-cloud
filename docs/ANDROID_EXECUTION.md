# Android execution targets

Status: integrated operator target under ADR-0313, with
[real six-tool, image, Worker/receiver recovery and VM-restart acceptance](reports/alternate-runtimes-20261112.md).
The current core uses schema 222, Session topic v21 and executor protocol 2.
The [November 13 delivery](reports/decoupling-delivery-20261113.md) adds administrator
registration for an explicit organization and resource-page device binding, and
revalidates tools, images, Worker/receiver recovery and retained userdata.
The current device artifact is `android-20261112-r3`; initial October acceptance
is recorded separately in [the historical delivery report](reports/android-execution-delivery-20261026.md).
The dedicated cloud-phone picker remains hidden.

The October 27 owner decision withdraws the cloud-phone picker/screen controls
from the product page. The execution-target abstraction and operator API remain
as a verified integration; no backend/device data is deleted. Under ADR-0319 an
administrator registers an already running device with
`{ tenantId, device: { targetId, name, endpoint } }`. The organization's resource
page can connect an idle coding conversation to that device. This does not create
an emulator pool or share the device across organizations. The next Run receives
the device capabilities. Its root Agent can observe
the screen, tap, swipe, enter text, press a navigation key and open an installed
application. Child Agents do not inherit control of that screen. A coding Workspace remains part of the conversation, but the selected target
controls which execution tools are exposed. Device application storage is separate.

## Data flow and ownership

PG stores device registration and the user's Session binding. Run admission
freezes the selected target and capability revision with one bounded query;
ordinary input intake now has nine business SQL statements (two on an idempotent
retry). Binding changes require the existing Session lock and no active owner.

The first device operation creates a bounded admission descriptor for the current
Session writer. Its authorized change follows the existing Kafka Session path
into the Projector's memory view. Subsequent dispatches read that view, not PG.
The shared Projector confirms its dispatch position before sending an operation.
The trusted executor acknowledges admission, invokes Appium/UiAutomator2, and
delivers a bounded result through the same scoped HTTPS completion client as the
Linux Guest. Completion stores images and publishes to the original operation's
Worker reply topic. The Worker
passes the reply to Pi before a canonical Tool Result enters native history.
No independent broker, executor command queue or Tool-result database is added.

Android and its executor have no Kafka, database, object-store or model credential.
The executor keeps only its private command-admission credential; each operation
carries an expiring completion capability. Screenshots use the existing attachment
inventory/object store; Kafka carries references. The operator screen endpoint
reads a disposable screenshot directly and does not add it to model context.
Android application data lives in its own persistent device state directory;
that directory is distinct from the coding Workspace Volume.

## Failure and cancellation

Admission is tied to device identity, executor boot, PG-issued generation, Session
writer and Kafka offset plus operation index. A duplicate receipt cannot execute
the same tap again. Different operations in one committed Kafka batch keep their
index. An executor restart changes its boot identity and rejects old descriptors.

An action or reply lost in transit is UNKNOWN. Unsafe UI actions are not retried.
The current Run stops accepting further device work/model continuation on that
uncertainty; a later Run can explicitly observe the device and decide what to do.
Per-operation transport deadlines do not impose a total Run-duration limit.
The pending native Tool keeps its original reply topic/offset, operation identity,
absolute deadline and cancellation binding in the existing native storage fields.
A replacement Worker restores that subscription and reattaches its Tool proxy
to the original wait. It does not request the action again or reset its deadline.
Worker retirement closes admission without aborting an accepted action. A closed
binding remains available for exact cancellation until native settlement, and
an old cancellation cannot affect a newer operation. Device/executor loss can
still yield UNKNOWN; no result source is invented and UI effects are not replayed.

Chat Stop retains Pi Durable settlement and ordered operation cancellation. It
can prevent a pending action or abort cancellable I/O, but does not undo a tap,
kill an application or destroy the device. Closing admission retains its cleanup
address in PG until the executor confirms closure. Rebinding/deleting a Session
cannot discard an unresolved descriptor. Missing heartbeats never authorize
userdata deletion or action replay.

## Operator installation

Use the current maintained K3s installation and matching Worker/Session Runtime
protocols. The initial schema/catalog numbers above are historical evidence,
not a downgrade target. A matched upgrade must drain writers first.
Do not expose Appium, ADB, device management credentials or Kafka to public clients.

The first installer provisions one node-affine device. It uses the pinned
Cuttlefish host/system build from `deploy/android/artifacts.json`, a persistent
owned host directory, Appium 3.8.0 and UiAutomator2 8.7.3. It has no independent
Android scheduler or self-service VM lifecycle. Multi-node placement requires an
explicit owned local PV/node; the helper refuses to infer it.

```sh
npm run android:prepare -- /var/lib/pi-cloud/android/device-one
node scripts/run-android-release.mjs prepare \
  PRIVATE_CANDIDATE_DIRECTORY VERSION pi-cloud/control-plane:MATCHED_VERSION
node scripts/run-android-release.mjs apply \
  PRIVATE_CANDIDATE_DIRECTORY /var/lib/pi-cloud/android/device-one TENANT_UUID
```

Use a new private candidate directory for each release. Preparation verifies
upstream archive hashes and does not overwrite an initialized device. `target.json`
contains its stable ID and vsock CID; provision each concurrently running device
with a distinct CID. The fixed host/image binaries are separate from writable
state. The deployment helper builds/scans four images, retains the image evidence,
imports them into K3s, and registers the verified executor endpoint for the tenant.
UiAutomator2 is installed from its official npm package with the archive integrity
and dependency graph pinned in the lockfile. Version 8.7.3 already supplies the
required Sharp version; the old archive extraction and package-manifest rewriting
step is removed. Root dependency overrides remain ordinary deployment configuration.
No Android/Cuttlefish, Appium/UiAutomator runtime code or APK is patched.
The #27 packaging change requires its own image and device acceptance; historical
deployment evidence at the top of this guide is not proof of that new release.
That acceptance is now recorded in the [2026-11-11 stock-driver publication](reports/sandbox-portability-20261111.md):
all six tools, retained screenshots/browser display and device restart passed.
The original userdata remains, and the operator target was returned to zero replicas.
The target chart authorizes private calls from the independent Session Runtime
and Session API as well as resource administration; it no longer assumes those
roles share the Control Plane process. This concerns only the existing target
port, not public access to ADB or Appium.
The Android Pod has no Docker socket or host-home mount. Only its trusted
executor/egress containers receive the minimal required service credentials.

An `OnDelete` StatefulSet prevents automatic device replacement during an
unrelated Helm change. The release helper rejects active bindings/Runs before
replacement. Replacing the Pod preserves device userdata. Device deletion is an
explicit operator task after unbinding and confirming admission closure; removing
a Session does not erase the phone's application data.

Private registration CLI (inside the matching Control Plane image):

```sh
node node_modules/tsx/dist/cli.mjs --tsconfig packages/control-plane/tsconfig.json \
  packages/control-plane/src/execution-target-admin.ts \
  register TARGET_UUID TENANT_UUID NAME http://EXECUTOR_SERVICE:8090
```

Public APIs list tenant-owned devices and change an idle Session binding; callers
cannot supply execution endpoints or credentials:

- `GET /v1/execution-targets`
- `GET /v1/conversations/:sessionId/execution-target`
- `PUT /v1/conversations/:sessionId/execution-target` with `{targetId, revision}`;
  a null target unbinds, and a stale Session revision conflicts.
- `GET /v1/execution-targets/:targetId/screen` returns a PNG observation.

## Verification and current boundary

The maintained checks cover binding races, capability/root isolation, native
intent encoding, ordered destination admission, duplicate/stale delivery,
cancellation and uncertain replies. The opt-in
`scripts/run-android-transport-check.mjs` exercises a real owned Android device
and an isolated RF3 Kafka cluster; it deliberately uses a test image store.
The deployed path additionally passes real native model calls, S3 checksum reads,
Web history-image rendering, API binding/screen reads and restart retention. Repeat the owned
fixture only while the selected device is unbound:

```sh
PI_CLOUD_LIVE_ANDROID_CHECK=1 node --import tsx scripts/run-live-android-check.mjs \
  TARGET_UUID PRIVATE_REPORT_PATH
```

This uses a temporary owner credential and an empty coding Workspace, drives the
API binding and all six tools with Luna, checks persisted screenshots
and no Cube allocation, then deletes its Session/Workspace and revokes/removes
its own credential. Reports and browser captures stay private. It never takes over
an already-bound device. Transport-only success is not evidence of this whole path.

Device restart retention concerns writes already persisted inside Android. A UI
acknowledgement does not promise an application's in-memory state has been flushed.
The restart acceptance waits for SettingsProvider's asynchronous write, syncs an
owned filesystem marker, restarts the Pod, then checks a changed guest boot and
both retained values.

This slice does not implement pure-phone Sessions, physical-phone applications,
camera tools, APK installation, automatic device pools, migration of Android
userdata between nodes, or interactive simultaneous human/Agent screen control.

## Matched acceptance

Run resource-intensive checks serially and provision adequate host memory:

```sh
PI_CLOUD_LIVE_ANDROID_CHECK=1 PI_CLOUD_LIVE_ANDROID_RECOVERY=1 node --import tsx scripts/run-live-android-check.mjs TARGET_UUID PRIVATE_REPORT
PI_CLOUD_LIVE_ANDROID_CHECK=1 node --import tsx scripts/run-live-android-restart-check.mjs TARGET_UUID OWNED_TARGET_DIRECTORY PRIVATE_RESTART_REPORT
```

The second command requires an unbound, settled target. It verifies a changed
Guest boot, retained owned settings/files and the same userdata file, then removes
its markers. Restore the target's original stopped/running state after acceptance.
