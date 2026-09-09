# Architecture

PiCloud is a private/self-hosted multi-tenant Coding Agent. Pi owns the Agent
Loop, model context, Tool selection and Compaction. PiCloud owns durable input,
execution authority, distributed placement, output projection and Cube lifetimes.
CubeSandbox KVM is the only untrusted execution backend.

## One message

```text
Browser → Control Plane → PostgreSQL ready Run
                            ↓ claim + ExecutionLease
                         Pi Worker
                         ├─ native Session Host / concurrent Lanes
                         ├─ Model Gateway → CLIProxyAPI → Provider
                         └─ direct log append → Kafka ACK
                                                        ↓
                                             Session Projector group
                                             ├─ PG semantic projection
                                             ├─ live view / SSE
                                             └─ Tool command routing
                                                       ↓
                                             owning Tool executor → Cube
                                                       ↓
                                                 result → Worker/Pi

Control authority → PG seal Outbox → Kafka seal → PG terminal + closure
                                                    ↓
                                               next Run eligible
```

The Projector currently runs in the Control Plane process. Its modules remain
separate from authentication, resource APIs and the Agent Loop. There is one
execution-log consumer group, not separate canonical, live and Tool groups.
The old Fact Gateway, Fact WebSocket, secondary channel lease/progress store,
independent projection service and execution-committed notification are removed.
Historical migrations/reports describe their named revisions, not alternate modes.

## Durable input and scheduling

PostgreSQL is the sole Run and execution authority. The public API authenticates
the user, persists input/Turn/Run together and deduplicates admission by Session
and idempotency key. Follow-up remains a queued input; Steer first lives in
`turn_control_requests`. Neither becomes a native Pi user Entry until consumed.

Workers claim `runs` with `FOR UPDATE SKIP LOCKED`. Claim enforces same-Lane
mailbox order, cancellation and predecessor seal completion. It briefly locks
the physical `pi_sessions` row to keep all active Lanes on one Worker boot.
Cold Sessions have no Worker affinity or permanent process. Successful claims
wake the next free slot; LISTEN/NOTIFY reduces idle latency and periodic polling
covers missed wakeups. There is no Temporal or competing dispatcher.

An active physical Session has one Worker-local native log writer, while main
and Child Agent Loops run concurrently. Only native append order is shared.
Child slots are reserved independently so a waiting Parent cannot occupy every
slot its descendants need. KEDA scales from the PG ready-Run backlog; Cube
compute capacity scales separately from Pi Worker slots.

The current ExecutionLease identifies one Attempt and its monotonic Session
fence. Heartbeats renew that authority. Losing a Worker/Run lease requests an
ordered seal; the successor cannot read context until closure is projected.
Workspace access across different Sessions is deliberately ordinary user-managed
Linux concurrency, not a scheduling lock or tenant concurrency quota.

## Direct execution log

At Run opening the PG authority freezes publication scope against the exact
Lease, Attempt, native writer and Lane. The trusted Worker appends an opening
record, then semantic records, display events and concrete Tool commands directly
to private Kafka. An Attempt opens once; there are no signing keys or per-record
signatures.

The Projector caches the recorded scope and requires the ordered opening before
data. The exact seal payload must match the control authority's PG Outbox request.
These checks catch misattributed/stale records; they do not authenticate a hostile
producer. Workers, PG and Kafka are trusted deployment services, inaccessible to
guests and browsers. No token requires a remote authority RPC or a fresh
Lease-expiry SELECT. Expiry triggers retirement; the precise output cutoff is
the seal's log position, not wall-clock expiry.

Kafka ACK means durable append, not guaranteed application of a stale record.
Records physically after their seal cannot alter PG context, live output or
Tool dispatch, even if an old producer finally receives its ACK. The Worker
still stops on lease loss to avoid wasted work. A normally drained Run closes
only its execution; uncertain native publication also closes its shared writer
incarnation. Unrelated Sessions and later writer incarnations stay independent.

The code-owned topic is `pi-cloud.execution-log.v7`. Physical Pi Session ID is
the immutable partition key, shared by all Lanes and control boundaries. Do not
change its partition count in place. Producers use RF3/acks-all and bounded
pending bytes/records, respecting transport backpressure. Worker opening/drain
are one-time authority operations; its ordinary append path only produces.
Provider/guest credentials never enter these records.

## Unified projection and recovery

One `pi-cloud-session-projector-v1` consumer group assigns disjoint partitions.
After scope/opening checks, a record updates native PG state, its disposable
live view and the Tool routing module as applicable. Guest execution itself is
never awaited by the partition handler. PG or live-owner delivery failure stalls
that partition; it does not serialize unrelated partitions.

