# Architecture

PiCloud is a private/self-hosted multi-tenant Coding Agent. Pi owns the Agent
Loop, model context, Tool selection and Compaction. PiCloud owns durable input,
execution authority, distributed placement, output projection and Cube lifetimes.
CubeSandbox KVM is the only untrusted execution backend.

## One message

```text
Browser → Control Plane → PostgreSQL accepted Run
                            ↓ Lane ready → atomic claim + shared Session lease
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
                                                 native reply → Kafka reply topic → Worker/Pi

Control authority → PG seal Outbox → Kafka seal → PG terminal + closure
                                                    ↓
                                               next Run eligible
```

The Projector currently runs in the Control Plane process. Its modules remain
separate from authentication, resource APIs and the Agent Loop. There is one
execution-log consumer group, not separate canonical, live and Tool groups.
Native append and seal transactions have PostgreSQL-local lock/statement budgets;
timeout rolls back without advancing offsets or admitting a Tool. Failed records
retry in partition order. Phase metrics and payload-free slow-record diagnostics
locate waits without introducing another consumer or a skip/dead-letter path
([ADR-0199](adr/0199-bounded-publication-and-projection.md)).
Image bytes travel over Cube's existing HTTP transport and a private S3 attachment
port. Broker externalizes image parts before Kafka replies; Worker restores them
before native Tool completion. The Session append codec externalizes the final
after-hook content too. PG native-log rows retain references; public SessionStorage
reads reconstruct the exact native images. PG plus retained attachments is the
lossless native history (ADR-0192), while Cube Volume remains Workspace authority.
The old Fact Gateway, Fact WebSocket, secondary channel lease/progress store,
independent projection service and execution-committed notification are removed.
Historical migrations/reports describe their named revisions, not alternate modes.

Seal insertion emits an empty commit-time PG notification. One session-affine
LISTEN connection per Projector wakes the existing terminal Outbox claimant;
50ms polling still covers missing hints and reconnects. Hints delivered during
an empty scan are retained by generation, and cannot bypass publication backoff.
No browser payload or authority moves through NOTIFY. Drain proof and completion
remain separate durable boundaries (ADR-0177).

Within Control Plane, `ConversationReader` owns tenant-scoped history/list reads;
Run admission and resource mutations stay in `ControlPlaneStore`. A conversation
snapshot, inherited history and display coverage still share one repeatable-read
transaction. This is an internal code boundary, not another service or database.
Tree navigation also uses one repeatable-read snapshot and each native Entry's
persisted Turn binding; it never pairs prompts and answers by message count.
Human Fork copies preserve that binding in their self-contained log.
Canonical Turn reads select its actual execution Session, excluding inherited
copies in independent Fork logs.

## Durable input and scheduling

PostgreSQL is the sole Run and execution authority. The public API authenticates
the user, persists input/Turn/Run together and deduplicates admission by Session
and idempotency key. Follow-up remains a queued input; Steer first lives in
`turn_control_requests`. Neither becomes a native Pi user Entry until consumed.
Steer uses the Worker HTTP management endpoint; WebSocket carries registration
and heartbeats, not an alternative execution or Steer transport.

The Web composer queues a new Turn with Enter while a Run is active; its Steer
button instead sends the current draft to that Run. Product queued Turns start
only after predecessor closure and Lane readiness. Native in-Run steer is
consumed after the current model response/Tool batch, before the next model
request. Native follow-up is consumed when that Agent would otherwise stop;
internal verification reminders and Agent messages use this path. These two
follow-up lifecycles are distinct. Pending ordinary-conversation inputs can be
edited, reordered by adjacent swaps, individually removed or promoted to the
active Run. Input text/order freeze at admission. Model/environment/credential
snapshots remain frozen at acceptance. Started inputs and consumed steer cannot
be recalled. The stop action still cancels only the active Turn (ADR-0194).

