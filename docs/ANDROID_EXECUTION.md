# Android execution targets

Status: deployed under ADR-0279 on 2026-10-26. Current core `schedules-08063299`
(schema 202/catalog v3), device `android-7aa30c34`.
[Delivery evidence](reports/android-execution-delivery-20261026.md) covers real
model calls, Web binding/images, device restart and original-asset preservation.

The October 27 owner decision withdraws the cloud-phone picker/screen controls
from the product page. The execution-target abstraction and operator API remain
as a verified alternate-sandbox prototype; no backend/device data is deleted.
An operator can bind an existing idle coding conversation to a provisioned
Android virtual device through the API. The next Run receives the device capabilities. Its root Agent can observe
the screen, tap, swipe, enter text, press a navigation key and open an installed
application. Child Agents do not inherit control of that screen. The existing
Cube Workspace and coding tools remain available.

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
publishes to the original Worker's boot-scoped Kafka reply topic. The Worker
passes the reply to Pi before a canonical Tool Result enters native history.
No independent broker, executor command queue or Tool-result database is added.

Android itself has no Kafka, database or model credential. The external executor
is trusted private infrastructure. Screenshots use the existing attachment
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

Chat Stop retains Pi Durable settlement and ordered operation cancellation. It
can prevent a pending action or abort cancellable I/O, but does not undo a tap,
kill an application or destroy the device. Closing admission retains its cleanup
address in PG until the executor confirms closure. Rebinding/deleting a Session
cannot discard an unresolved descriptor. Missing heartbeats never authorize
userdata deletion or action replay.

## Operator installation

Use the maintained K3s installation with schema 202, tool catalog version 3 and
matching Worker/Control Plane code. A matched upgrade must drain writers first.
Do not expose Appium, ADB, device management credentials or Kafka to public clients.

The first installer provisions one node-affine device. It uses the pinned
Cuttlefish host/system build from `deploy/android/artifacts.json`, a persistent
owned host directory, Appium 3.8.0 and UiAutomator2 8.7.0. It has no independent
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
The UiAutomator2 npm archive is hash-verified; preparation retains its code/APKs
and resolves bundled JavaScript dependencies through one pinned lockfile. Its
optional Sharp dependency is updated from 0.35.4 to 0.35.5 in package metadata.
No Appium/UIAutomator runtime code is patched.
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
