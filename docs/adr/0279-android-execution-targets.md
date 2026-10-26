# ADR-0279: Android execution targets and internal Kafka replies

Status: approved for implementation, 2026-10-26; not deployed.

The owner chose a cloud Android virtual device as the first additional execution
target, then approved a trusted cloud executor publishing directly to the existing
Worker Kafka reply transport. The Android guest/application does not receive
Kafka or provider credentials. This ADR explicitly extends the Cube-only runtime
boundary for this one verified backend; there is no silent alternative runtime.

## First vertical slice

An existing coding Session can bind an operator-provisioned Android target while
idle. Root Conversations receive the target's supported, enabled Android tools;
children do not automatically inherit control of its screen. One target has one
Session controller at a time. Workspace/Cube behavior remains available in that
Session. Pure-phone Sessions, self-service Android provisioning, physical phones,
camera inputs and simultaneous human/Agent screen control are later slices.

Adopt Cuttlefish/AOSP for the virtual device and Appium UiAutomator2/ADB for UI
automation. First prove boot, observation, Chinese input and retained application
data on the actual host. Pin the tested image/host build and automation versions.
Use an isolated runtime beside Cube; do not nest Android inside its guest, mount
Docker sockets/home directories or install an independent cloud scheduler.

## Adopt-before-build evidence

- [Cuttlefish](https://source.android.com/docs/devices/cuttlefish/get-started)
  supplies KVM Android devices, matching host/image artifacts, ADB and WebRTC.
  Its [host container](https://github.com/google/android-cuttlefish/blob/main/container/README.md)
  is a candidate runtime, not a replacement for PiCloud scheduling. The companion
  Cloud Orchestrator's Docker-socket management and separate scheduling layer are
  not required by this slice. Cuttlefish's main license is Apache-2.0 with
  component notices; retain the pinned artifacts' licenses/SBOM.
- [Appium UiAutomator2](https://appium.github.io/appium-uiautomator2-driver/latest/overview/)
  provides WebDriver operations using Android's UI Automator and ADB, including
  emulator/physical-device support. Keep its SDK/session details behind the
  Android executor. It is an automation driver, not a cloud work authority.
- [redroid](https://github.com/remote-android/redroid-doc) is a maintained-looking
  alternative with container/kernel requirements and a different isolation
  boundary; it is not an automatic fallback if Cuttlefish fails acceptance.
- Reuse Pi's public tool/Registry APIs, the Session log, ordered Projector
  dispatch and boot-scoped reply publisher. Neither MCP nor another broker/task
  database removes the required destination admission and uncertain-effect rules.

## Authority, routing and state

PG owns target registration, permitted Session binding and binding revision.
Native Pi owns execution progress and final Tool Results. Binding snapshots flow
through the existing authorized Session-control path; hot dispatch uses the
partition owner's memory. No per-Tool PG lease query, command queue or result
ledger is introduced. Android userdata has one operator-owned persistent volume;
it is not a second Workspace archive and is not stored in PG/Kafka.

Separate execution transport from managed VM lifecycle. One Projector dispatch
boundary selects the existing Cube adapter or the external executor port. The
Cube adapter preserves current fixed guest contracts. Android uses code-owned
named tools and its own driver. Do not force
an external target to implement fake VM creation/destruction or Pi file tools.
Tool requirements become explicit capabilities, replacing the ordinary catalog's
coarse environment boolean. Resolution remains per Conversation, even though
one Harness/lease owns the physical Session. Existing requests capture their
definition and target identity; a changed binding cannot retarget an old call.
Use explicit per-Conversation native tool selections. Registry changes reconcile
membership through public `configure`/Conversation commits on the same writer,
only when names change. A global subtractive list cannot safely hide newly added
device tools from a child with no device grant. Definition-only changes keep the
existing positional `pi.system` behavior; no per-request PG check or second
configuration authority is introduced.

Worker persists validated native intent and a bounded execution reference in
one existing Kafka commit. Projector confirms its dispatch position before
handoff. The Android executor acknowledges only bounded admission, executes
outside Worker/Control Plane, uploads images through the existing attachment
boundary and publishes final references to the original Worker reply channel.
It has no Kafka consumer or Session writer. Pi processes the reply before the
result becomes canonical. Preview/progress remains observation-only.

The destination binds commands to target, executor boot, Session writer and
ordered source position. Duplicate transport receipt cannot repeat a tap.
Connection loss after admission is UNKNOWN; a safe screenshot may be requested
explicitly to inspect current state, but unsafe actions are never automatically
replayed. Result retransmission keeps its operation identity and is distinct from
execution. Executor restart invalidates old admission descriptors. Preserve the
current Worker-replacement policy rather than replaying old boot replies.

Stop settles through Pi Durable and ordered operation cancellation. It may stop
an operation which has not run or abort cancellable I/O; it cannot undo a tap,
kill the user's application or destroy the virtual device. A missing heartbeat
never authorizes resource deletion, userdata reset or effect replay. Old resource
admission must close before any replacement/disposal is considered confirmed.

## Acceptance and rollout

Prove an actual Cuttlefish/UIAutomator device first, then native intent → unified
Projector → Android action → direct Kafka reply → Pi result, including screenshots
and Chinese input. Verify unavailable capabilities, idle-only binding changes,
root/child isolation, duplicate and delayed commands, cancellation, dropped replies,
executor/Worker/Control Plane replacement and image retention/cleanup. Re-run Cube
contracts and owned real Luna/Cube acceptance. Deployment is a drained matched
upgrade because protocol/schema and Worker contracts change. Preserve existing
accounts/configuration, Workspace bytes and Sessions; remove obsolete code instead
of maintaining two protocol versions. This decision is not a claim that these
checks have already passed.

The first deployment uses an operator-owned node-affine Cuttlefish state directory
and an OnDelete StatefulSet. Replacement requires idle admission; Pod restart
retains userdata. This is an explicit single-node provisioning boundary, not an
automatic Android scheduling or elastic recovery system. See
[the operator guide](../ANDROID_EXECUTION.md) for the maintained commands.