Native Entry/Record IDs, parents, sequence and timestamps are assigned by the
Worker before Kafka publication. PostgreSQL applies those exact records and
updates projection progress in the same transaction. A crash before commit
replays the record; a crash after commit can redeliver it without changing its
meaning. Native sequence conflicts stop recovery rather than being skipped.
PG transaction-time closure checks remain: a stale Projector handler cannot
overwrite a successor merely because it cached an older OPEN state.

Recovery starts at the minimum of PG's canonical/unsealed-prefix floor and the
group's completed delivery position. This protects both volatile text and a
record whose PG mutation committed before Tool routing finished. Kafka fetching
is not acknowledgement. Complete message/seal transactions advance PG progress;
token fragments create no PG rows. Rebalance invalidates old subscriptions and
rebuilds the assigned prefix before its Projector serves snapshots.

At a seal, one PG transaction stores the exact public terminal, interrupted
visible prefix, Attempt closure and recovery progress. The Projector then updates
the local live view directly. There is no second Kafka commit notice or buffer
waiting for such a notice. A successor is released by the PG closure, not by a
browser ACK. Incomplete Tools remain UNKNOWN; no successful result is invented.

Kafka automatic time/size expiry is disabled. Safe retention stays behind
canonical progress and every unsealed start, with an additional grace interval.
Missing progress or PG failure stops reclamation. A known missing unsealed
prefix is an operator-visible failure. Kafka is not the lifetime transcript or
an unlimited outage buffer; PG retains semantic history and bounded recovery
metadata, while Cube Volumes retain files.

## Browser view

The public SSE request has no cursor. The assigned Projector subscribes to live
wakes, reads canonical history and takes an immutable tail snapshot. It retries
if terminal eviction overtook that PG snapshot; no transaction spans a network
write. The first frame replaces the page with complete history plus materialized
partial output. Recovered text renders immediately; only new deltas animate.

A request arriving on another API replica is proxied to the partition owner
discovered from Kafka group membership. Each replica advertises a unique internal
HTTP URL; Kubernetes derives it from Pod IP. There is no PG partition-owner ring
or second Kafka consumer in this proxy. Both endpoints enforce user/tenant auth.
Internal forwarding bypasses the external Provider HTTP proxy.

Existing readers retain their own snapshot/event references when terminal
projection removes a shared tail. Slow readers have bounded queues and reconnect
for a fresh snapshot. SSE heartbeats keep idle connections open. Pi's first text
delta is sent promptly; adjacent text can coalesce for 25 ms. Tool argument JSON,
thinking fragments and Tool stdout deltas are not public streams. One durable,
argument-free preparation event marks a long Tool-call generation interval, then
the complete Tool start/result replaces it.

## Native Pi state and Harness

The pinned public Pi SessionRepo/SessionStorage adapter stores one self-contained
append-only `pi_session_log` per physical Session. Entries, operation Records,
Lane moves and facts share a Session-local sequence. Entry/Record/Lane/label
tables are query projections. Official Pi backend conformance tests define the
base contract; tenant and cloud ownership checks are additional constraints.

Cold restore reads the newest Compaction and active suffix, not lifetime JSONL.
The active native writer maintains acknowledged Lane views. Each Step reads that
view and returns from writes at Kafka ACK, without PG receipt polling. Pi's
public Agent and Compaction primitives implement the loop; PiCloud does not fork
the unfinished upstream high-level Harness implementation.

Complete model output/usage form one native boundary; Pi-validated Tool intent
forms another. A concrete remote command additionally requires durable publication
and executor admission. Invalid arguments never create execution intent. Native
Compaction retains relevant interruption/World State facts and refuses truncated
or empty summaries. Model retries do not replay completed Tools.

The Harness compares credential-free World State at clean sampling boundaries.
Renewing a lease against the same Cube is not a reset. Recreated compute around
the same Volume emits `sandbox_reset`; replacing the Workspace emits
`workspace_changed`. Facts are minimal, hidden from ordinary UI messages and
preserved through Compaction. A hard interruption's visible prefix is materialized
into the next native context before sampling, together with an interruption fact.

Human Fork creates an independent Session with inherited history; delegated
Branch creates a Lane. Cold administrative mutations require Session quiescence.
Pruning hides later immutable history and moves a Lane head; it never rolls back
Workspace bytes. Deleting a parent includes its descendant transcript views.

## Tools and Cube

Tool Broker is now an execution/lifecycle service, not a Kafka consumer. Its
immutable PG Attempt/binding routes point to one Broker boot. Projector forwards
only commands and small result-retirement/seal notifications through an internal
credential unavailable to the Worker. The receiver folds positions synchronously
and acknowledges admission, not guest completion. Replayed/delayed lower offsets
and reused operation IDs cannot start another effect. Old bindings are never
adopted by a replacement boot. Worker result GETs go directly to the actual owner.

