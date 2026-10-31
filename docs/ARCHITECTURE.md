# Architecture

PiCloud hosts Pi Durable 1.0 in trusted Workers and runs untrusted file/shell
operations in separate CubeSandbox KVM guests. The Control Plane never hosts
the Pi Harness. Conversations and retained images outlive a particular Worker
or Workspace; Workspace files belong to persistent Cube Volumes.

This document describes the current runtime, not its release chronology.
[ADRs](adr/README.md) explain decisions, [delivery reports](reports/README.md)
record evidence at named revisions, and [BACKLOG](BACKLOG.md) lists unresolved
limits. Historical migrations and reports are not alternate production modes.

## One message

```text
Browser -> Control Plane -> PG Run admission -> Pi Worker
Pi Worker <-> local Model Gateway <-> CLIProxyAPI <-> model provider

Pi Worker -> transactional Session producer -> Kafka -> Session Projector
                                                        +-> PG native state/history
                                                        +-> live view / browser SSE
                                                        +-> Control Tool handlers
                                                        `-> Cube execution endpoint
Cube / Control Tool completion -> Worker-boot Kafka replies -> original Pi Harness

PG control mutation + Outbox -> same Session Kafka partition -> Projector
Workspace bytes -> persistent Cube Volume
Retained images -> private S3 objects; Kafka and PG carry references
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
6. The executor returns to the original Worker boot. Pi's result processing
   produces the canonical Tool Result, which follows the same Session commit path.
7. Native family settlement leads to ordered completion and retirement of the
   idle owner. Forced replacement first closes the old writer; recovery uses a
   newly authorized Session lease, with no RunAttempt or automatic unsafe replay.

The API, Projector and sandbox lifecycle controller share one Control Plane
process. There is no independent Broker, Worker append HTTP ingress or second
canonical/live/Tool consumer group. See [RUN_LIFECYCLE](RUN_LIFECYCLE.md).

## Durable input and scheduling

The human intake endpoint accepts a `whenBusy` preference. PG/native receipts,
not a browser-selected old Turn, decide whether it becomes native steer/follow-up
or a new root Run. Immediate composer feedback is local; successful submission
still waits for durable acknowledgement. See [ADR-0290](adr/0290-human-input-boundary-and-feedback.md).

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
Session partition. Binding revocation also closes local effect admission before
publication; a delayed Kafka close is not the sole revocation guard. Projector
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

After Worker loss, PG authorizes closure, the old writer is sealed through Kafka,
and Projector confirms native closure before a replacement becomes eligible.
The new Harness restores native Tasks, Inbox and the active context suffix.
Unsafe interrupted effects become uncertain outcomes, not repeated Bash commands.

Worker reply topics are boot-scoped, transient transport. A replacement Worker
starts its own mailbox rather than consuming old physical replies. Recoverable
control operations, such as direct subagent creation, locate their native receipt
and original child before delivering to the current owner. No raw-result cache,
per-Tool PG ledger or independent child scheduler is introduced.
See [ADR-0264](adr/0264-subagent-recovery-and-discovery.md).

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
The trusted Cubelet completion adapter externalizes images and publishes replies.
Only the Worker's Pi processing makes a result canonical.

The Control Plane lazily prepares an immutable binding to an authorized VM/node/
boot and working directory. Projector checks its ordered view, confirms its
monotonic dispatch commit, then submits to Cube. It waits for bounded acceptance,
not the full Bash duration. Cube independently fences boot/position/operation
identity without querying PG on each Tool.

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

`SandboxProvider` composes these ports at construction. One Cube implementation
can supply all of them; no additional process, RPC hop or durable state is created.
`WorkspaceFileAccess` receives only file operations and callbacks to the existing
owner's admission checks. It cannot allocate or destroy VMs through its interface.
These are code-dependency boundaries, not separate security principals. Optional
capabilities retain explicit unsupported errors, not silent runtime fallbacks.

The controller retains resource ownership and closure coordination. Native SDK
objects and management credentials do not cross to Workers. Source-side bounded
reads, output truncation, image normalization and attachment handling remain in
their existing locations. See [CUBESANDBOX_PROVIDER](CUBESANDBOX_PROVIDER.md).

Chat Stop requests native abort at the Worker and co-commits operation cancellation
on the Session log. Projector delivers cancellation to Cube, which signals the
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

Cubelet owns finite elastic idle expiry, renewed by typed keepalive intents on the
Session Kafka path. The Control Plane has no competing idle deadline scanner.
Dedicated machines do not expire. Diagnostic heartbeats are not retention intents,
PG lease renewals or proof that a VM has disappeared.
See [ADR-0272](adr/0272-cube-owned-elastic-retention.md).

PG stores a dedicated machine's stable identity, desired running/paused/released
intent and lifecycle completion. Cube supplies disposable physical observations.
Recovery respects deliberate pause and replaces an allocation only after old
physical absence is confirmed. A lost API reply or unreachable node does not
justify replacement. Direct lifecycle management uses the Cube API; Session
binding changes still travel through Kafka.
See [ADR-0273](adr/0273-resource-intent-and-machine-recovery.md).

Volume deletion closes new attachment admission and reconciles versioned node
references. Unknown holders, missing allocation replies or a missing Master route
are not proof that storage is unused. Workspace bytes survive compute replacement;
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
Credential-free snapshots reach Workers over existing management connections;
Pi applies changed definitions/selection to later requests in the same loop.
Fixed guest Tools retain the matched protocol. See
[ADR-0269](adr/0269-execution-owned-control-tool-catalog.md).

Subagents are native child Conversations in the same Session family. Their identity
and creation receipt survive parent interruption. Direct delegation recovers that
receipt; management and arbitrary workflow scripts are unsafe for automatic replay.
Workspace selection, context inheritance and working directory are separate choices.
Ultra enables proactive delegation. Model permits are local and fair and are not
held while waiting on another Agent or Tool. See [SUBAGENTS](SUBAGENTS.md).

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

The internal [Skill market](SKILLS.md) stores portable packages in S3 and catalog,
installation and per-Run version selections in PG. `read_skill` discovers and reads
installed instructions; it does not allocate a VM. `prepare_skill` copies files
through the current Workspace binding; ordinary Sandbox Tools run scripts.
Neither tool loads user extensions into the Worker. Automatic project-directory
scanning and executable user extensions remain outside this slice.

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
| Retained conversation images | Private S3 objects with PG/native references |

Worker replicas add Session-family slots; Projector replicas divide Kafka
partitions; Cube nodes add execution capacity. Cold Sessions do not require
dedicated processes or OS threads. Independent authorities are not duplicated by
an extra Actor framework, cache, scheduler or per-Step projection receipt.

## Intentional coupling and unverified boundaries

- API and Projector share a process. A persistently failing record blocks its
  Kafka partition. Physical Session Lanes share one Worker and writer.
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