Queue mutations use the product Session revision and a bounded idempotency
receipt in `turn_control_requests` (`kind=queue`). They acquire affected queued
Run/Turn locks with NOWAIT while holding the Session lock, so a concurrent Worker
claim returns a conflict without a lock cycle. PostgreSQL's deferrable mailbox
uniqueness permits atomic adjacent swaps. Original acceptance fingerprints remain
unchanged. Unstarted cancelled rows are retained as audit/idempotency tombstones,
outside conversation history. At most 64 pending inputs are accepted per Session.
Queue reads return revision, active input and pending order in one SQL snapshot;
they do not open a transaction for each browser poll.

Promotion holds the source out of readiness and creates a control request in the
same transaction. Its payload references the held Turn text. A bounded reconciler
uses the existing HTTP steer transport and stable native input identity; no PG
transaction spans that RPC. Two local deliveries may run concurrently, while
promotions to the same Run retain acceptance order through acknowledgements.
Only a canonical user Entry confirms consumption and retires the queued source.
A projected target seal plus absent Entry restores the input to its queue position;
an HTTP error alone cannot restore it. This is input reconciliation, not another
Run scheduler or a mechanism to replay arbitrary Tools.

The Runner rechecks native queues after a successful Agent continuation and
closes input admission synchronously with its last empty-queue decision. Final
native writes occur after that close; late control delivery returns the existing
target-unavailable error. Input delivery rechecks closure after asynchronous
authority/deduplication reads (ADR-0193).

`queued` means accepted, not necessarily dispatchable. Input acceptance freezes
the model/configuration and writes Turn, Run and mailbox advancement together;
`ready_at` is set only for a Lane head whose predecessor has closed. Otherwise
seal projection promotes it in the closure transaction. Both paths hold the
product Session row lock, so racing input and closure cannot lose readiness.
Child preparation readies its own Lane without waiting for its parent to finish.
Unchanged environment versions use a shared read. Only an image-version change
locks the Project for update and re-reads the current version; ordinary input
does not serialize unrelated Sessions on that Project.

Workers claim only ready `runs` with `FOR UPDATE SKIP LOCKED`. Local pending/active
family reservations decide capacity; PG checks ownership and parent liveness,
not predecessor history again.
It locks the physical `pi_sessions` row to keep active Lanes on one Worker boot.
Its `unsealed_runs` count permits cold ownership only after all older tasks have
closed; a healthy current owner can continue ready sibling Lanes. A Run
row trigger updates the count on owner binding/first seal in the existing transactions.
It adds no client round trip; rollback and duplicate seal delivery cannot drift it.
One materialized candidate supplies the startup context without a second queue
scan. Immutable Session kind and Workspace seed kind travel in the internal
execute command; downstream preparation does not re-query them.
Mutable pending input text is read in a fresh statement after the candidate Run
lock, avoiding a stale joined value from the original statement snapshot. This
adds one `input_snapshot` admission read, never a per-Step query.
Session lease binding, publication scope and running state commit together in
one Run update; rejected admission leaves input queued without another execution
identity. The Runner
prepares and executes immediately after that commit, without separate started/
running transactions or an opening append. An uncertain admission COMMIT can
resume only its exact confirmed record; a post-admission failure requires a seal,
not a pre-start requeue (ADR-0180). Transaction-local locked facts flow into
lease issuance and one conditional running write, which checks database time
after all locks. There is no persisted claimed stage, RunAttempt or startup lease.
Cold Sessions have no Worker affinity or permanent process. Successful claims
wake the next free slot; LISTEN/NOTIFY reduces idle latency and periodic polling
covers missed wakeups. There is no Temporal or competing dispatcher.

An active physical Session occupies one local Worker slot and has one native writer
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

`session_leases` has one current owner per `(tenant_id, pi_session_id)` and retains
released incarnations as closure evidence. Its ID is also the native writer ID;
`pi_sessions.lease_epoch` is the monotonic Fence. Heartbeats renew each family
once; released or expired owners cannot revive. Each Run carries an
`ExecutionReference` (Run ID plus Session lease/epoch), not another lease.
The read-only `active_execution_scopes` view combines Run state with current owner
authority for executor checks. Task cancellation closes that task; lost ownership retires
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

