# ADR-0305: Execution-owned tools, bindings and catalog publication

Date: 2026-11-08.
Status: accepted for implementation; source and deployment acceptance are pending.
Issues: [#12](https://github.com/cookerpapa/pi-cloud/issues/12),
[#13](https://github.com/cookerpapa/pi-cloud/issues/13),
[#14](https://github.com/cookerpapa/pi-cloud/issues/14),
[research #15](https://github.com/cookerpapa/pi-cloud/issues/15), and
[#16](https://github.com/cookerpapa/pi-cloud/issues/16).

## Behavior

Publish ordinary tool implementations without replacing the Session API or
Projector. Workers learn a code-owned catalog through Kafka and register trusted
proxies with Pi's public SDK. Workers submit logical Workspace work; execution
prepares physical bindings. Management remains the VM/Volume lifecycle owner.
Whole file/shell tools stay in the sandbox; Pi owns canonical settlement.

The owner requested completing source work before combined verification. Tests,
live probes and releases run serially. BoxLite remains an isolated evaluation,
not an enabled alternate production runtime. PG maintenance/HA Issue #11 is not
part of this batch.

## Native Tool boundary

Compare ordinary public Tool execution with the current atomic intent adapter.
The pinned ToolTask commits validated intent before invoking execute. Publishing
from execute adds a commit and a crash window; it neither requires a Pi patch
nor runs before native intent is durable. The selected implementation retains same-commit dispatch and centralizes native
checkpoint reading in one private adapter. The contract comparison uses public Pi
registration and Storage only. The decision accounts for argument
duplication, cancellation ordering and safe Subagent recovery, rather than count
wrapper lines. Keep native batch atomicity, one Session writer and unsafe
no-replay behavior. Do not add a second producer, sequence allocator or operation
ledger. Retained native-format knowledge belongs to one tested adapter, never
ordinary tool implementations.

## Bindings and lifecycle

The Session partition owner coordinates logical environment preparation and
binding admission. PG persists frozen targets and immutable physical bindings;
memory is a recoverable read view. First preparation reuses management's existing
allocation/closure contract. Concurrent requests share preparation without
merging unrelated child compute scopes.

Preparation must not block the Kafka consumer waiting for a later binding change.
The existing dispatch watermark remains the external-effect admission boundary.
Partition replacement invalidates old local preparation/dispatch, never replaying
uncertain shell work. Every admitted physical target remains immutable.

Cube keeps a bounded VM/partition position, not a separate lifetime ledger per
binding. Pending submissions and cancellations therefore preserve order across
bindings sharing a Workspace/compute scope in that partition. Other resources
can prepare independently. An immutable cleanup target whose binding has already
been deleted uses a conservative partition barrier. These are disposable handoff
queues, not process-duration waits or a second durable scheduler. The Kafka
consumer remains free to apply binding changes. Cancellation remains best effort;
closure acknowledgement proves stopped routing, never completed interruption.

Closing first records resource intent and closes new allocation admission. The
execution owner applies ordered binding closure and confirms stopped admission
before physical retirement. PG and the existing Outbox recover completion after
reply loss or owner replacement. Kafka publication alone is not a closure ACK.
The matched cutover removes the old pre-publication memory mutation. A terminal
writer gate (`session_leases.tool_bindings_closed_at`) and the existing Outbox
application timestamp prevent late registration and premature physical retirement.
Neither is a per-operation result/process-stop ledger. This amends ADR-0212's barrier
placement, not its requirement to revoke admission before physical effects.

Actual pause/delete/recovery remain direct provider API calls. Missing health
observations never prove physical absence. Chat Stop is native abort; resource
pause waits for affected users. Dedicated intent and Cubelet elastic expiry are
unchanged. Input images, Skill resources, workflow attachment, probes, continuity
and binding retirement must use the same logical-resource boundary.

## Independent tools and catalog

A separately deployed ordinary-tool host runs trusted platform handlers. It does
not consume Session logs, allocate Session leases or run Pi. The sole Projector
admits effects and forwards bounded requests. Accepted calls retain implementation
identity and drain before that version retires. The durable dispatch freezes the
release/generation and replay policy seen at admission. A later catalog cannot
turn an old unsafe invocation into a replayable operation. A removed version
refuses an unstarted call explicitly; uncertain effects are not retried.

Publish complete snapshots to a dedicated compacted Kafka configuration topic,
outside native history. The active deployment selection authorizes publication;
old executables cannot overwrite a selected directory. Definitions are code-owned,
not an executable plugin download, execution grant or health heartbeat.

Each Worker reconstructs the complete directory before claiming work and observes
later changes. Delivery broadcasts to every Worker, not a group that distributes
definitions between Workers. Track the bootstrap boundary and reject stale
generations/digest conflicts. Remove WebSocket catalog delivery after cutover;
registration and ordinary management stay on that connection. A new definition
affects subsequent model requests, never a provider request already in flight.

## Provider API

Generic dispatch uses a PiCloud whole-tool submit/cancel port. Cube SDK, endpoint,
node/boot identities and errors remain adapter details. Preserve source truncation,
image references and original-Worker replies. A public API alone supplies neither
exactly-once side effects nor durable results. Move completion away from Cube
only after verifying its receiver/execution lifetime across Projector replacement;
do not quietly depend on a disposable caller or add a result ledger.

## Adoption evidence

OpenMA at a4a5ab7075c636529533f9cf14b602dc18dad6ff demonstrates ordinary Pi tool
registration and separate provider operation/lifecycle interfaces. Its inspected
E2B/Daytona tool path truncates after provider output retrieval. Its local execution
guard does not turn remote effects into transactions. Adopt the interface pattern,
not another Session runtime or unbounded file-return policy.

BoxLite v0.12.0, f5593da68c23cb0c0a0d230eb9cb01e04cccd610, offers OCI microVMs,
execution handles and reconnectable bounded output. Core is Apache-2.0; several
cloud applications are AGPL-3.0. Evaluate the selected deployment/ports separately.

Reuse Kafka compaction/fencing, PG transactions/Outbox, Pi's public SDK and the
existing Kubernetes release machinery. Add no broker, workflow scheduler, plugin
loader or general-purpose RPC framework.

## Acceptance and release

Verify native execution/Stop/recovery, lost request/reply ACKs, shared Workspace
and child scopes, binding closure/rebalance, catalog bootstrap/stale publishers,
and tool-host replacement with Session API/Projector/Worker/VM identities intact.
Measure cold/warm preparation and publication counts. Independent tool releases
follow an initial matched protocol/schema cutover. Preserve accounts, model and
provider configuration and credentials; drain writers and confirm physical cleanup
before removing resource ownership. Source, verification and deployment are
reported separately; no acceptance is claimed by this decision document.

Source comparison and isolated BoxLite probe: [research evidence](../research/execution-boundaries-20261108.md).
