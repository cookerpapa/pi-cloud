# Architecture

Pi Managed Agents hosts Pi Durable 1.0 in trusted Workers and runs untrusted file/shell
operations in separate CubeSandbox KVM guests. The Control Plane never hosts
the Pi Harness. Conversations and retained attachments outlive a particular Worker
or Workspace; Workspace files belong to persistent Cube Volumes.

This document describes the current runtime, not its release chronology.
[ADRs](adr/README.md) explain decisions, [delivery reports](reports/README.md)
record evidence at named revisions, and [BACKLOG](BACKLOG.md) lists unresolved
limits. Historical migrations and reports are not alternate production modes.

## One message

```text
Browser -> Session API -> PG Run admission -> Pi Worker
Pi Worker <-> local Model Gateway <-> CLIProxyAPI <-> model provider

Pi Worker -> transactional Session producer -> Kafka -> Session Projector
                                                        +-> PG native state/history
                                                        +-> live view / browser SSE
                                                        +-> independent ordinary Tool host (HTTP)
                                                        `-> Cube execution endpoint
Guest -> HTTPS completion -> original Kafka reply destination -> authorized Pi Harness
Control Tool completion -> Kafka replies -> authorized Pi Harness

PG control mutation + Outbox -> same Session Kafka partition -> Projector
Workspace bytes -> persistent Cube Volume
Retained attachment originals -> private S3 objects; Kafka and PG carry references
```

1. The API admits an idempotent root Run in PG, freezing the conversation's model
   capabilities, Workspace and execution grants. A commit-time notification hints
   that work is available; polling covers missed hints.
2. An available Worker claims work in a short PG transaction. One physical Pi
   Session receives one renewable execution lease, one writer and one family slot.
   Native child Conversations share that ownership.
3. The Worker opens the pinned Harness using bounded cold storage reads, restores
   active native work and calls the model through its local Gateway. Pure chat
   does not activate a VM.
4. Pi commits through the public Storage port. The Worker stamps one ordered
   batch, publishes directly with its Session transactional producer and waits
   for Kafka acknowledgement before Pi adopts the committed state.
5. One Session Projector group materializes native state, updates live views and
   routes committed Tool intent. It confirms dispatch admission durably before
   issuing an external-effect command.
6. The Guest posts its finalized result to a scoped HTTPS endpoint, which packs
   image references and publishes to the original Kafka reply destination. A new
   authorized Worker can resume that original wait. Pi processing still produces
   the canonical Tool Result through the normal Session commit path.
7. Native family settlement leads to ordered completion and retirement of the
   idle owner. Forced replacement first closes the old writer; recovery uses a
   newly authorized Session lease, with no RunAttempt or automatic unsafe replay.

`session-api` owns authentication, admission/read APIs and browser connections.
It has no Session consumer, Worker membership or allocator. It authorizes and
relays a private live stream assembled by the single execution owner with the
existing PG/history coverage rules. Browser credentials never cross that port.
`session-runtime` owns Worker membership/control, HTTP observations, the Session
Projector and execution-side maintenance. `control-plane` owns resource admission,
recovery and lifecycle policy; it has no Session consumer or ordinary dispatcher.
`tool-completion` receives bounded HTTPS callbacks and publishes replies; it
cannot start commands or authorize physical cleanup. See [ADR-0306](adr/0306-runtime-decoupling-and-continuation.md).

With PG, Kafka, the Worker and its existing Cube binding available, stopping
management leaves commits, projection, bound Tools and reads running. Workflow
host calls and image/Skill/preview data access use recorded physical data channels
at the Session partition owner. They do not adopt resource ownership. New VM
activation, pause/release and physical recovery require management. The API can
persist new Run/configuration intent while that work waits; admission is not a
promise that execution resources exist. There is no independent Broker, Worker
append HTTP ingress or second canonical/live/Tool group.
See [RUN_LIFECYCLE](RUN_LIFECYCLE.md).

## Durable input and scheduling

The human intake endpoint accepts a `whenBusy` preference. PG/native receipts,
not a browser-selected old Turn, decide whether it becomes native steer/follow-up
or a new root Run. Immediate sending feedback is local; successful submission
still waits for durable acknowledgement. Initial input stays in the transcript,
including before Worker claim; only native steer/follow-up appears in the composer
queue. Initial edit/withdraw and native queue controls share one controller and
retain server revision checks. See [ADR-0290](adr/0290-human-input-boundary-and-feedback.md).

PG owns root Run admission, execution ownership and resource intent. A Run covers
the root native input and its child Conversations; children are not independent
cloud queue rows or leases. Queue rows carry bounded command references, not
transcripts, image bytes or Workspace archives.

Steer and follow-up belong to the current native Conversation. The API routes
edits, cancellation, reordering and promotion to its current Worker. Pi's detached
transaction commits the Inbox and input metadata before the request is acknowledged.
An unreachable Worker leaves the message as a retryable draft. Consumption adds
the actual user Entry in the same native transaction as queue removal.

Stop aborts the native Conversation. Unconsumed queued inputs return to the
composer for editing; they do not silently become new Runs. Accepted input,
displayed text and an HTTP request's success are distinct facts.

Scheduled plans are authoritative PG current values. A due occurrence admits one
ordinary Run when the conversation is idle. One nearest-deadline timer, PG hints
and a fallback scan wake the existing admission logic; there is no second workflow
scheduler. Manual plan deletion changes PG; a plan changed by a Tool also retains
that Tool's normal native history. See [SCHEDULES](SCHEDULES.md).

`/usage` reads committed usage and context estimates without allocating a Worker
or VM. `/compact` creates Pi's exported CompactionTask with an idempotent receipt.
It uses the current Run when active and a maintenance Run through existing admission
when cold. It does not fabricate a chat message or start a sandbox.
See [ADR-0243](adr/0243-native-input-current-state.md) and
[ADR-0277](adr/0277-model-event-waiting-and-conversation-commands.md).

## Publication and execution log

The physical Session ID determines the Kafka key/partition. One stable
transactional producer identity fences replaced Session writers. PG authorization
is checked before and after producer initialization, not on each ordinary commit.
A delayed stale initializer fails its post-initialization check; an affected valid
writer recovers only through ordered closure. An uncertain producer is never
automatically reinitialized to retry arbitrary effects.

Control changes commit PG state plus immutable Outbox references and use the same
Session partition. Binding close consumption acknowledges stopped dispatch in
the Outbox before management can perform physical retirement. PG admission gates
also prevent late binding registration. Projector
membership and the partition publication queue retain their transaction guards.

Native sequence preserves batch/write identity and replay validation; Kafka
positions describe transport order. Native Entry IDs can be reserved before commit
and are not interchangeable with commit positions. All are allocated by their
existing authority, never by a second active Session writer.

Incomplete local Tool calls remain in Worker memory until a complete successful
model response. The public Models adapter enforces this before native Storage
commit. Committed batches are not stripped or rewritten to hide partial calls.

A definite pre-enqueue publication rejection can restore the affected Lane's
draft without consuming sequence. Lost acknowledgement or failed adoption after
acknowledgement retires the whole Session writer. Kafka acknowledgement, PG
projection and native result settlement are separate boundaries.
See [ADR-0247](adr/0247-session-work-and-tool-dispatch.md) and
[STREAM_DURABILITY](STREAM_DURABILITY.md).

## Logical tool environments and resource closure

`GET /v1/conversations/:sessionId/environment` is a tenant-scoped, bounded resource
read. It returns Workspace/directory, stable development-machine selection and the
current writer's immutable Tool binding/allocation, or `binding: null`. Open/closed
means routing admission; neither it nor an absent binding diagnoses VM health or
checks whether a directory still exists. No provider endpoint or credential is
exposed. Physical observations remain disposable and separate from this read.

The Worker uses public Pi Tool hooks to prepare a reply waiter and an immutable
logical environment (Workspace, compute scope, requested binding ID and execution
identity). Native intent and dispatch share one Session commit. The execution
partition owner prepares an absent binding through the resource management API,
outside the Kafka consumer callback. The callback remains free to consume its
later binding change, cancellation or writer closure. Already-bound routing uses
memory; ordinary tool resource calls carry the frozen assignment, not another
binding SQL lookup. Whole-tool provider submit/cancel and failure classification
are behind `SandboxToolExecutor`.

On writer retirement, `session_leases.tool_bindings_closed_at` permanently closes
new binding registration for that incarnation, in the same PG transaction as its
existing binding closures. A delayed VM creation must recheck that gate and physical
allocation admission before registering. Each binding remains tied to one physical
allocation; a rejected late registration never redirects the original Tool.

Physical retirement first closes PG resource/binding admission and publishes the
existing Outbox change. The Session owner consumes it, closes its memory view,
retires pending dispatch and acknowledges `outbox.applied_at`. Management waits for
that acknowledgement before calling Cube. The ACK proves stopped routing admission,
not process exit; quota still requires verified physical absence. If Projector or
Kafka is unavailable, resource retirement stays pending. At native work_finished
or seal, the consumer closes its own view and the PG writer gate directly, without
waiting for a later message on its own partition. Reassignment bootstraps closed
PG state before admitting effects. No per-tool operation ledger is added.

Input-image preparation uses an execution-side logical-resource endpoint. It
shares the coordinator and returns observed continuity; the Worker never creates
or releases a VM. Images, fixed-tool replies and ordinary tool replies update
WorldState only at the next clean native sampling boundary.

## Unified projection and recovery

Each assigned partition has one ordered Projector handler and rebuildable memory
views. Committed bindings and capability changes populate those views, allowing
ordinary Tool/probe routing to avoid a per-Tool PG lease or binding query. Bootstrap,
lifecycle admission and control publication still use PG.

Projection transactions have PG lock/statement budgets and a dedicated bounded
connection pool. Failure rolls back and retries in partition order without advancing
the offset or dispatching the Tool. Reassignment reconstructs required live/control
state; replay for presentation never reissues committed external effects.

Worker cold reads and lease/control publication have separate bounded pools.
A stalled Session can still block another Session on the same Kafka partition;
other partition handlers can proceed. This is an explicit tradeoff.

Workers renew Session leases directly in PG, independently of registration and
resource management. Cold admission reads PG; active local authority advances
only from committed renewal acknowledgements, with no parallel periodic SELECT.
An independent monotonic deadline and synchronous model-admission check prevent
late timers or acknowledgements from extending an expired owner. Silent PG
revocation is learned at the next renewal, normally twenty seconds; a stalled
renewal cannot exceed the last confirmed lifetime, normally sixty seconds.
Known Kafka publication failure immediately aborts the whole native family and
its model transports. An unobserved broker fence is discovered by subsequent
publication. ADR-0307 adds a bounded Session resource-use declaration about once
per minute through that same writer, including silent model waits. Execution
uses its resource view without polling Worker ownership or PG leases. Full probes
are on-demand and register the caller waiter before Kafka publication. Already accepted provider
requests may still finish or bill. See [ADR-0303](adr/0303-direct-renewal-and-local-execution-authority.md).

After Worker loss, PG authorizes closure, the old writer is sealed through Kafka,
and Projector confirms native closure before a replacement becomes eligible.
The new Harness restores native Tasks, Inbox and the active context suffix.
Unsafe interrupted effects become uncertain outcomes, not repeated Bash commands. Environment
recovery selects a fresh logical binding address when the previous one may already
have been closed and removed. Retries retain that new address; original accepted
operations keep their own target, reply topic and deadline. This cannot reopen an
old binding or redispatch a Tool.

Worker-local duplicate execution and cancellation outcomes are scoped to the
existing ExecutionReference. The same Run may resume on the same still-running
Worker under a new authorized lease. Older requests remain fenced before cache
lookup; late cleanup only touches its original execution. Settled superseded
incarnations can be reaped while the logical Run continues, retaining its current
family epoch. See the recovery mapping in [ADR-0229](adr/0229-native-durable-runtime.md).

Reply destinations keep their original boot name. Pending fixed-Tool Tasks retain
small transport references in native commit metadata and current indexes: topic,
replay floor, immutable operation and original deadline. A replacement restores
waiters before reading the old suffix and following its live tail with an independent
consumer identity. It never executes the command again. Kafka/attachment retention
follows native settlement, not receipt into Worker memory or the old boot's exit.
Explicit Stop can cancel an adopted operation using its original physical target.
Ordinary control operations retain their own native recovery policies; direct
subagent creation still locates its original receipt and child. No raw-result PG
ledger or second child scheduler is introduced.

A physical result records its environment identity in a small current-only native
document before returning to Pi. An authoritative binding withdrawal also notifies
the current Worker through the existing reply transport. After handoff or a known
execution failure, the same Run can wait for verified environment/reply readiness.
A reset entry and recovery-gate settlement commit together before the next Agent
model request. A stale readiness result cannot clear a newer withdrawal. Pure chat
does not create a VM; compaction does not wait for the sandbox; model-request permits
are not held during environment recovery.

## Browser view

The browser combines paged canonical history with snapshot-first SSE. Native
commit coverage prevents a complete PG message and its earlier live fragments
from being rendered twice. Text/Tool display descriptions reference the native
commit's content rather than publishing another transcript body.

History is windowed within long Runs as well as between Runs. Native-position
cursors, virtual rows, bounded client residency, direct navigation, cancellable
search and streamed export keep a large conversation from becoming one browser
allocation. Live-tail intent and measured row geometry survive window changes.
Manual disclosure, upward gestures and native text selection suspend end following.
Selection pins only the selected rows/lines in the current bounded window and
pauses history pagination and text animation. Known Tool results may settle in
place when no selection is active. Returning to live displays buffered text at
once. These are browser reading policies, not execution or history mutations.
Normal history paging is automatic at the reading edge. A failed page offers a
retry of that same query; a speculative later-page flag is not a user notification.
Copies on settled answer fragments and final footers share the answer action style.
Execution terminal state remains current during historical reading and selection,
including after an SSE snapshot reconnect. A frozen streaming fragment keeps its
rendering identity and does not gain a complete-answer copy action until canonical
content replaces it.
See [ADR-0278](adr/0278-windowed-conversation-presentation.md).

Model phase observations, child progress and running Tool previews are disposable.
They use HTTP/SSE, not Kafka, PG or model context. Tool previews carry bounded
revision-based edits and periodic resets; the guest interprets terminal output
before producing the view. Completion replaces the preview with the canonical
result and wins over late updates. Missing previews never prove execution failure.

Tool grouping is a display preference. Image presentation comes from canonical
attachment parts. Preview navigation uses the Agent's named answer link; the Web
does not parse answers to invent missing links or add a second application card.

## Native Pi state and Harness

Pi owns Conversations, Tasks, Submissions, Inbox, model retries, compaction and
native cancellation. Its public Storage, Models and tool/extension ports connect
those semantics to cloud infrastructure. No Agent loop is patched, and only
code-owned trusted extensions run in the Worker.

The active owner keeps acknowledged state in memory. PG materializes:

- immutable semantic history and indexed shared bodies;
- authoritative latest Inbox, input metadata and Submission values;
- native document metadata/checkpoints needed for cold reads;
- live-state checkpoints at settlement or ordered writer handoff.

Streaming `pi.live` deltas stay in Kafka, not as repeated PG text histories.
Protected replay references retain the suffix needed after a Projector restart or
writer handoff. Rebuilding views does not allocate sequence, dispatch Tools or
create a second execution authority. Native batch atomicity is retained.
See [ADR-0243](adr/0243-native-input-current-state.md),
[ADR-0244](adr/0244-kafka-backed-native-live-state.md) and
[ADR-0245](adr/0245-native-commit-text-presentation.md).

Cold open loads the latest applicable Compaction and active suffix, plus state
for active native Tasks. It does not replay lifetime JSONL or all historical
subagents. Image references reconstruct native image content with tenant,
metadata and integrity checks.

Manual Fork captures only the selected Conversation path. Shared immutable native
and presentation roots preserve that point's commit visibility and document
selection; later commits, old child runtimes and pending inputs are not inherited.
A Fork has its own future writes and is a peer conversation with source provenance.
Source pruning/deletion preserves independent Forks, retained images and live
references. Collection removes bodies only after their final retained reference.
Forks inherit the Workspace/directory/machine binding; they do not copy files.
No automatic fork-identity instruction is added to model context.
See [ADR-0287](adr/0287-single-path-shared-forks.md) and
[ADR-0288](adr/0288-peer-forks-and-independent-deletion.md).

Cancelled visible assistant wording is retained through Pi's public context-only
edits, with an interruption marker. The original aborted Entry and usage remain;
reasoning, unfinished Tool structures and provider replay signatures are not
promoted. Cold and active context preparation use the same rule.
See [ADR-0283](adr/0283-interrupted-assistant-text-context.md).

## Tools and Cube

Whole fixed file/shell Tools execute in Cube. The guest has the fixed Tool code,
not a Harness, extension loader, model credentials or PG/Kafka credentials.
The fixed Guest launcher submits the bounded result over HTTPS. An independent
trusted completion service externalizes images and publishes replies after
validating its scoped capability. Cubelet contains no Kafka/PG/S3 completion client.
Only the Worker's Pi processing makes a result canonical.
Worker inventory retirement revokes routing without cancelling accepted Guest
work. A reachable old management endpoint has the same continuation semantics as
an unreachable one; explicit chat Stop retains its ordered cancellation path.

The Control Plane lazily prepares an immutable binding to an authorized VM/node/
boot and working directory. Projector checks its ordered view, confirms its
monotonic dispatch commit, then submits to Cube. It waits for bounded acceptance,
not the full Bash duration. The fixed Guest service fences boot/position/operation
identity without querying PG on each Tool. The adapter invokes its small control
client through ordinary envd process/stdin APIs; accepted operations outlive that
connection and the service process. Guest SQLite retains only position boundaries
and outstanding operation metadata, not final results. See [ADR-0307](adr/0307-guest-execution-and-session-activity.md).

The provider boundary is divided by responsibility:

| Port | Responsibility |
| --- | --- |
| `SandboxLifecycle` | Allocation, observation, adoption, pause/resume and confirmed cleanup |
| `SandboxExecution` | Execution identity, attachment description and readiness probes |
| `SandboxWorkspaceFiles` | Current Workspace reads, directory operations and streaming uploads |
| `SandboxImages` | Bound image normalization and placement |
| `SandboxTerminals` | Human-operated PTY transport |
| `SandboxPreviews` | Service discovery and application connections |
| `SandboxWorkflows` | Fixed guest workflow transport |
| `SandboxSourceCredentials` | Workspace-scoped Git credential operations |

`SandboxProvider` composes these ports at construction. Management receives lifecycle
consumers. Session execution receives only existing-binding data consumers and
direct native Tool/retention transport. Encrypted immutable data capsules stay in
private PG binding metadata and disposable provider caches; they are never a new
allocation journal, VM owner or native history body.
`WorkspaceFileAccess` receives only file operations and callbacks to the existing
owner's admission checks. It cannot allocate or destroy VMs through its interface.
These are code-dependency boundaries, not separate security principals. Optional
capabilities retain explicit unsupported errors, not silent runtime fallbacks.

The management controller retains resource ownership and closure coordination. Native SDK
objects and management credentials do not cross to Workers. Source-side bounded
reads, output truncation, image normalization and attachment handling remain in
their existing locations. See [CUBESANDBOX_PROVIDER](CUBESANDBOX_PROVIDER.md).

Permanently lost controller ownership withdraws management readiness and retires
that process within a bounded cleanup window. Session-runtime readiness is independent. Kubernetes restarts it and existing
PG ownership recovery applies. Transient renewal errors before the confirmed
deadline remain retryable; an expired local owner cannot revive itself. This
failure never constitutes physical VM absence or permission to delete a Volume.

Chat Stop requests native abort at the Worker and co-commits operation cancellation
on the Session log. Projector delivers cancellation to the Guest, which signals the
unfinished Tool's process group. It does not retroactively terminate completed
background launches or destroy the VM. Native abort settles independently of late
physical replies; no cancellation acknowledgement proves process exit.

A lost reply can mean the external effect happened. UNKNOWN does not authorize
automatic replay or VM deletion. Health probes provide disposable evidence; only
the lifecycle owner, with the required recorded-node evidence, can retire compute
or release quota. Arbitrary shell effects have no exactly-once guarantee.

## Workspaces and development machines

The persistent Cube Volume is the sole Workspace byte authority. There is no
per-Run archive head, platform-managed Git tree or second filesystem synchronized
with PG. Uploads stream through the Volume Gateway or fixed machine helper with
existing authorization, staging locks and atomic publication. Reads do not create
Volumes or prove safe deletion.

Ordinary elastic Sessions can share a Workspace's compute scope, files, ports and
processes. Subagents may use separate temporary Linux compute on the same Volume.
Human terminals have independent product authority. Pure chat creates no VM.

The native provider owns elastic idle expiry, renewed from fresh Session activity on
the existing Kafka path. Stale replay uses its original timestamp and cannot buy
extra time. A missing VM is never created by maintenance. After renewal stops,
expiry may reclaim compute even with an unfinished Tool; healthy Session families
can renew indefinitely. The Control Plane has no competing idle deadline scanner.
Dedicated machines do not expire. Diagnostic heartbeats are not retention intents,
PG lease renewals or proof that a VM has disappeared.
See [ADR-0309](adr/0309-stock-sandbox-contract.md).
Management health samples native resource status without Guest traffic; execution
uses on-demand full probes. Stock CubeProxy traffic can affect native idle timing.

PG stores a dedicated machine's stable identity, desired running/paused/released
intent and lifecycle completion. Cube supplies disposable physical observations.
Recovery respects deliberate pause and replaces an allocation only after old
physical absence is confirmed. A lost API reply or unreachable node does not
justify replacement. Direct lifecycle management uses the Cube API; Session
binding changes still travel through Kafka.
See [ADR-0273](adr/0273-resource-intent-and-machine-recovery.md).

Volume deletion closes attachment admission and requires the supported Volume
Plugin to release its exact persisted attachment receipts. Missing/late replies,
unknown holders or a missing Master route do not prove storage is unused. Workspace bytes survive compute replacement;
process memory and system-disk changes are not promised to survive cold recovery.
Machine Release deletes its Workspace, while conversation history has its own lifetime.

Rebinding after resource deletion is allowed only while no Run is active and
freezes the new Workspace/machine/directory together. The next model context
describes an actual environment change. Forking a conversation preserves its
Workspace binding but does not snapshot or roll back that environment.

Application Preview checks a listening service and returns an authenticated
platform URL. Each request resolves current authorization and owner; HTTP and
WebSocket traffic pass through the existing relay. Port numbers are guest ports.
Terminal and SSH entry points remain separate from Agent Tool authority.

## Models, Subagents and integrations

Workers call native Pi Models through their local Model Gateway. CLIProxyAPI owns
provider credentials/account selection and upstream transport. Run admission
freezes the validated model catalog capabilities; discovery alone does not publish
a selectable model. The native Harness owns semantic retry.

The maintained provider adapter targets CLIProxyAPI v8. Its native compatibility
extension preserves Responses messages and hosted-tool events; operator
configuration and management use the v8 layout. One-time conversion and provider
publication are specified by [ADR-0296](adr/0296-provider-v8-and-model-accounting-boundary.md).
[ADR-0297](adr/0297-model-metering-receipts-and-statements.md) adds a provider-local
receipt buffer before asynchronous usage callbacks. Worker/model and image callers
supply per-invocation ownership; provider execution IDs distinguish attempts.
Authenticated receipt batches commit to PG independently of native Session leases,
Projector and chat history. PG owns deduplicated usage, immutable rate versions and
simulated amounts. Model/Tool retry authority stays with the existing runtime.
Missing receipts remain unconfirmed; unsupported tariffs remain unpriced. Neither
payments nor Sandbox billing is enabled; see [Model billing](MODEL_BILLING.md).

Under [ADR-0289](adr/0289-provider-owned-model-continuation.md), HTTP/SSE carries the
full effective context inside the cluster. The provider adapter reuses a compatible
upstream connection/response across Run and Worker changes and transmits only the
new suffix. Cache expiry, provider restart or changed context can require a full
request. Cache state is disposable and never restores missing semantic history.

Cancellation revokes active model access. Completed idle transport retains no
Run authorization. A pre-output WebSocket failure can fall back once to HTTP;
post-output retry belongs to Pi. Bounded short-term HTTP preference avoids
repeated failed WebSocket uploads. Transport and decoded-size budgets are distinct
from context-token compaction and physical memory capacity.

Ordinary Control Tool definitions and handlers have one execution-side registry.
The independent `tool-host` process publishes complete credential-free snapshots
to `pi-cloud.tool-catalog.v1` (compacted, one partition, RF=3). Each Worker has its
own boot consumer group and restores the PG-selected generation before claiming
work. Generation and digest checks reject stale/conflicting updates; Kafka fences
old catalog publishers. Deployment activation, not process startup, selects a new
release. Pi applies changed definitions to later model requests in the same loop.
The management WebSocket no longer sends a second catalog. Ordinary Tool RPCs
fix the selected implementation release and do not retry uncertain effects.
Fixed guest Tools retain the matched protocol. See
[ADR-0305](adr/0305-execution-owned-tools-and-bindings.md).

Worker Tool availability and Skill requirements use the same effective-capability
resolver, including child grants, depth, roles and accepted device targets.
Availability is independent of the prompt policy controlling proactive delegation.

Subagents are native child Conversations in the same Session family. Their identity
and creation receipt survive parent interruption. Direct delegation recovers that
receipt; management and arbitrary workflow scripts are unsafe for automatic replay.
Workspace selection, context inheritance and working directory are separate choices.
Ultra enables proactive delegation. Model permits are local and fair and are not
held while waiting on another Agent or Tool. See [SUBAGENTS](SUBAGENTS.md).

Long text pastes become editable browser file drafts. Conversation attachments retain
immutable originals in the existing S3/PG reference authority; Workspace files are
mutable working copies. Upload confirmation requires original and placement
completion, while input confirmation retains PG/Pi's existing admission boundary.
History/Fork references preserve originals independently of Workspace deletion.
Edited queue attachments and promotion to steer co-commit through Pi; reuse shares
an original and creates a new Workspace placement. See
[ADR-0294](adr/0294-retained-user-attachments.md).

Explicit Workspace-only uploads from the composer/file panel use tus continuation
over existing file ports ([ADR-0295](adr/0295-workspace-file-transfers.md)). PG
retains bounded transfer grants; the actual receiver owns byte offset, staging and
publication. These files have no S3 original or native attachment reference.
Browser drafts persist before sending; reconnect queries progress and existing
input receipts without automatically resubmitting. Only completed files are
described to the model. Historical paths are not implicitly restored after
Workspace changes. See [working-file uploads](WORKSPACE_UPLOADS.md).

User image uploads enter Pi as visual content directly. Retained originals and
canonical Tool images use private S3 objects, independent of mutable Workspace
paths. `generate_image` and `show_image` use ordinary Tool dispatch and existing
bound image I/O; the Worker still owns canonical settlement. See
[CHAT_ATTACHMENTS](CHAT_ATTACHMENTS.md).

Optional GitLab Issue intake uses ordinary Run admission; Issue-note synchronization
is a bounded integration loop, not another Agent scheduler. Environment-local Git
credentials and trusted integration credentials retain their separate ownership.
The retained Android execution-target prototype has an operator API but no Web
picker or automatic device pool; it is not a fallback for Cube coding execution.
See [OPTIONAL_MODULES](OPTIONAL_MODULES.md) and [ANDROID_EXECUTION](ANDROID_EXECUTION.md).

The organization-only [Skill market](SKILLS.md) stores immutable packages in S3,
installations and frozen Run selections in PG. At Run bootstrap, installed metadata
reaches Pi's public system section; instructions are read on demand. `read_skill`
automatically prepares execution resources through the existing Workspace binding;
pure instructions and textual references need no VM. Ordinary Sandbox Tools run
scripts. `publish_skill` exports a Workspace directory through the fixed guest
file transport, while `inspect_skill` resolves publication uncertainty from the
existing catalog. The Web creates an editable Agent request or imports local files.
Neither Tool loads user extensions into the Worker. Automatic project scanning,
mid-Run catalog reload and executable user extensions remain outside this slice.
See [ADR-0293](adr/0293-cloud-skill-runtime.md).

Worker preparation measurements use the existing stdout operational logger.
Public Harness/Models/Storage boundaries provide stage timings and aggregate
read/image counts. They do not enter native history, add reads for measurement,
or change cancellation/admission. See [OBSERVABILITY](OBSERVABILITY.md#worker-startup-and-request-preparation).

## Authorities and scaling

| Concern | Authority |
| --- | --- |
| Accounts, configuration, Runs, leases and resource intent | PostgreSQL |
| Native continuation, Inbox consumption, model retry and abort settlement | Pi Harness |
| Active Session publication | PG-authorized owner + transactional Kafka producer |
| Ordered acknowledged commits and retained live suffix | Kafka |
| Long-term native state, semantic history and query indexes | PostgreSQL materialization |
| Live views and routing observations | Rebuildable Worker/Projector memory |
| Workspace files and physical Volume references | Cube persistent Volume / node evidence |
| Guest processes and elastic idle expiry | Cubelet and the guest |
| Provider credentials, account selection and upstream continuation | CLIProxyAPI |
| Retained conversation attachments | Private S3 objects with PG/native references |

Worker replicas add Session-family slots; Projector replicas divide Kafka
partitions; Cube nodes add execution capacity. Cold Sessions do not require
dedicated processes or OS threads. Independent authorities are not duplicated by
an extra Actor framework, cache, scheduler or per-Step projection receipt.

## Intentional coupling and unverified boundaries

- API and Projector are separate processes, but live SSE still needs the execution
  owner. A persistently failing record blocks its Kafka partition. Physical
  Session Lanes share one Worker and writer.
- Cold history waits for the necessary PG projection. Native live recovery also
  requires its protected Kafka suffix.
- Cube acceptance is not durable cross-boot process/result recovery. Missing
  physical evidence remains unresolved rather than being converted to success.
- The current single-host K3s deployment is not node-level HA. PG failover,
  independent Cube-node loss, multi-node Volume handling and fleet-scale capacity
  remain acceptance work.
- Very large cold visual-context uploads can still fail on the upstream network.
  Ordinary cross-Worker delta continuation does not prove that case.
- Shared-history Fork performance has measured read/write/collection tradeoffs;
  single-host timings are not fleet SLAs.

See [BACKLOG](BACKLOG.md), [EVALUATION](EVALUATION.md) and
[ASSET_RECOVERY](ASSET_RECOVERY.md) for open work and the scope of verified recovery.
Conversation deletion removes its owned family after quiescence; independent
Forks, referenced images and Workspace resources retain their own lifetimes.

## Self-hosted deployment boundary

All runtime services use K3s and stable Kubernetes Services. Docker is a build and
test dependency. PostgreSQL/Kafka/S3/provider infrastructure starts before platform
migration and application rollout. Native Cube/guest and application contracts
remain pinned.

[Scoped releases](COMPONENT_RELEASE.md) handle supported independent components.
Other runtime changes use the [matched release](MATCHED_RELEASE.md): build and
scan immutable artifacts, drain writers, confirm physical cleanup where required,
then verify native recovery and relevant real Luna/Cube behavior. Accounts,
configuration, credentials and retained Workspace assets are preserved.

## Independent usage accounting

Provider model receipts and enforced Workspace capacity intervals reach the
independent receiver directly. Stock Cube inventory and native lifecycle events
are observations, not a continuous physical accounting journal. A bounded native
resource mapping is recorded with creation; the independent collector atomically
commits observation pages and cursors in PG. Sampled compute intervals remain
unconfirmed and unpriced under ADR-0309. Model and Workspace storage retain their
existing pricing evidence. Accounting never acquires resource lifecycle authority.
See [resource accounting](RESOURCE_BILLING.md) and
[Workspace capacity](adr/0301-workspace-capacity-enforcement.md).

Workspace bytes stay in persistent Cube Volumes. PG capacity/revision/pending
fields represent requested grow-only policy; the storage helper acknowledges
kernel enforcement. Ordinary Bash/file writes consult neither PG nor another
quota service. The VM's disposable system disk is not the Workspace capacity.
