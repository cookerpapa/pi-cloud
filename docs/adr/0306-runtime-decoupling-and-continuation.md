# ADR-0306: Runtime decoupling, recoverable Tool delivery and external accounting

Status: accepted for implementation; verification and deployment pending.
Date: 2026-11-09. Tracking: Issues #17–#24.

## Authorization and delivery

The owner approved the November 9 discussion as one matched development upgrade.
Implement complete vertical slices first, then run consolidated verification
serially. No slice is called delivered before its acceptance and rollout pass.
Preserve accounts, configuration, credentials and existing physical cleanup
authority. Completed commits are pushed. The deferred 131 MiB model upload and
production adoption of another sandbox are outside this batch.

## Decisions

### Public API and execution ownership (#17)

Deploy the public Session API independently of the Session execution runtime.
The API owns authentication, PG admission/read APIs and browser connections.
The execution runtime retains Worker membership/control, the sole Session
Projector group, ordered control publication and Tool dispatch. Resource
management remains in its existing separate process.

Expose a bounded authenticated live-view transport over existing HTTP streaming.
The execution owner assembles the initial PG snapshot and live tail with the
existing read-only reader and coverage/cursor rules. The API authorizes and
relays that stream; ordinary history/read requests use the API's own PG pool.
This avoids another live-view cache and a second snapshot/subscribe race. Browser
credentials do not cross the internal interface. The API does not consume
Session Kafka or acquire execution authority. Replacement closes browser
connections but does not drain healthy writers, retire Workers or change VMs.

### Continuation of accepted remote operations (#21, #22)

Keep one PG-issued physical-Session lease and one transactional Session writer.
Recoverable ownership closure revokes old admission/publication without treating
the logical work as user-cancelled. An authorized replacement restores the same
Run, native submission and pending operation identities.

Retain the original operation's reply topic and a safe replay reference in the
existing native commit's cloud metadata/current recovery projection. Restore
owned waiters before replaying the required old reply suffix and following its
live tail. A consumer read is not a canonical result commit. Pending references
protect Kafka replies and images across repeated Worker replacement; completed
native outcomes release them. Do not use a shared consumer-group offset as proof
that Pi committed a result, or create a PG raw-result ledger.

Pi's public replay-safe Tool entry point may re-enter a cloud proxy only when
that proxy reconnects to the original operation without publishing another
executable intent. This is not replay safety for arbitrary shell commands.
Keep original timeout accounting and explicit UNKNOWN outcomes. Explicit Stop
retains native abort settlement and ordered cancellation of the original target.

Actual VM loss is a different recovery state. Resource management verifies old
closure/physical absence before replacement and respects running/paused/released
intent. The same Run may wait for a required environment, settle old operations
truthfully, then continue after a persisted World State change. Files in the
persistent Volume may survive; processes, memory and system-disk changes are not
promised. No old command is automatically executed on the new VM.

Before a physical Tool result is returned to Pi, a small current-only native
conversation document retains its Run, writer and environment identity. Repeated
results from the same identity make no state change. This closes the window where
a Tool Result commits but the next model-boundary World State capture has not run.
A replacement of that writer verifies the environment and its fresh full reply
path before the next model request. A new pure-chat Run does not activate compute.
The verified World State, any reset entry, adopted observation and recovery-wait
clear commit together through the public Pi document/entry API. These documents
are initialized empty in a fork and are not model text or a second Tool ledger.

Authoritative binding withdrawal also sends a scoped `environment_changed`
notification through the existing current-Worker reply mailbox. This is a control
observation from the trusted Projector, never a Guest claim. The Worker records a
recovery gate without adding a synthetic user message or blocking unrelated Tool
callbacks. A local revision prevents an older readiness confirmation from clearing
a newer withdrawal. Model-request permits are acquired after environment waits;
context compaction does not require the sandbox to be restored.

This matched protocol cutover uses Session topic v19 and reply topic v4. Existing
protected native replay checkpoints must be materialized while draining before
the migration. Retired v18/v3 transport data can be removed only after checking
that no surviving recovery reference needs it.

### Guest completion and provider interfaces (#20, #24)

Keep fixed Tool execution and output bounds in the Guest. Introduce a narrow
Guest-initiated HTTP completion boundary; trusted PiCloud code validates scoped
delivery authority, externalizes images and publishes Kafka replies before ACK.
The Guest receives neither Kafka/PG credentials nor authority over arbitrary
topics, leases, accounting or physical cleanup. Repeated delivery cannot restart
execution or overwrite native cancellation.

The first Cube integration keeps native ordered admission/cancellation and the
fixed root Guest scope launcher. That launcher collects the bounded child result,
leaves/finishes its cgroup, performs required timeout/fault cleanup, and sends the
result over HTTPS. Cube receives a small delivery receipt. A trusted Cube HTTPS
adapter still reports launch/runtime failures; asynchronous diagnostics use the
same direct Guest callback as Tools, while synchronous physical observations
remain separate. The adapter has no
Kafka, PG or object-store client and no Node completion subprocess. The standalone
PiCloud completion role reuses existing result/image publication code.

Delivery uses the existing bounded AES-GCM capsule pattern with a separate
purpose-derived key from the internal management secret. Guest and executor
capabilities are distinct, expire at the original operation deadline, and conceal
immutable reply routing. Native operation/probe admission bounds the complete
callback metadata at 32 KiB, accommodating the CA chain and batched binding grant;
it is independent of the bounded final Tool payload. The Guest gets a public CA and resolved connection
address with TLS hostname verification, never a signing key. The installed Cube
CA issues the completion service certificate. A Guest result cannot submit
executor quarantine/physical evidence. Duplicates may exist in Kafka; native
Task settlement remains authoritative and no raw-result ledger is added.