Broker validates the existing Lease/fence, frozen Tool policy and Cloud Step,
then the provider adapter calls Cube's native envd/vsock facilities. Pi cannot
choose arbitrary Pod/VM identities, images, mounts or network policy. No platform
controller or bearer credential is injected into the guest. `read/write/edit/bash`
are the remote tools; Bash accepts only its declared command/timeout parameters.

Completed raw results live in a bounded owner retry cache. Pi performs its usual
redaction/truncation and appends the native Tool Result. Projector forwards the
matching small acknowledgement to retire raw bytes; seals/binding retirement
also release them. Already-admitted work may finish after closure but cannot
repopulate the cache or enter the sealed transcript. UNKNOWN never triggers
automatic shell replay. Kafka fencing cannot undo an already-issued Cube request
or roll back a running process.

`TrustedToolRuntime` supplies code-owned Preview, Subagent and supervisor tools
inside the Worker. These do not execute in Cube. Integration executors are a
separate extension boundary; user-supplied Worker extensions are not supported.

## Workspaces and development machines

An elastic Workspace owns one persistent Cube Volume and at most one bounded-warm
physical Cube. Different Sessions receive independently fenced Tool bindings to
that same environment. Files, ports and processes are shared intentionally. Human
terminals may use it concurrently. Pure chat does not reserve compute. Ordinary
directory/file browsing reads current bytes, not a per-Run file index or archive.

A user-owned development machine is allocated independently, with a selected
CPU/memory/disk template. It retains node-affine full-VM state and has its own home
Volume. Sessions select directories in it. Pause/resume uses Cube state; host
shutdown is not an automatic snapshot. Broker replacement preserves a running
machine's state and uses its encrypted reconnect capsule for validated adoption.
Completing a Run detaches its temporary binding, not the VM. Release deletes the
machine and its Volume, not conversation history.

Deleting an environment/Workspace makes dependent Sessions require rebinding.
Existing messages remain readable. Rebinding is allowed after resource deletion
and only while no Run is active; a new Run freezes the new Workspace. A trusted
deletion coordinator and Cube Volume Controller remove actual bytes, including
root-owned files, before committing purge completion. There is no Kopia/S3
Workspace authority or platform-managed Git tree.

Preview is published by a trusted tool after an actual listening-service probe.
Authenticated isolated origins proxy HTTP/WebSocket traffic through Broker's
credential-free guest relay. There is no localhost replacement in model text or
fixed application-port reservation. Human Web Terminal and one-use SSH tickets
use independent product authority; they are not Agent execution commands.

## Models, Subagents and integrations

CLIProxyAPI owns upstream subscription/API credentials and account affinity.
Workers see only scoped model-runtime access through their local Model Gateway.
Provider/model/reasoning/Fast settings are immutable per accepted Turn. Hosted
search stays provider-native; verified GPT/DeepSeek actions and citations are
stored in native assistant messages, with portable replay across providers.
Image input/generation remain outside the current public feature boundary.

The upstream pi-subagents contract is adapted to durable Lane Runs, not personas.
Fresh context and inherited context are independent of shared/isolated Workspace
selection. All active Lanes share one physical Session owner; PG holds durable
parent/child communication and cancellation state. Defaults bound recursive depth
to 4, total nodes to 32 and simultaneous descendants to 3. Isolated children use
internal Workspace copies; the context/communication model is unchanged.

Optional GitLab Issue intake uses ordinary Run admission after the user chooses
an execution environment. The platform never clones or commits automatically.
Environment-local origin-scoped Git credentials belong to the Agent's Linux
environment, not the conversation database. Provider Webhook/project credentials
remain separate trusted integration secrets. No GitLab is required for ordinary
PiCloud deployment or local-account login.

## Authorities and scaling

| Concern | Authority |
| --- | --- |
| users, resources, Runs, leases and fences | PostgreSQL |
| publication scope and ordered closure | PG-issued metadata + execution log |
| not-yet-reclaimed output records | Kafka |
| semantic Session history and query projections | PostgreSQL |
| native active Lane context and browser tail | rebuildable Worker/Projector memory |
| Workspace bytes | persistent Cube Volume |
| guest processes/memory | the live Cube or a surviving native VM snapshot |
| model account credentials/selection | CLIProxyAPI |

Worker replicas add Agent Loop slots; Projector replicas divide Kafka partitions;
Tool executors and Cube nodes add execution capacity. Cross-owner result and SSE
routes remain explicit. No Cell, worker-affinity queue or second scheduler is
required. See [run lifecycle](RUN_LIFECYCLE.md), [crash contracts](STREAM_DURABILITY.md)
and [configuration](CONFIGURATION.md) for operational boundaries.