Native writers share one Worker-local lease observer. A single read batch checks
all observed owners, retaining the one-second revocation observation interval.
Committed direct-PG heartbeat renewals feed that same cache. Late reads cannot
overwrite newer renewal evidence, late renewals cannot revive a revoked observer,
and closing one Lane retains observation for its siblings. Expired cold-restore
observations refresh from PG before rejection. Broker fencing remains independent.

Control Plane expiry sweeps and remote Worker retirement run in independent,
non-overlapping loops. Retirement uses one concurrent claim and the existing
bounded management requests/retries; slow remote cleanup cannot delay the next
lease sweep. The initial expiry query takes one PG-time cutoff, and final
decisions still recheck authority after locks. The one-second interval is a
delay between completed scans, not a one-second failure-detection guarantee.

## Direct execution log

During atomic execution admission the PG authority freezes publication scope against the exact
Run, Session lease and Lane. The trusted Worker appends semantic
records, display events and concrete Tool commands directly to private Kafka.
There is no standalone opening record, signing key or per-record signature.

The Projector caches the recorded scope. The first native append co-commits its
recovery floor with semantic state; a first display/control record persists that
floor before visibility or routing. The exact seal payload must match the PG Outbox request.
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

The code-owned topic is `pi-cloud.execution-log.v11`. Physical Pi Session ID is
the immutable partition key, shared by all Lanes and control boundaries. Do not
change its partition count in place. Producers use RF3/acks-all and bounded
pending bytes/records, respecting transport backpressure. Worker admission/drain
are one-time authority operations; its ordinary append path only produces.
Provider/guest credentials never enter these records.

Hot event and Worker-envelope schemas compile once per server process. Browser
bundles select the same schemas' non-code-generating checker through package
conditions, preserving strict CSP. Validation rules and public errors are
unchanged; this introduces no authority cache or additional durability boundary.

## Unified projection and recovery

One `pi-cloud-session-projector-v1` consumer group assigns disjoint partitions.
After scope/closure checks, a record updates native PG state, its disposable
live view and the Tool routing module as applicable. Guest execution itself is
never awaited by the partition handler. PG or live-owner delivery failure stalls
that partition; it does not serialize unrelated partitions.

Native Entry/Record IDs, parents, sequence and timestamps are assigned by the
Worker before Kafka publication. PostgreSQL applies those exact records and
updates projection progress in the same transaction. A crash before commit
replays the record; a crash after commit can redeliver it without changing its
meaning. Native sequence conflicts stop recovery rather than being skipped.
Projection reads its prior append, Lane heads and identity conflicts together,
but only after acquiring the physical Session lock in a separate statement.
This preserves a fresh snapshot after waiting for another projection.
Native message/Tool-intent projection co-commits display event/native positions
on the Run. Active conversation reads stop at that semantic boundary. A
proposed Tool is not rendered as running until its native execution intent exists.
Only text covered by the native content is evicted; mismatched/incomplete text
remains pending for interruption recovery. These metadata updates are not a
second transcript or a per-delta PG write.

PG transaction-time closure checks remain: a stale Projector handler cannot
overwrite a successor merely because it cached an older OPEN state.

Recovery starts at the minimum of PG's canonical/unsealed-prefix floor and the
group's committed position. It can replay text/native history but cannot move
the dispatch commit backwards. A new Tool command is dispatched only after its
Kafka offset commit is confirmed; commands below that commit are never dispatched
again during projection replay. A crash between commit and dispatch may omit
execution and remains UNKNOWN. Kafka fetching is not acknowledgement. Complete
message/seal transactions advance PG progress; token fragments create no PG rows.
Rebalance invalidates old subscriptions and rebuilds the assigned prefix before
its Projector serves snapshots.

