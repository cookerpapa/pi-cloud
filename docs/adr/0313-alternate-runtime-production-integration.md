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

## BoxLite adapter choice

Use the pinned Apache-2.0 `@boxlite-ai/boxlite` 0.12.0 SDK inside an independently
deployed, trusted node adapter. The SDK's host mounts, process handles, PTYs and
TCP tunnels cover the mechanical operations required by the existing provider
ports. The official standalone REST server explicitly rejects managed volumes
and does not expose host-path mounts; adopting the separate cloud application
stack would introduce another scheduler and ownership store. A bounded SDK
adapter is therefore justified, without changing the engine or implementing
another resource scheduler. See the pinned
[Node contracts](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/sdks/node/lib/native-contracts.ts)
and [standalone REST schema](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/src/cli/src/commands/serve/types.rs).

Extract shared fixed-Guest preparation, data access and execution transport from
the Cube provider. Native creation/connection representations stay with their
drivers; BoxLite must not impersonate Cube's API or invent Cube credentials.
Select the backend explicitly in the resource domain's deployment configuration,
with Cube the default and no fallback. Existing resources must be retired through
the matched operator before changing that domain's provider. A product phone
picker, mixed-provider placement scheduler and self-service device pool remain
outside this integration.

The BoxLite adapter receives only its owned SDK state, the managed Workspace
pool and KVM access. It must not mount a host home or Docker socket. Untrusted
Tools still execute inside the VM as UID 1000 with no-new-privileges. The prior
no-jailer experiment does not establish an active VMM seccomp filter; verify
and document the actual provider-Pod/VM boundary before publication. Do not
silently relax an existing acceptance check or claim the optional filter works.
The trusted node Pod uses the host PID namespace: native SDK process identities
and recorded start times must remain meaningful across container replacement.
The Guest is a separate VM and receives neither host `/proc` nor node mounts.
This is an explicit compute-node privilege, not a privilege of Agent Tools.

Run the API as a supervised child inside the node container, so an API-process
restart does not terminate the container and its detached VMM children. Adopt
Debian's pinned [Supervisor 4.2.5-1](https://packages.debian.org/bookworm/supervisor)
with [per-process restart](https://supervisord.org/configuration.html) and group
termination disabled; do not build another process supervisor. Kubernetes still
owns the Pod. Full Pod/node loss remains a VM-failure boundary, whereas replacing
only the API child must preserve a healthy VM and its original Guest reply.
This process supervision owns no Session, deadline, quota or Tool task state.

Reuse the existing POSIX attachment/deletion guard for BoxLite host mounts:
acquire an immutable attachment before VM start and release it only after
positive physical closure. Mount only Workspace bytes, never the private receipt
directory. PG retains creation admission and early receipts; a lost create reply
is reconciled by its original native identity/name, never `getOrCreate` or a new
create. SDK inventory alone does not authorize deletion or quota release.
The adapter's connection/stream handles are disposable; native SDK state and
existing PG/Volume records retain their respective authorities.

The embedded SDK's public info response lacks arbitrary creation metadata.
The node adapter may retain one bounded immutable connection/attachment receipt
alongside native SDK state so cold reads can reconstruct the original handle.
This is a copy of the PG-issued creation specification and exact Volume receipt,
not another lifecycle state machine, queue or expiry clock. Use the repository's
existing fsync-and-no-replace receipt pattern. Missing or incomplete metadata
is unresolved, never permission to recreate a Box or detach an unknown hold.

Workspace byte authority remains the existing Cube persistent-Volume subsystem
and POSIX pool. The BoxLite compute driver uses that storage port for volume
creation/deletion, while its node adapter only acquires/releases the existing
opaque attachment holds and supplies host mounts to the SDK. This integration
replaces compute, not the storage service; it does not claim a deployment with
every Cube component removed. No second Workspace copy or storage catalog is added.

Public terminal protocol 2 removes the unused native `pid` field from ready
messages. Human terminal control already uses the platform terminal ID; native
Cube PIDs and BoxLite execution IDs remain inside their respective transports.
Do not manufacture a Linux PID for an SDK execution UUID. Publish the matching
Web/API/runtime versions together, with no old terminal-protocol reader.

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
## Workspace UID mapping discovered during live acceptance

BoxLite 0.12.0's [container lifecycle](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/src/guest/src/container/lifecycle.rs) automatically maps a
read/write host Volume's owner to the configured container user. Its
[mount ID mapping](https://github.com/boxlite-ai/boxlite/blob/v0.12.0/src/guest/src/storage/idmap.rs) swaps the two IDs rather than translating only
one direction. Configuring the container's default user as root therefore made
the platform's UID-1000 Workspace appear root-owned inside the Guest; a Guest
`chown(1000)` then changed its host owner to root. Elastic initialization failed,
and dedicated Workspace access through the Volume Gateway lost permission.

The adapter configures the container default user as `1000:1000`, matching the
managed Workspace owner and avoiding that remapping. Infrastructure execution
still explicitly requests root; fixed Tools remain UID 1000. This is a native
SDK option, not a vendor patch. Live acceptance must verify both host and Guest
ownership across creation, API replacement and VM resume, in addition to content
preservation. The affected development allocation is retired before restoring
the managed directory's original owner; no recursive file ownership rewrite is
authorized by this repair.
