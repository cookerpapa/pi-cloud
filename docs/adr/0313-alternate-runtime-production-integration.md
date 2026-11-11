# ADR-0313: Alternate runtime integration and original-operation recovery

Date: 2026-11-11. Status: accepted for implementation.
Tracking: [#27](https://github.com/cookerpapa/pi-managed-agents/issues/27).

The owner now requests complete BoxLite and Android integration into the real
Session path, followed by the same applicable failure/recovery acceptance as the
Linux Guest. This supersedes ADR-0312's operator-experiment-only scope. Keep
upstream engines unmodified and run resource-intensive checks serially on WSL.
Cube remains the default; another provider is selected explicitly, never as a
fallback. Original accounts/configuration/credentials and Workspace/device data
remain protected through matched draining and physical cleanup.

## One remote-operation recovery contract

Extend the existing native Tool reply reference to device operations. Record the
original operation ID, reply topic/offset, absolute deadline, binding and writer
in the existing commit metadata/current native task fields. Kafka remains the
reply log, Pi remains the task authority, and PG materializes bounded recovery
references. Do not add a Tool-result table, replay queue or second task system.
Images/reply topics remain protected until canonical native settlement.

On replacement, the Worker restores those original subscriptions before native
execution resumes. The tool proxy's replay-safe function reattaches to the wait;
it never sends the UI action again. Original deadlines do not restart. A missing
or expired result is UNKNOWN, and observing current effects is separate work.
Pi public Storage/Tool APIs remain the boundary; no agent-loop modification.

Device admission revocation prevents new effects but does not cancel an already
accepted operation. Preserve the old binding's immutable cancellation address in
the existing binding row/view while a pending native task references it. Remove
it after settlement and confirmed admission closure. Explicit user Stop carries
operation cancellation through the Session log, including the original writer;
recovery closure does not imply Stop. Old cancellation cannot abort a new action.
Normal Tool routing/cancellation reads the ordered in-memory view; no per-Tool
PG lease check is added. Resource/deletion admission retains its PG authority.

## Completion and failure boundaries

Move the Android receiver to the same scoped HTTPS completion endpoint as the
fixed Linux Guest. Remove its Kafka/PG/S3 clients and credentials. The completion
role validates identity, retains images and publishes the original reply. The
Worker Harness still makes the canonical result. Preserve native protocol
boundaries and limit image replies to the declared observation tool.

Android uses executor protocol 2 with an absolute execution deadline and the
opaque completion destination. Session v21 carries the original reply reference;
schema 219 guards drained writers, native replay checkpoints and device bindings
before the matched cutover. The shared HTTPS client lives in `workspace-runtime`
and is reused by the fixed Linux Guest and the external Android receiver.

The Android receiver and official Appium/UiAutomator APK remain outside Pi core.
Accepted UI calls can finish after Worker/Projector replacement. Receiver/device
loss may leave an effect uncertain; neither absence of a response nor a changed
boot authorizes repeating a tap. Restart safety means explicit UNKNOWN and
bounded recovery when the provider cannot recover an execution, not invented
exactly-once effects. A new executor boot refuses stale admissions.

## Provider and storage integration

Use PiCloud-owned provider ports for BoxLite's ordinary lifecycle/process APIs;
keep SDK objects and credentials outside the Worker and public schemas. Reuse
the current resource controller, PG send permit, encrypted early receipt,
Workspace byte authority, attachment admission and quota policy. A provider
cannot infer deletion from inventory absence or an expired heartbeat. An
uncertain create is reconciled by its original identity, never repeated.

The owner selected platform-owned expiry as a prerequisite. Delivered
[ADR-0314](0314-platform-owned-elastic-expiry.md) now supplies the same PG-backed
deadline and cleanup authority for elastic providers. BoxLite therefore supports
both explicit dedicated and elastic allocations without a native AutoStop API
or another timer. Android remains an explicitly provisioned device, not a
self-service phone pool or physical-phone integration.

The prior rootful/no-jailer experiment is not proof of a production isolation
policy. Establish and document the actual host/Guest boundary and run the
relevant isolation checks before enabling it. Do not claim a requested seccomp
flag is effective when upstream gates it off. Native API limitations remain
visible; no vendor patch is an acceptable hidden workaround.

## Acceptance and deployment

First complete the Android recovery/completion slice, then BoxLite provider
integration. Source checks may be grouped, but builds and live KVM/device tests
are serial. Require real Luna conversations, bounded output/images, duplicate
and late delivery, explicit Stop, Worker replacement while awaiting an original
reply, original deadline preservation, executor/Guest/device/VM loss, resource
retirement and retained Workspace/userdata. Verify applicable terminal/preview
surfaces for a coding-machine provider. Keep billing unchanged/unpriced where
physical coverage cannot be established. Publish matched protocol/schema/image
changes after draining; leave no compatibility reader solely for old dev versions.

Adoption evidence: [ADR-0312](0312-unmodified-alternate-sandbox-validation.md),
the [real stock-provider experiments](../reports/sandbox-portability-20261111.md),
and ADR-0306/0307/0309's existing reply, Guest and ownership mechanisms. This
extends existing authorities instead of introducing another infrastructure stack.