At a seal, one PG transaction stores the exact public terminal, interrupted
visible prefix, Run closure and recovery progress. The Projector then updates
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
Queued inputs and unstarted cancellations do not occupy history pages or Turn
counts. The composer owns a separate pending-input view, refreshed every two
seconds while visible, on focus and after input actions. Queue changes do not
restart the execution SSE stream. Optimistic conflicts preserve the editing draft.
Tree jumps load missing pages, and export traverses them. These history anchors
are not stream recovery cursors.

Conversation discovery returns pages of 100 Sessions with an optional opaque
`nextCursor`. It preserves PostgreSQL timestamp precision for the descending
activity/ID position; every page retains tenant and archive filtering. Browser
load-more appends by Session ID, and a newer refresh invalidates an older page
request. This list position is neither authorization nor an SSE cursor.

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
delta of a streaming answer is sent promptly; adjacent text can coalesce for 25 ms.
On the verified GPT route, early provider phase distinguishes complete commentary
from a streaming final answer. Commentary publishes once at Pi's text_end and
renders without typing animation; original native phase/signatures remain intact.
DeepSeek's early phase can change at completion, so that route retains ordinary
text streaming. No wording heuristics or buffered "fake streaming" are used.
See [ADR-0182](adr/0182-assistant-message-presentation.md). Tool argument JSON,
thinking fragments are not public streams. Temporary Tool output snapshots use
a separate unsequenced SSE event, described below. One durable,
argument-free preparation event marks a long Tool-call generation interval, then
the complete Tool start/result replaces it.

Every active browser turn also has a persistent runtime status. The trusted
Runner maps native lifecycle/stream events into PiCloud phases and last-activity
time. Worker sends bounded, coalesced HTTP observations to the existing Projector
partition owner; its cached admitted scope checks tenant, Run, writer and fence.
The existing Worker management credential protects this private ingress.
`run.activity` and `run.path` are unsequenced, disposable SSE frames. Slow readers
retain only the latest values; reconnect starts without old observation history.
Only active turns may display them, and terminal state wins over late frames.

Ordinary successfully processed execution records provide path evidence. After
publication silence, one physical Session emits at most one `path_probe` every
15 seconds through its existing direct writer and Kafka partition. There is at
most one outstanding probe per family, and an acknowledged ordinary record must
precede it. The probe is the explicit observation-transport exception: it enters
Kafka to measure that path, but never native Pi history, PG projection, display
sequence, model context or Tool routing. It neither renews leases nor changes
recovery authority. Original timestamps and monotonic positions prevent replay
from appearing fresh; evidence older than 45 seconds is stale. A probe ACK failure
does not create an uncertain semantic mutation; shared producer failures retain
the existing fail-closed behavior. Phase, actual model/Tool activity and path
confirmation are separate UI signals. See [ADR-0201](adr/0201-runtime-activity-and-path-probes.md).

## Native Pi state and Harness

The pinned public Pi SessionRepo/SessionStorage adapter stores one self-contained
append-only `pi_session_log` per physical Session. Entries, operation Records,
Lane moves and facts share a Session-local sequence. Stored generated metadata
and scoped indexes serve Entry/Record reads directly from that log; no separate
Entry/Record body tables or COW references remain. Branch reads walk metadata by
parent ID before fetching only the selected bodies. Official Pi backend
conformance tests define the base contract; tenant and cloud ownership checks
are additional constraints (ADR-0197).

