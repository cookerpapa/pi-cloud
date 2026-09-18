# Architecture

PiCloud is a private/self-hosted multi-tenant Coding Agent. Pi owns the Agent
Loop, model context, Tool selection and Compaction. PiCloud owns durable input,
execution authority, distributed placement, output projection and Cube lifetimes.
CubeSandbox KVM is the only untrusted execution backend.

## One message

```text
Browser → Control Plane → PostgreSQL ready Run
                            ↓ claim + shared Session lease
                         Pi Worker
                         ├─ native Session Host / concurrent Lanes
                         ├─ Model Gateway → CLIProxyAPI → Provider
                         └─ direct log append → Kafka ACK
                                                        ↓
                                             Session Projector group
                                             ├─ PG semantic projection
                                             ├─ live view / SSE
                                             ├─ Subagent admission / delivery → Worker Lanes
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

Within Control Plane, `ConversationReader` owns tenant-scoped history/list reads;
Run admission and resource mutations stay in `ControlPlaneStore`. A conversation
snapshot, inherited history and display coverage still share one repeatable-read
transaction. This is an internal code boundary, not another service or database.
Tree navigation also uses one repeatable-read snapshot and each native Entry's
persisted Turn binding; it never pairs prompts and answers by message count.
Human Fork copies preserve that binding in their self-contained log.
Canonical Turn reads select its actual execution Session, excluding inherited
copies even after a Fork's query projections are rebuilt.

## Durable input and scheduling

PostgreSQL is the sole Run and execution authority. The public API authenticates
the user, persists input/Turn/Run together and deduplicates admission by Session
and idempotency key. Follow-up remains a queued input; Steer first lives in
`turn_control_requests`. Neither becomes a native Pi user Entry until consumed.

Workers claim `runs` with `FOR UPDATE SKIP LOCKED`. Claim enforces same-Lane
mailbox order, cancellation and predecessor seal completion. It briefly locks
the physical `pi_sessions` row to keep all active Lanes on one Worker boot.
One materialized candidate supplies the startup context without a second queue
scan. Immutable Session kind and Workspace seed kind travel in the internal
execute command; downstream preparation does not re-query them.
Claim, Session lease binding and publication registration commit together;
failed admission reserves neither an Attempt nor capacity. The durable started
transition precedes Kafka opening, keeping pre-start requeue output-free. An
uncertain admission COMMIT can resume only its exact confirmed record (ADR-0174).
Cold Sessions have no Worker affinity or permanent process. Successful claims
wake the next free slot; LISTEN/NOTIFY reduces idle latency and periodic polling
covers missed wakeups. There is no Temporal or competing dispatcher.

An active physical Session occupies one Worker slot and has one native writer
and one owner lease, while main and Child Agent Loops run concurrently. Model
requests share a separate, abortable, round-robin budget keyed by physical Session;
Tools/child waits hold no model permit. Tree depth and total nodes remain bounded.
KEDA counts active/ready physical families, not descendant Run rows. Cube compute
capacity scales independently. Draining rejects new families but finishes existing
families, including their newly delegated children.

Admission permits at most two in-flight Run claims
per Worker (ADR-0175). Unknown claims conservatively reserve possible family and
Lane capacity until commit or failure; PG remains the final authority. This
does not raise model concurrency, change per-Session ownership or allow a
successor to skip the predecessor's seal. New work arriving during an older
empty scan is rechecked on completion; idle scans do not self-wake indefinitely.

`session_leases` has one row per `(tenant_id, pi_session_id)`. Its ID and monotonic
`pi_sessions.lease_epoch` identify an ownership period. Heartbeats renew each
family once; quiet tasks do not lose separate leases. Each RunAttempt carries a
task `ExecutionReference` (shared lease/epoch plus Attempt ID), not another lease.
The read-only `active_execution_scopes` view combines task state with owner authority
for executor checks. Task cancellation closes that task; lost ownership retires
the family, and a successor waits for all affected ordered closures to project.
Workspace access across different Sessions is deliberately ordinary user-managed
Linux concurrency, not a scheduling lock or tenant concurrency quota.

Lease decisions use primary PostgreSQL `clock_timestamp()` after authority-row
locks, not application timestamps or transaction-start `now()` (ADR-0170).
Renewal cannot revive an expired owner after a lock wait, and retirement checks
the current locked lease again. Local Worker/Broker deadlines use a conservative
monotonic observation of the database's remaining lifetime. They trigger local
cancellation; the database and ordered seals still decide authority. This adds
no per-token or per-Step SQL check. Database clock/failover discipline remains an
operator responsibility.

## Direct execution log

During atomic execution admission the PG authority freezes publication scope against the exact
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

The code-owned topic is `pi-cloud.execution-log.v8`. Physical Pi Session ID is
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
Native message/Tool-intent projection co-commits display event/native positions
on the Attempt. Active conversation reads stop at that semantic boundary. A
proposed Tool is not rendered as running until its native execution intent exists.
Only text covered by the native content is evicted; mismatched/incomplete text
remains pending for interruption recovery. These metadata updates are not a
second transcript or a per-delta PG write.

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

A quarantined Session becomes idle only after its latest failed execution has
both positive Agent exit evidence and a committed seal (ADR-0169). Exit is recorded
after the local Runner settles, or after an exact Worker-stop confirmation;
lease expiry and an unreachable management endpoint do not establish that fact.
The two facts may arrive in either order. Recovery accepts a new Run, retains the
old failure, and never replays its Tool calls. This adds no per-delta or per-Step
database barrier. A stale browser failure state may submit a new-message request,
but admission remains server-authoritative until recovery actually completes.

Kafka automatic time/size expiry is disabled. Safe retention stays behind
canonical progress and every unsealed start, with an additional grace interval.
Missing progress or PG failure stops reclamation. A known missing unsealed
prefix is an operator-visible failure. Kafka is not the lifetime transcript or
an unlimited outage buffer; PG retains semantic history and bounded recovery
metadata, while Cube Volumes retain files.

## Browser view

The public SSE request has no cursor. The assigned Projector subscribes to live
wakes, captures an immutable tail and then reads primary PG. That PG snapshot
cannot precede coverage already committed and observed by the tail. It merges
canonical messages with uncovered spans into one presentation, not a replay of
raw deltas. No transaction spans a network write.

Snapshots and large complete events use begin/part/end SSE framing with bounded
parts and incremental JSON encoding/decoding. A disconnected partial value is
discarded; only a complete replacement is applied. Small live events remain
immediate. The browser does not submit Kafka offsets or Last-Event-ID. A local
POST which raced with an older snapshot invalidates that UI request, not the Run.
History opens on the latest 40 Turns; earlier pages use an owned Turn identity.
Tree jumps load missing pages, and export traverses them. These history anchors
are not stream recovery cursors.

A request arriving on another API replica is proxied to the partition owner
discovered from Kafka group membership. Each replica advertises a unique internal
HTTP URL; Kubernetes derives it from Pod IP. There is no PG partition-owner ring
or second Kafka consumer in this proxy. Both endpoints enforce user/tenant auth.
Internal forwarding bypasses the external Provider HTTP proxy.

Existing readers retain immutable references while semantic commits remove
covered spans. Completed snapshot objects are released after sending, not held
for the lifetime of an SSE connection. Blocked writes have a 30-second deadline;
slow readers disconnect without blocking Kafka or other viewers. Pending text
still needs memory proportional to its actual content, not constant RAM for
unbounded output. SSE heartbeats keep idle connections open. Pi's first text
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
Child task views are read-only; human Fork/prune actions remain available only
in ordinary conversation views.
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

Physical capacity and FIFO allocation waiters belong to `SandboxAdmission`;
Broker retains warm eviction and Cube lifecycle ownership. Shutdown closes
admission before detaching machines, so freed slots cannot launch queued creates.
Recovered machines count even above a newly lowered capacity; new allocation
waits until usage falls below the limit. This is not a Workspace write lock or
tenant scheduling quota.

Completed raw results live in a bounded owner retry cache. Pi performs its usual
redaction/truncation and appends the native Tool Result. Projector forwards the
matching small acknowledgement to retire raw bytes; seals/binding retirement
also release them. Already-admitted work may finish after closure but cannot
repopulate the cache or enter the sealed transcript. UNKNOWN never triggers
automatic shell replay. Kafka fencing cannot undo an already-issued Cube request
or roll back a running process.

`TrustedToolRuntime` supplies thin, code-owned tool adapters. Subagent start,
communication and cancellation requests append to Kafka; Projector persists
idempotent admission and dispatch state, then routes native Lane operations to
the owning Worker. Long preparation and result waits never block its partition
handler. Result notifications use the Worker management channel, independently
of the Provider HTTP proxy, rather than per-child status polling.

Direct delegation creates no script or Cube. Workflow JavaScript runs in Cube
through envd's bounded stdin/stdout bridge. Guest `runs.*` requests return to the
owning Worker publication port; no PG/Kafka/model credentials enter the guest.
The script's explicit return becomes the outer Tool Result. Variables and JS
call stacks are not recovery checkpoints. Preview remains a fixed trusted
platform adapter; user-supplied Worker extensions are not supported.

## Workspaces and development machines

An elastic Workspace owns one persistent Cube Volume and one default bounded-warm
compute scope. Different ordinary Sessions receive independently fenced Tool bindings to
that same environment. Files, ports and processes are shared intentionally. Human
terminals may use it concurrently. Pure chat does not reserve compute. Ordinary
directory/file browsing reads current bytes, not a per-Run file index or archive.
No runtime object or Workspace settlement head is required to start a Run or
retain compute. Environment validation is recorded at activation. Oversized
raw Tool output is not archived; the native result contains bounded output and
truncation guidance. Subagents can create additional temporary compute scopes
mounting the same Volume; stopping a scope never deletes shared files.

Cube's Controller Volume Plugin initializes storage and atomically publishes one
immutable Volume identity. The trusted Volume Gateway verifies that identity; it
never repairs or initializes storage during a read. Guest seed initialization
only supplies missing files and cannot clear existing user data. A separate
generation-bound deletion grant still expresses PG-authorized release, not mount
refcount. See [ADR-0172](adr/0172-plugin-owned-volume-initialization.md).

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

The role-free Subagent tool uses Pi's public runtime/storage contracts and the
community `runs.run`/`runs.all` programming model, not a CLI-emulation backend.
Fresh context and inherited context are independent of shared/ephemeral compute
selection and working directory. All active Lanes share one physical Session owner; PG holds durable
parent/child communication and cancellation state. Defaults bound recursive depth
to 4 and total descendants to 32. Worker and per-Session model request limits
default to 4; children are not rejected merely because another child is waiting.
An ephemeral child uses a new lazy, bounded-warm Cube against the parent Volume.
Shared descendants inherit that compute scope. The accepted Run freezes the scope
and cwd; explicit directories must exist. Elastic Volumes retain `/workspace` and
machine home Volumes retain `/home/user` in every Cube. A machine's system disk
is not exposed through this mode. The parent can create worktrees using Git,
then pass their paths; PiCloud neither copies Workspaces nor initializes,
commits or merges repositories. This is cooperative shared storage, not file
security isolation. See [ADR-0171](adr/0171-shared-volume-subagent-compute.md).

Blocking supervisor requests remain supported through the same control log.
Agent-input IDs identify native consumption, preventing a replayed notification
from duplicating model context. Task completion is distinct from a progress or
delivery receipt. This release uses foreground-owned tasks; `follow_up` queues
input on an active Agent, and a closed task reports a missed delivery rather
than silently spawning another one. Autonomous background wake is not implemented.

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

Worker replicas add Session-family slots; Projector replicas divide Kafka partitions;
Tool executors and Cube nodes add execution capacity. Cross-owner result and SSE
routes remain explicit. No Cell, worker-affinity queue or second scheduler is
required. See [run lifecycle](RUN_LIFECYCLE.md), [crash contracts](STREAM_DURABILITY.md)
and [configuration](CONFIGURATION.md) for operational boundaries.

## Intentional coupling and unverified boundaries

API and Projector share a process. PG or live-owner admission failure stalls its
Kafka partition, though guest execution does not; other partition handlers can
proceed. Active Lanes share one native writer/Worker, not arbitrary placement
across Workers. History outside the in-memory active branch still waits for PG
projection before reading. These are explicit tradeoffs, not independent-HA claims.

Executor admission and log seals do not atomically revoke a request already
sent to Cube or kill guest processes. The Cube-native launch-generation contract
remains unimplemented; existing no-replay/UNKNOWN tests do not prove physical
execution fencing. PG failover, Cube node drain and full multi-node HA remain
separate deployment acceptance work. The isolated duplicate SSE opening remains
unexplained; reproducing intentional stale-snapshot cancellation is not its fix.
