# ADR-0219: ordered Cube admission and binding closure

Status: accepted for implementation, 2026-10-04, following the owner's discussion
of Kafka-ordered stopping and approval to implement the follow-up review.

## Problem and reuse

ADR-0210's Cube manager retains closed Run/writer/operation IDs. Its exhaustion
path permanently closes the entire manager, even after the offending VM and its
fences disappear. Raising the threshold or forgetting an unrepresented closure
does not repair that contract. Kafka publication fencing alone cannot retract an
RPC already sent by an old Projector.

Reuse Kafka 4.0's ordered partition offsets, the current consumer group,
commit-before-Tool dispatch, PG binding control references and Cube's native
process/cgroup driver. The existing binding-change schema already carries an
immutable `closed` bit. No new event broker, Tool consumer group, task scheduler,
RunAttempt, signing key or per-Tool PG ledger is introduced.

The [Kafka design contract](https://kafka.apache.org/40/design/design/) distinguishes
Kafka transactions from effects in an external destination, which needs its own
cooperation. The [consumer contract](https://kafka.apache.org/40/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html)
provides stable partition positions and recovery from committed offsets.
[gRPC ordering](https://grpc.io/docs/what-is-grpc/core-concepts/) is within a call;
it does not order unary requests sent by different owners. These Apache-2.0
infrastructure projects are already adopted/pinned. The prior
[Cube/E2B/OpenSandbox source survey](../reports/cube-result-delivery-study-20261001.md)
establishes why a bounded destination adapter remains necessary. A second Cube
Kafka consumer would split projection and execution authority. A new streaming
RPC dispatcher would require additional connection ownership/recovery state.
Neither removes the destination's responsibility for stale admission.

## Ordered closure

1. PG closes the existing binding. Publication admission still installs current
   PG revocation synchronously; backlog must not authorize new effects.
2. The existing Outbox carries that binding's closed control reference through
   the same physical-Session Kafka queue as its Tools.
3. The partition owner consumes that **closed fact**, then issues Cube Stop with
   its Kafka topic/partition/offset. An earlier open fact which reads a newer
   closed PG snapshot must not substitute its earlier offset for the close.
4. After native stopping, or the existing durable physical-target quarantine on
   uncertain stopping, record bounded closure outcome metadata on that binding.
   This is a lifecycle receipt, not a per-Step projection receipt. It distinguishes
   stopped from quarantined; quarantine never proves process/VM absence.
5. Resource release waits for that outcome. Normal binding removal requires
   confirmed stopping; physical cleanup may remove bindings only with its existing
   positive-absence proof. Quarantined recovery can request a new ordered close;
   old completion must not satisfy a newer closure revision.
6. Final Run/writer seals retain their current meaning and follow execution-scope
   closure. No new Run becomes eligible merely because a stop request was logged.

The old pre-seal hook requests/waits for PG binding closure, rather than directly
stopping Cube. Controller release/adoption uses the same closure port. The
Projector's closed-control handler must not recursively wait for another control
fact on its own partition. Pending closure reads are bounded lifecycle work;
their cancellation/timeouts do not manufacture success or bypass PG authority.

## Destination admission

Fixed Tool submits carry their consumed log position. For each physical VM,
Cube remembers one log identity and the highest admitted position of each used
partition. Under the manager mutex, it checks the position and reserves admission
before starting native work. Each partition already waits for bounded handoff
before dispatching its next record; unrelated partitions remain concurrent.

A delayed old Tool whose position precedes a later close/handoff is rejected.
An active identical submission may acknowledge its existing operation, but never
starts a second process. Once bounded result delivery finishes, remove the
operation body/identity; positions prevent historical replay without a lifetime
list of closed Runs. Stale submissions have UNKNOWN semantics when prior execution
cannot be established, never automatic shell retry.

This relies on the existing publication contract: native Tool invocations never
retry an ambiguous append/commit. Kafka's producer is idempotent; only a proven
pre-enqueue refusal permits another application send. A later arbitrary copy of
an old Tool at a new log position is not a supported retry protocol. Native writer
and HTTP/Kafka ambiguity tests must retain this rule; offsets alone do not
deduplicate arbitrary newly published commands. Control references may retry
because their closure effects are idempotent.

Stop retries are idempotent for their exact scope and do not regress progress.
Cleanup after an ambiguous handoff uses that already-logged command's position,
so a Stop which overtakes the original RPC also rejects its later admission.
Completed background services keep their existing lifetime.

Progress state scales with live VM/partition pairs, not historical Run count.
Confirmed physical removal retires the VM's position state. VM IDs are not reused;
executor boot replacement rejects old descriptors rather than continuing unknown
processes. Shutdown and temporary capacity exhaustion are distinct states.
Read-only probes must never advance the Tool admission position or become effect
authority; obsolete asynchronous observations remain disposable.

Managed Cube transport advances to version 3 without an old-wire fallback.
Native guest Tool wire and Session log remain unchanged. Use the matched pinned
Cube/app build and a drained cutover; no recreation of user files or automatic
replay of uncertain operations. Rollback requires the previous matched binaries
and a drained control state, not mixing protocol versions.

## Acceptance

Prove delayed old-owner submit after close, duplicate/ambiguous submission,
same-position stop, closure ACK loss and revision races, closed PG state observed
through an older open fact, replay/handoff, shared-VM sibling survival, probes
without position advancement, more than the old 65,536 closures, bounded retained
state, shutdown and confirmed VM removal. Test controller release and final seal
through real PG/Kafka before matched Cube deployment. Missing probes or metadata
still cannot authorize VM destruction or quota release.

## Controller replacement discovered during live acceptance

The first live Control Plane crash check exposed an existing state conflation:
controller lease loss marked capsule-backed VMs `unknown`; migration 163's quarantine
trigger closed their bindings. With ordered closure those references correctly
stop Cube, which also exposed that controller loss had incorrectly become a VM
failure signal. Controller shutdown/expiry must preserve the last observed state
of a VM with a durable recovery capsule and retire only its controller ownership.
The existing adoption path claims lost owners and checks the recorded VM/boot.
A capsule does not prove liveness. Failed adoption, explicit quarantine, real
physical evidence and incomplete provisioning retain their existing unknown/
closure rules. No binding reopens and no unconfirmed effects are replayed.

The instrumented retry also found adoption's synchronous notification attempting
HTTP publication before startup/partition routing had settled. Its 15-second
transport failure was then misclassified as physical recovery failure. Binding
adoption now commits ownership and its existing Outbox reference without waiting
for delivery. Outbox replay/owner bootstrap propagates this metadata; it does not
change the immutable Cube target or reopen a binding. Registration and closure
retain their required publication barriers. A notification outage cannot cancel
already accepted native work or quarantine a verified VM.

Retiring a binding after confirmed stopping/physical absence likewise needs only
its PG deletion plus durable Outbox reference; its already-closed target cannot
admit new effects while the memory view catches up. Registration and closing
remain synchronous barriers. Recovery stages local bindings as one set. A pending
ordered-closure delivery is retried by existing recovery, rather than quarantining
a shared VM or exposing a partially restored local set.
