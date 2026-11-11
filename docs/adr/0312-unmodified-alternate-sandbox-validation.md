# ADR-0312: Validate alternate sandboxes at the owned execution boundary

Date: 2026-11-11. Status: accepted for isolated operator validation.
Tracking: [#27](https://github.com/cookerpapa/pi-managed-agents/issues/27).

The owner requests actual BoxLite and Android trials after stock Cube cleanup.
Cube remains the default supported production runtime. An operator-selected,
owned test target is permitted; it is never an automatic fallback. Promotion to
general use requires the relevant provider and recovery acceptance, not just a
successful shell command. The withdrawn phone picker stays withdrawn.

## Adopted upstream surfaces

Pin BoxLite 0.12.0 (`f5593da68c23cb0c0a0d230eb9cb01e04cccd610`) and its
unmodified official SDK. Use native create/get/start/stop/remove, host-directory
mounts and ordinary process execution. `detach=True` and retained disks are
explicit: the default tied-to-caller lifetime is unsuitable for a cloud Tool.
Install/run the same owned Guest admission, cancellation and completion code in
the VM. No BoxLite Rust, libkrun, native Guest or dependency patch is permitted.
Guest-root control and untrusted UID-1000 Tool execution retain their boundary;
do not expose host-home, Docker socket or long-lived infrastructure credentials.
BoxLite's ordinary Guest-container privileged option may expose that VM's own
cgroup filesystem to the fixed supervisor; it does not elevate the host shim.
Untrusted Tool children must still run without guest-root authority.
The comparative local probe may explicitly run the trusted SDK as host root
with `SecurityOptions(jailer_enabled=False, seccomp_enabled=True)`. The default
rootless jailer's UID mapping did not support the managed Workspace's UID-1000
ownership, and detached cleanup left shim processes in this environment. This
alternative retains the KVM boundary, seccomp and isolated mounts, but disables
the optional host shim jailer; record that tradeoff rather than claiming equal
defense in depth. It is an opt-in research configuration, not a production switch.

The local SDK does not implement native idle AutoStop. Standalone `boxlite serve`
does not provide the cloud managed-Volume API either. Do not substitute the full
BoxLite cloud application/scheduler merely to hide these gaps, or add another
expiry authority in PiCloud. Validate dedicated caller-independent execution
first and record any limitation of elastic-resource parity explicitly.

Android retains the existing owned receiver and Appium adapter, pinned unmodified
Cuttlefish artifacts, Appium 3.8.0 and UiAutomator2 8.7.3. The receiver is application
code outside the Android engine, not an Android source patch. Preserve userdata,
test only unbound owned targets and restore the prior stopped state afterward.
Device actions are not Linux processes: cancelling a wait cannot undo a tap.

## Execution and evidence

Reuse current operation identity, ordered position/boot fencing, source output
bounds and original Kafka reply recovery. The fixed Linux Guest uses scoped HTTPS
completion. Android retains its existing trusted external receiver's Kafka/image
adapter; Android and its official automation APK have no Kafka/PG/S3 credentials.
This is validation of zero engine patches, not a forced transport rewrite. A provider
adapter must not invent shell replay, a raw-result database, a new scheduler, or
native Pi modifications. Create reply loss remains unresolved unless the native
identity can be recovered; missing management replies do not prove destruction.

Test the provider/Guest boundary on real KVM before changing production selection:
Tool/image output, duplicate and stale delivery, exact cancellation, caller death,
Guest restart, original-result delivery and Workspace persistence. Then verify
the applicable deployed end-to-end path serially. A provider failing a required
capability remains an explicit prototype with an exact blocker, not an apparently
working fallback. Preserve original assets and keep compute observations unpriced.

Sources: upstream [lifecycle example](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/examples/python/03_lifecycle/detach_and_reattach.py),
[local runtime options](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/src/boxlite/src/runtime/options.rs),
[Volume handler limitations](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/src/cli/src/commands/serve/handlers/volumes.rs),
and the existing [Android operator contract](../ANDROID_EXECUTION.md).