Reuse upstream execution interfaces where their acceptance, caller-independent
lifetime and cancellation contracts match. Keep independently enforced admission
and exact-target closure until an equivalent replacement is verified. The final
patch inventory must distinguish Guest application code, platform adapters,
execution extensions, physical lifecycle/Volume protections and upstream fixes.
Zero Cube patches is an assessment outcome, not an assumption or permission to
remove an un-replaced guarantee.

### Execution-side retention and probes (#18)

Move periodic initiation from Workers to the execution owner. Eligibility uses
fresh execution-lease evidence, unfinished native family work and current resource
bindings; an absent seal alone does not establish activity. Retain existing VMs
through model/child waits without creating compute for pure chat. Coalesce shared
resources and preserve finite expiry and existing physical Tool activity.

Coordinate the proposed minute cadence/full reply-path probe with finite renewal,
but record their outcomes separately. Fresh probes target the current Worker's
actual receiver; old probe results cannot certify a replacement's path. Fault
checks do not wait for the periodic tick. Missing probes never authorize resource
destruction, quota release, command replay or lease renewal.

Refresh eligibility in five-second batches spread across twelve stable lease-ID
buckets. Each physical family is normally considered once per minute. Convert PG
remaining lease validity into a local monotonic deadline; discard delayed work
after it expires. Reads occur per batch or exceptional readiness request, never
per ordinary Tool. Read-only probe concurrency is bounded; at saturation rotate
diagnostics without withholding independent finite renewal. Root Run lifetime
covers native children, and native child resource references participate without
separate leases. Initial elastic retention becomes thirty minutes; the deployment
setting remains adjustable.

### Lifecycle evidence and external metering (#19, #23)

Expose normalized lifecycle facts with stable event/allocation identity, known
occurrence time, separate observation time and coverage. Reuse the provider's
event/history facilities or existing native journals; do not add another broker,
resource scheduler or authority. Bootstrap/live handoff and historical catch-up
must expose retention gaps rather than silently skip them.

Move computation of allocated CPU/memory time outside Cubelet into the independent
metering boundary. It processes confirmed intervals in minute-sized batches using
durable cursors and existing immutable receipts/prices. Cadence is not rounding
to whole minutes. Pause/resume/resize split intervals; sharing and Worker
replacement do not multiply charges. Persistent Workspace capacity remains its
separate source and lifetime. Unknown intervals remain unpriced.

Probes can contribute equivalent current observations but are not the billing
clock: idle retained VMs and dedicated machines can run without active Session
probes. Provider monetary billing is optional cost reconciliation, not authority
for PiCloud customer prices. Existing Cube collection is retired only after the
external source contract and a non-overlapping cutover are complete.

For pinned Cube, retain a small raw lifecycle-history adapter in its existing
synchronous metadata database. It records normalized physical observations and
state changes with a stable sequence, source epoch, allocation incarnation,
observation timestamp and optional native occurrence evidence. It exposes bounded
pages and an explicit low-water mark. It does not integrate CPU/memory time,
apply prices, publish to accounting, or hold metering credentials. Existing
physical observation and native lifecycle callbacks are reused; restart, capture
failure, clock discontinuity and expired history expose coverage gaps.

The external collector processes these pages through a provider-owned port and
commits its cursor with derived intervals in the existing accounting database.
Consecutive compatible observations with continuous source coverage may establish
a bounded running interval. A lifecycle hint or isolated alive sample alone never
backfills arbitrary downtime. Unproven start/stop tails remain unconfirmed. The
minute settlement loop is independent of Run activity, diagnostic probes and
the public API. Workspace quota-storage receipts retain their current collector;
the old Cube compute receipt producer is removed in the matched cutover.

## Adopt-before-build evidence

- Reuse pinned Pi Durable 1.0 public Tool, Storage and task continuation APIs;
  `dist/harness/tool.js` requires stored and current safe replay declarations.
- OpenMA uses provider-owned process/filesystem ports, but ordinary SDK response
  collection alone does not provide PiCloud's cross-Worker result guarantee.
- BoxLite's Guest output ring bounds retained bytes, not total delivered output;
  fixed Guest source truncation remains necessary. Its lifecycle-based Cloud
  accounting is evidence for external interval construction, not a replacement
  for missing historical facts.
- E2B lifecycle Webhooks and finite historical queries demonstrate notification
  plus catch-up. Daytona's WebSocket state stream retains polling fallback.
- Pinned Cube v0.7.3 has internal Redis lifecycle events with warning-only
  publication failures and publication timestamps. Reuse requires explicit
  improvements to capture/coverage rather than merely wrapping a WebSocket.

Source links and failure details are preserved in Issues #19, #20, #23 and the
[execution boundary study](../research/execution-boundaries-20261108.md).

## Acceptance

The consolidated phase covers API replacement during active work; fresh and
repeated Worker handoff before/after reply and native commit; explicit Stop;
physical VM loss/recovery; shared/native child operations; Guest callback retry,
image references and output limits; lifecycle reconnect/history gaps; external
accounting duplicates, idle retention and uncertain intervals. Run source,
PG/Kafka, native/Cube, browser and live checks serially before delivery. Final
evidence lists removed and retained Cube patches with concrete reasons.

### Compatible execution-maintenance repairs

The installed Session-runtime replacement boundary may publish corrections confined
 to `packages/sandbox-control/src/execution-maintenance.ts` through an explicit
`execution-maintenance` scope. This reuses the existing partition/publication drain
and replaces only Session runtime, preserving Worker and VM lifetimes. It does
not authorize changes to lease authority, wire/storage schemas, physical cleanup,
Tool dispatch admission or the meaning of retention. Those require a matched
release. Real PostgreSQL eligibility tests, existing probe contracts and complete
manifest comparison are required before this narrow repair.