Names, Lane heads, labels and references to currently unfinished operations are
transactional current state. A log-insert statement trigger applies operation
starts/finishes as one batch; recovery reads this small state instead of joining
lifetime operation history. Multiple open starts remain visible as corruption.
Rebuild requires quiescence and reconstructs only current state, without rewriting
native bodies or executing Tools. Immutable `payload.turnId` retains origin;
the live `turn_id` FK can become null on control-row deletion and stays null
through a rebuild. Native Fork copies own their bodies and image references,
so deleting their native source does not invalidate them. Product subtree
archive/prune rules continue to govern the human conversation tree.
Image parts have a `pi_cloud_image_v1` storage representation. Their immutable
objects are retained transactionally when native log rows commit, including Fork
copies and Compaction retained tails. Reachability follows retained native history,
not a mutable Workspace path or an expiring provider URL. Pending attachments of
unsealed Runs survive projection lag. Cleanup claims unreferenced inventory under
PG row locks, then deletes S3 objects outside the transaction; failures are retryable.
`pi-session-postgres` owns this storage contract. Concrete Pi execution lives in
`sandbox-supervisor`; Worker execution wiring lives in `supervisor-host`, so
`runtime-core` no longer depends on the concrete Pi Runner. Fake models are test-injected only.

Cold restore reads the newest Compaction and active suffix, not lifetime JSONL.
Writer metadata, next sequence and Lane heads load in one owner-scoped SQL
snapshot. Worker management identities and the pinned Pi version belong to the
shared protocol package; the Control Plane does not import those contracts from
the concrete Runner.
Native append/checkpoint ports live in the internal `protocol/native-session`
entry point. Runner code depends on that contract, not on the PG implementation;
the PG adapter implements it without re-exporting a compatibility alias.
The active native writer maintains acknowledged Lane views. Each Step reads that
view and returns from writes at Kafka ACK, without PG receipt polling. Pi's
public Agent and Compaction primitives implement the loop; PiCloud does not fork
the unfinished upstream high-level Harness implementation.

Complete model output/usage form one native boundary. After Pi validation and
before-hooks, fixed remote Tools prepare their binding and reply callback; one
`tool_invocation` record then carries native intent, display start and dispatch.
The command reuses the intent's arguments and identities. One Kafka ACK covers
that second boundary; Projector still commits dispatch before Broker admission
(ADR-0198). Invalid arguments never create execution intent. Native
Compaction retains relevant interruption/World State facts and refuses truncated
or empty summaries. Model retries do not replay completed Tools.

Native Step attempt numbers restart after a completed response; only retries of
an unfinished Step increment them. Tool ordinals refer to the original Assistant
Tool-call list, including rejected calls. Code-owned before/after policies use
Pi's hooks: rejection precedes intent, and the after-hook result becomes native
history. No user extension or durable approval UI is introduced.

The native Tool Result Entry ID is also the cloud invocation identity used by
public Tool events, progress and Subagent deduplication. Provider Tool IDs remain
unchanged in Pi messages and guest replies. The remote operation UUID separately
correlates Kafka callbacks. Cold projection uses the result Entry identity too;
Compaction reason and size presentation come from its native Step and context.

An explicit current-model context-overflow error forces one native Compaction
and sampling continuation even below the estimated threshold (ADR-0176).
The summary is acknowledged before a fresh model Step; completed Tools and the
accepted input are not replayed. Another overflow without successful sampling,
failed/canceled summary or lost authority stops recovery. This is separate from
transport retries against an unchanged frozen Step. Window/threshold settings
remain unchanged, and irreducible context errors remain visible to the user.

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

Tool Broker is an execution/lifecycle service, not an execution-log consumer.
Immutable PG Run/binding routes point to one Broker boot. Projector forwards
commands and seals through an internal credential unavailable to the Worker.
It confirms Kafka commit before dispatch and does not retry ambiguous command
delivery. The receiver folds positions synchronously and acknowledges admission,
not guest completion. Old bindings are never adopted by a replacement boot.
There is no completed-result GET endpoint or PostgreSQL operation ledger.

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

The guest executes the whole fixed Tool, with native edit/write logic and source
output bounds. Internal reads/writes are not separate RPCs. The trusted Cube
adapter forwards Pi-native final results to a Worker-boot Kafka reply topic;
all slots share one topic. A random operation ID correlates the waiting callback,
not authority. The final reply resolves or
rejects `execute`. Pi still owns after-Tool hooks, its lifecycle events and the
canonical Tool Result appended to the execution log. Kafka reply ACK releases transport buffers, with
no completed-result cache or per-result retirement notification.
Kafka replies accept only the final result; guest updates use the separate HTTP
observation path. The Worker observes its reply Promise before awaiting command
publication and retires it on every exit, including image-decoding failure.
The Projector expands a combined invocation into the existing Broker command
only after materializing its native intent. Cancellation before the invocation
enters its publication queue prevents dispatch; later cancellation can race
execution even before the producing Worker receives its ACK. Projection replay
never reissues the command.

Guest file Tools treat cwd as a relative-path base and follow ordinary guest
paths/symlinks. Native Node writes retain byte bounds, edit-conflict detection
and file/parent fsync before success. Host Volume browsing retains its separate
containment checks. Pi may run read-only/delegation batches concurrently; any
fixed write/edit/bash in a batch retains native sequential execution. Existing
Tool, child-tree and executor limits remain, as does one ordered Session writer.
The former per-file and raw Bash RPC forms are removed; native Tools and scoped
workflows are the only Agent execution requests. Text reads retain Pi's LF split,
CR and BOM behavior, including an empty final line, within the existing bounds.

One Runner sampling-context adapter prepares World State and model headers for
both pure chat and file-capable Runs. The Step's `activeTools` is explicitly the
file/shell grant; Pi owns the complete executable Tool registry. Preparing an
empty file grant does not activate Cube.

Pi source updates are disposable observations, not model context. Bash emits
bounded snapshots at most once per second; Broker coalesces the newest text per
active operation (8,192 characters) and sends pooled HTTP to Projector. An internal
credential protects ingress. Partition ownership redirects use existing Kafka
membership, not a PG query. Failures drop snapshots and cannot fail the Tool.
SSE subscribers keep bounded newest observations separately from formal sequence;
only running Tools can display them. Complete results/terminal events win over
late progress. Reconnect starts without old observations. The browser renders an
opt-in fixed-height preview without updating the transcript or scrolling it.
No Kafka/PG row, replay, Worker callback or background-service log follower is
created for progress. See [ADR-0184](adr/0184-ephemeral-tool-progress.md).

Reply topics have bounded retention, are deleted at graceful Worker shutdown,
and are reaped only after positively completed Worker retirement plus grace.
They are not a cold recovery source. Already-admitted work may finish after
closure; late replies cannot reopen a call or enter sealed history. UNKNOWN
never triggers automatic shell replay. Kafka fencing cannot undo an already-issued
Cube request or roll back a running process. See [ADR-0183](adr/0183-native-remote-tool-execution.md).

Worker-local `supervisor-host/src/tools` supplies the code-owned Tool adapters.
The separate `subagent-control` package owns PG task coordination and has no
Runner dependency; Control Plane neither imports nor copies Runner source.
Subagent start,
communication and cancellation requests append to Kafka; Projector persists
idempotent admission and dispatch state, then routes native Lane operations to
the owning Worker. Long preparation and result waits never block its partition
handler. Result notifications use the Worker management channel, independently
of the Provider HTTP proxy, rather than per-child status polling.

Direct delegation creates no script or Cube. Workflow JavaScript runs in Cube
through envd's bounded stdin/stdout bridge. Guest `runs.*` requests return to the
owning Worker publication port; no PG/Kafka/model credentials enter the guest.
The script's explicit return travels over the Kafka reply channel and becomes
the outer Tool Result. Its `runs.*` duplex host-call channel is unchanged. Variables and JS
call stacks are not recovery checkpoints. Preview remains a fixed trusted
platform adapter; user-supplied Worker extensions are not supported.

Subagent return admission bounds JSON-encoded text to 256 KiB, leaving space for
the native Entry and accompanying display event inside the unchanged 900 KiB
execution-fact limit. Guest completion, trusted receipt and the outer Pi Tool
apply the same budget. Oversized values/errors become explicit bounded Tool
errors, not truncated success or automatic effect retries (ADR-0196).

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
Revocation also aborts incomplete request uploads. After body validation, the
Gateway atomically rechecks its local capability and reserves the request count
before contacting the provider. This adds no database query. Usage remains in
native Pi history; dormant billing tables and monetary budgets are removed.
Provider/model/reasoning/Fast settings are immutable per accepted Turn. Hosted
search stays provider-native; verified GPT/DeepSeek actions and citations are
stored in native assistant messages, with portable replay across providers.
The selectable DeepSeek model is V4.1 Flash; V4 Pro is hidden. Flash declares
`web_search` on Responses at the owner's request, although the upstream currently
ignores it. Search activity still requires actual provider events/results;
a declaration alone is never recorded as a performed search (ADR-0191).
Chat uploads place files in Workspace through the existing Broker/Volume Gateway
or fixed machine guest helper. PG stores bounded upload claims and accepted input
references. Source images are retained in the existing S3 store; the current Run's
Cube normalizes them before model admission. Pi receives ordinary user text and
ImageContent without an Agent read Tool call. Queue edits, steer and native replay
retain images independently of mutable Workspace files. See
[chat attachment contracts](CHAT_ATTACHMENTS.md) and ADR-0200. Generated-image
results remain outside the public feature boundary.

CloudAgentRuntime owns bounded sampling retries; Model Gateway forwards one
send per admitted request. Generated CLIProxyAPI settings disable extra retry
rounds while keeping its account selection/failover responsibility. Logical
model-request limits do not claim to count every provider-account attempt.
Successful Assistant responses reset sampling retry state before further queued
input is processed. Run-local cancellation interrupts backoff without revoking
the shared Session authority. Compaction threshold checks ignore usage retained
from before the latest Compaction and use Pi's structural estimate until a new
valid usage-bearing Entry follows that boundary (ADR-0193).

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

GitLab's managed Issue comment is an eventually consistent view of PG claim/job
state. Atomic database triggers advance one `gitlab_issue_note_sync` target per
job when displayed state changes. A separate Control Plane loop claims only that
sync row in a short transaction, reads the committed latest state, then releases
the transaction before loading credentials or calling GitLab. Two local requests
are allowed in flight, independently of Issue-to-Run execution. A 60-second
PG-time lease/token fences local acknowledgements; the whole HTTP attempt is
bounded to 30 seconds and shutdown aborts it. Success acknowledges only the
captured version, so newer changes remain pending.

Sync rows contain identities/versions and bounded retry metadata, never comment
bodies or credentials. Lost replies are reconciled by note ID or the bounded
marker search. Transient failures back off per job from 2 to 60 seconds; persistent
failures retain a safe code and become due again after 15 minutes. Equal
desired/synced versions become eligible for verification after five minutes,
subject to backlog and the concurrency limit, so late older writes can be
repaired. GitLab does not enforce our local token: duplicates after ambiguous
creates and temporary remote regression remain possible. The database business
state stays authoritative. No Agent scheduler, Kafka event or new service is
added; see [ADR-0190](adr/0190-gitlab-issue-note-convergence.md).

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
Proved pre-enqueue validation/capacity rejection restores the affected Lane view
without consuming native sequence or poisoning siblings. Lost ACK or failed
post-ACK apply still retires the whole writer. Cold readers share one monotonic
progress read, retaining independent cancellation and current-owner checks.
The PG budgets cover native/seal transactions, not pool acquisition, every API
query or external routing; a persistently failing record still blocks its partition.

Executor admission and log seals do not atomically revoke a request already
sent to Cube or kill guest processes. The Cube-native launch-generation contract
remains unimplemented; existing no-replay/UNKNOWN tests do not prove physical
execution fencing. PG failover, Cube node drain and full multi-node HA remain
separate deployment acceptance work. The isolated duplicate SSE opening remains
unexplained; reproducing intentional stale-snapshot cancellation is not its fix.
