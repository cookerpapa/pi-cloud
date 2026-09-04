# Architecture

## Product boundary

Pi owns the Agent Loop, model messages, compaction and Tool selection.
PiCloud owns durable admission, multi-tenancy, Worker execution authority,
remote Tool routing, Workspace lifetime, streaming and recovery.

CubeSandbox KVM is the only untrusted execution runtime. PostgreSQL is the only
business/Run-state authority, Kafka is the bounded AcceptedFact log, CLIProxyAPI
is the model-supply authority, and there is no second workflow scheduler.

## Source-of-truth and terminology guardrail

This document describes the maintained production path. Historical migrations
must remain executable from an empty database, so their source files still
show when retired columns were introduced and later removed. Superseded ADRs
are kept only in Git history. Implementation logs, discussions and research are
background evidence and never reactivate a component in the current topology.

The current Worker invariant is deliberately precise:

- there is one shared PostgreSQL ready-Run queue;
- a cold physical Pi Session has no Worker affinity and may be acquired by any
  healthy Worker with a free conversation slot;
- while any Lane is active, all unexpired Attempts bound to that
  `(tenant_id, pi_session_id)` have one never-reused Worker boot identity;
- Run Claim briefly locks the shared `pi_sessions` row, so concurrent claims
  cannot elect two active owners;
- main and delegated Lanes may execute concurrently on the owning Worker, with
  separately bounded conversation and Child capacity;
- every Lane operation retains its own versioned `ExecutionLease`; active
  Session ownership is placement, not a second effect authority;
- after all Attempts expire or settle, a later Turn may restore the Session on
  another Worker from PostgreSQL.

## Components

### Web and Control Plane

The Web product provides authentication, resizable conversation/tree panels,
focused or whole-tree navigation, conversation forks, recursive subtree
deletion, settled-message tail pruning, named Workspaces, snapshot-first output,
file browsing, user-owned full-VM development environments, authenticated service
previews, one-time SSH access, Workspace rebinding and administrator settings. The Control Plane
commits each idempotent message and its Run in one PostgreSQL transaction. It
enforces durable-resource admission and same-Session
serialization. Different Sessions may intentionally share a Workspace without
becoming scheduler locks for one another.

### PostgreSQL Run queue

Ready `runs` rows are the sole Worker queue. All Pi Workers query that table
directly. A lightweight indexed `FOR UPDATE SKIP LOCKED` query locks one Run,
then the claimant briefly locks its physical `pi_sessions` row and rejects a
different live Worker owner before loading the immutable execution snapshot.
Attempt creation, its first transition and the Run update are one CTE statement
in the same transaction. There is no separate read-then-claim dispatcher or
owner table. `RunExecutor` makes competing claims and duplicate wakeups
harmless. `LISTEN/NOTIFY` is a
best-effort wakeup hint with periodic polling as the correctness fallback. A
monotonic process-local notification generation covers the claim-to-wait race:
a notification received before the waiter is installed forces an immediate
new claim instead of falling through to the one-second poll.

A Worker with a disconnected ownership channel does not claim, and a Worker
maintains Fact/Kafka, Tool Broker and Provider Gateway readiness in a one-second background
monitor. Claim admission reads that local fail-closed state without issuing
duplicate synchronous health requests for every Run. A short execution-plane
outage therefore leaves the Run queued without creating an Attempt or starting
a model call; the ExecutionLease, Fact Stream open and Tool Broker effect
boundary remain authoritative even within one monitor interval.

The queue retains the existing domain protocol:

```text
Run -> RunAttempt -> claim lease -> execution authority/fence -> terminal commit
```

KEDA uses only the count of ready Run and cancellation-control rows to scale
Workers; it does not own delivery semantics. Execution commands and their
historical queue Outbox no longer exist. The remaining Outbox is reserved for
terminal PostgreSQL-to-Kafka publication, where a transactional handoff is
actually required.

### Trusted Pi Worker pool

Workers are horizontally replaceable. A conversation slot claims a cold
physical Pi Session or another Run for a Session it already owns. Cold Sessions
have no process or thread. An active Session's main and delegated Lanes stay on
that Worker until their Attempts settle or lose authority.

One Worker process is an Agent Host that owns several active Sessions. It has
separately bounded conversation and Child Lane capacity, so a Parent waiting on
recursive delegation cannot consume the only slot able to start its Child.
Each active Lane currently constructs an independent Pi `Agent`, model
capability and Tool set from the accepted Run. This is a temporary adapter for
Pi 0.84's unfinished high-level AgentHarness; the Worker ownership boundary and
PostgreSQL Session/Lane contract already match Harness V2. Process-wide
registries contain trusted definitions only and never widen one Lane's tools.

The Agent Host consumes one `TrustedToolRuntime` interface rather than building
platform Tools itself. The maintained PostgreSQL implementation supplies
execution-plane-tagged Tool definitions:

```text
platform       Preview publication
orchestration  Subagent dispatch and parent/child communication
integration    reserved for external-system effect executors
```

These Tools currently execute as trusted modules in the Worker process; the
interface does not imply another deployment service. `RemoteToolSandboxTurnRunner`
merges their schemas with the Cube Tool proxies but never routes their execution
through Cube. This boundary lets a later Integration Executor move out of
process without changing Pi's Agent Loop or the Sandbox protocol.

The slot sees only a short-lived PiCloud Model Gateway capability. That local
Gateway validates the accepted provider/model, Cloud Step identity, cancellation
and request count, then forwards the provider-native protocol to CLIProxyAPI.
DeepSeek stays on native OpenAI Responses; OpenAI Codex stays on Codex Responses
rather than either route being flattened to Chat Completions. CLIProxyAPI alone
owns upstream OAuth/API credentials, refresh, quota/cooldown and concrete account selection.
It receives Pi's stable Session ID and applies soft Session affinity so later
Turns prefer the same account/cache route. Losing that affinity changes only
performance: PostgreSQL Pi SessionStorage remains the recovery authority.

Every Session pins one immutable, deployment-owned `AgentRevision` and a
separately selectable default Model Profile; every Run copies both as its
routing snapshot. The Session also stores the desired reasoning level and
nullable GPT Fast service tier. A user may change the complete settings only
while no Run is active, so the change applies to the next Turn without
rewriting history or an in-flight retry. Turn admission copies Provider, model,
reasoning, service tier and credential binding into one immutable row. The
Agent Revision independently names the Runtime, Harness
version and native Session Storage contract. The Pi Worker queue only claims `pi_sdk` Revisions and
the Runner rejects a non-Pi Session Storage contract, so another Agent family
may share product tables or the PostgreSQL cluster without reinterpreting
`pi_session_*` rows.

Each issued model-runtime capability also freezes the effective input
modalities and Provider-hosted Tool set for that route. Pi function Tools remain
the immutable Run Tool snapshot and execute through Tool Broker. Hosted Tools
are merged into the Provider-native Responses payload through Pi's public
`onPayload` hook and execute entirely at the Provider. They are enabled only
after an end-to-end probe through the pinned Provider Gateway. The current
OpenAI Codex and DeepSeek Responses routes enable `web_search`. Changing models
may still change the hosted Tool set at the next Turn boundary, but never inside
an active Agent Loop. PiCloud emits no synthetic capability notice to the user
or model. The Model Gateway publishes per-call Hosted Tool start/completion
boundaries and portable `search/open_page/find_in_page` display actions through
the current Run's Kafka live tail. The UI updates one stable activity row per
Provider item and can show repeated-search counts. Those progress events never
become Tool Broker operations or a parallel Session sidecar. At the terminal
Responses boundary, the trusted adapter binds completed native search actions
and URL citations to the issuing sampling identity and stores them inside that
Pi assistant message. Exact Provider/API/model replay
preserves the native item; model handoff retains only portable assistant text,
reasoning and citation links. Provider-hidden page contents are not returned
under `store:false` and are not claimed as durable.

The trusted Model Gateway also supplies model-specific context metadata to Pi.
GPT-5.6 Luna, Terra and Sol use a 1,000,000-token working window and begin
native Pi Compaction near 900,000 tokens, matching the deployment's local Codex
baseline. DeepSeek retains its independent 128,000-token window. These limits
are runtime capabilities, not user-controlled prompt fields.

Image understanding is an input modality, not a Tool. Provider image generation
is intentionally not exposed until Pi's Agent message contract can preserve and
restore the generated image result; PiCloud does not replace that missing
contract with a trusted in-process image Tool.

Before a Worker becomes Ready it preloads the governed `pi-subagents` Tool
contract and two empty Pi `ModelRuntime` slots. An active Lane operation
exclusively owns one slot and injects its short-lived Model Gateway capability
only after checkout; concurrent Lanes never share a mutable model runtime. The
slot returns to the Worker-local pool after settlement, while additional slots
are created lazily. This moves module/provider initialization out of
user-visible first-token latency without making cold-Session placement sticky.

For an accepted Run, Pi Session open and Model Runtime acquisition begin
concurrently because neither consumes the other's state. World State capture
still follows Session open, and Pi execution still waits for both preparations;
no durability or authority boundary is removed for latency.

Pi 0.84's official `SessionStorage` interface is implemented by
`@pi-cloud/pi-session-postgres`. It stores Pi entries, lanes, records, labels
and the append log in PostgreSQL, and bounds an active branch at Pi compaction.
Active-Run mutations first cross the same PostgreSQL `ExecutionLease` authority
as browser-visible events, then enter one accepted Session-keyed Kafka topic.
The Projector applies those accepted facts idempotently without rechecking a
lease that may legitimately expire after PubAck. Direct administrative
repository mutations remain transactionally authorized at their PostgreSQL
effect boundary.

The native `pi_session_entries` compaction node is the recovery authority;
Kafka's durable `context.compaction.*` facts provide live and audit evidence.
The obsolete `context_compactions` governance ledger has been removed rather
than maintained as a second, eventually inconsistent source of truth.
The browser's settled transcript reconstructs completed Compaction and model
retry notices from native Compaction entries and a presentation-only Pi custom
entry; it does not retain a second lifetime copy of live Kafka fragments or
inject the retry notice into model context.

The same package implements Pi's tenant-scoped `SessionRepo`; Workers open or
create Sessions through that repository rather than through a second
PiCloud-only lifecycle. Pi's pinned, unmodified backend conformance suite
defines the baseline CRUD, fork, query, ledger and ordering semantics. Opaque
Pi identifiers are stored as `text`; PiCloud product UUIDs are one valid
subset. Tenant isolation and exact `ExecutionLease` validation are additional cloud
contracts layered around the official port.

Human conversation forks use copy-on-write references. PostgreSQL stores the
selected branch's IDs, parent links and local sequence in the new conversation,
while immutable JSON payloads remain in their canonical source rows. Delegated
Agents instead share the root conversation's Pi Entry DAG through unique lane
heads and do not create per-Entry reference rows. A per-Worker 64 MiB LRU still
caches payloads for human forks; cache contents are never authoritative.

The production coding adapter is a deliberately thin `CloudAgentRuntime`. It
loads only the newest native compaction plus its active suffix, constructs one
Pi `Agent` for the active Run, and appends complete user, assistant and Tool
result entries back to PostgreSQL. It reuses Pi's public Agent Loop and
compaction primitives rather than recreating the generic `AgentHarness`
surface. No historical `session.jsonl` is downloaded, rewritten or used as
model-context authority.

The Harness captures a credential-free execution World State before the user
prompt reaches the provider. The stable Workspace binding is hashed separately
from both the Workspace content revision and physical Cube continuity. Releasing
and renewing a Tool lease against the same physical runtime is not a reset.
Recreating Cube for the same Volume emits `sandbox_reset`; rebinding the Session
to a different Workspace emits one hidden `workspace_changed` fact and
suppresses the conflicting file-preservation claim. Selected Harness facts are
carried in the native Compaction retained tail, so a later Worker sees one
current fact rather than losing it or replaying internal identifiers.

Human tree navigation is a bounded projection of the same parent-linked Pi
entries. Forking a settled final response creates a child product/Pi Session
and transactionally records references to the selected root-to-leaf branch.
The child shares the Workspace and begins with no open operation records. Tree
navigation is not exposed to the model or added to its context.

Deleting a parent archives its whole human descendant subtree and their typed
Subagent execution views after proving every Run has settled. Pruning after a settled
final response keeps that response, marks later product Turns invisible and
moves Pi's native `main` lane back to the retained entry. Later immutable
entries remain audit evidence but are unreachable from UI and model context;
Workspace bytes are deliberately not rolled back.

The runtime keeps only the cloud behavior the product needs: automatic
compaction, model retry, active steer, reviewed event mapping, remote Tools,
world-state changes and terminal Workspace settlement. A Tool intent is
written before its effect. If a Worker disappears before the Tool result is
known, the next Run records an unknown-effect result and interruption fact
instead of replaying arbitrary shell or file mutations.

Session Tool grants are copied into immutable Run capability snapshots during
admission. The snapshot is part of the frozen Cloud Turn context, selects which
Pi `AgentTool` proxies enter one runtime, but does not eagerly create an elastic
Cube. The first actual `read/write/edit/bash` call resolves one single-flight
Sandbox activation and carries the frozen grant to Tool Broker. A Tool-capable
Run against a pre-existing development machine reserves only its per-Run Tool
binding before model sampling, so Harness World State can attest that the same
physical machine survived. Each Sandbox operation then carries its trusted Pi Tool name;
Broker rejects both ungranted names and invalid Tool/operation combinations.
Model visibility is therefore an affordance, while Broker authorization is the
security boundary.

### Durable Pi subagents

PiCloud pins the public `pi-subagents` package and preserves its model-visible
Tool schema and workflow-script runtime. Upstream persona/role profiles are
disabled. The required internal agent selector has one neutral `cloud-child`
value whose prompt only establishes the Child execution boundary; behavior
comes from the delegated task plus explicit context, Workspace, Tool, model and
thinking settings. A narrow
`PI_SUBAGENT_PI_BINARY` adapter replaces only local child execution. Every child
gets an independently addressable `session_kind=subagent` execution scope, Run
and RunAttempt in PostgreSQL. The physical Pi Session's owning Worker claims it
from reserved Child capacity; another Worker skips it.
That scope binds to a unique lane in the root conversation's physical Pi
Session; it is not another Pi Session. The product
projects it beneath the causal parent Turn with explicit context and Workspace
mode labels; its native transcript is inspectable but read-only. Focused tree
navigation roots itself at the selected Child and shows inherited Pi context,
while whole-tree navigation attaches every Child to its causal parent Turn. It
never masquerades as a normal human conversation fork. A child never inherits
more Tools than the immutable parent Run snapshot.

Children may recursively delegate through the same cloud Tool contract. Every
execution stores its root Session/Run, immediate parent execution and depth;
all descendants share one deployment-owned tree budget. Defaults are depth 4,
32 total nodes and 3 simultaneously active descendants. The Tool is omitted at
the fixed depth/node boundary, while a concurrent-spawn race is rejected under
the root-Run lock. These bounds can be configured per Worker deployment but are
never model-controlled. Nested Child Runs use the same PostgreSQL queue,
physical Session owner, RunAttempt fence, Tool Broker authorization and Cube
Workspace modes as the first generation. Cancelling or archiving a parent
covers its full descendant execution subtree. Worker admission reserves the
configured Child concurrency from total Lane capacity so waiting ancestors
cannot block their descendants.

The upstream native supervisor channel is local-file based, so PiCloud persists
its `contact_supervisor`/`subagent_supervisor` state in PostgreSQL. Parent and
Child normally communicate inside the same owning Worker; the durable row is a
recovery record rather than a cross-Worker execution path. Progress updates are
non-blocking. Decision/interview requests pause the Child Tool, surface in the
parent Tool stream and wake the same Child Run after reply.

Context, allowed Tools and Workspace modes are explicit and independent:

- `none` creates a Tool-free child and never reserves Cube capacity;
- `shared` keeps separate Pi contexts and gives parent and child independent
  Tool bindings to the same Workspace runtime. Elastic bindings activate on
  the first local Tool; a shared Child of a cloud development-machine Session
  prebinds the existing machine to attest continuity and inherits its working
  directory. Ordinary Linux concurrency governs their files, processes and ports;
- upstream `worktree:true` maps to `isolated`: Tool Broker briefly excludes new
  Tool operations while
  the trusted Volume gateway makes an idempotent revision-bound internal
  Workspace copy, and the child keeps its resolved `fresh` or `branch` Pi context
  while running concurrently in another Cube. Its semantic result is returned
  to the parent; Git branches or explicit file operations are user-managed.
  The internal Workspace is hidden from product lists and retired after
  terminal settlement. Child Sandbox retention is always ephemeral even when
  the parent conversation is persistent.

For `context=branch`, PiCloud creates the Child lane at the exact Entry before the
current parent prompt that requested delegation, then appends the deployment-
owned Child task on that lane. `context=fresh` starts the lane at `null`.
Earlier conversation and compaction state are shared through the immutable
Entry DAG, while the orchestration request is not copied as another executable
Child instruction.

RunAttempt fences and the Tool Broker operation ledger remain the side-effect
authority across parent and child bindings; envd carries no Session identity
or ownership secret. Session-local fence numbers are never compared as if they
were one global sequence. Each Worker Host keeps at least one slot out
of ordinary-parent admission when subagents are enabled, so parents waiting in
the upstream workflow cannot occupy every slot needed by their children.

### Worker Control Channel

The authenticated Supervisor WebSocket carries registration, heartbeat,
durable event ACKs and active steer. It is not a second Run dispatcher. A brief
channel disconnect does not revoke a healthy database lease; an expired lease,
stale fence or non-retryable identity failure fails closed.

### Model Gateway

The model gateway is local to the trusted Worker boundary. It injects provider
credentials, binds model requests to Run/Step identity and records usage. Cube
cannot reach or authenticate to it. Its issued runtime descriptor includes the
frozen input modalities and Provider-hosted Tool names. The Gateway validates
the accepted Provider/model/protocol but does not execute hosted Tools or
rewrite them as Pi function calls.

### Source-control App and Issue automation

Source control is an optional trusted-plane adapter, not a Tool exposed to the
model. The current user-facing provider is a self-managed GitLab project
connection; a GitHub App adapter remains available to deployments that enable
it outside the current Web surface. A GitHub installation callback is bound
to the logged-in tenant by a one-use state value; PostgreSQL stores the
installation and selected repository identities. The App private key and
Webhook HMAC secret remain deployment secrets, while one-repository
installation access tokens exist only for the duration of trusted API work.

PiCloud never clones a repository or creates a Git branch. A selected execution
environment must pass `git ls-remote` before its Issue Run starts. The user
connects GitLab or GitHub by Origin from the conversation UI; the token is
written directly to the environment's hidden `.git-credentials` file and is
never stored in PostgreSQL. Git uses ordinary host-level credential matching,
and the Agent performs visible `git clone` and branch commands.

GitLab Project Webhooks use a Standard Webhooks HMAC signing token and stable
`webhook-id`; deployment project access tokens are encrypted in PostgreSQL and
only unsealed for trusted GitLab API work. They are distinct from user Code Host
credentials. GitHub Issue and
Issue-comment Webhooks enter through their native raw-body HMAC gate. Provider
delivery IDs are idempotency keys. Only the configured label or exact
`/picloud solve` collaborator command creates a pending Issue request. Any
authorized PiCloud tenant user may record a non-exclusive
claim, then explicitly choose elastic compute or an existing Workspace, or a
directory in an owned development machine.
The user also names the resulting conversation. The coordinator
provisions an ordinary Project/Workspace when needed, then creates one Session
and Run under that user's identity and observes the existing PostgreSQL Run
queue. It is not a second scheduler.

The initial Issue prompt requires implementation and tests but explicitly
forbids commit, push, Merge/Pull Request creation, Issue comments and state
changes. Run completion settles only the PiCloud execution record. Git and
provider delivery remain user-directed actions in a later conversation Turn.

### Tool Broker and Cube

The Broker validates opaque Tool authority, resolves a Workspace's Sandbox
Domain and reconciles Cube lifecycle. Pi cannot choose a Sandbox ID, image,
mount, runtime class, resource limit or network policy.

PostgreSQL records one physical Workspace runtime per elastic Workspace. Every
Run receives a separate in-memory Tool binding whose Lease/Fence is validated
again when an operation starts. If the Broker disappears, bindings expire with
their Session leases and an unadopted elastic runtime is destroyed; persistent
Workspace bytes are unaffected.

Cube mounts only the `workspace/` child of a trusted persistent Volume. The
guest contains normal development tools but no model, database, Kafka or Cube
control credential. Repository credentials deliberately belong to the selected
execution environment's origin-scoped `.git-credentials` store and are visible
to its Agent just as they would be after `glab auth login`; the Agent owns the
resulting `.git` tree.
The trusted Volume envelope holds only identity, generation and optional fork
origin metadata; it does not track Git state or file changes.

Run Claim does not lock a Workspace. The first Tool operation lazily creates one
Workspace-owned Cube and attaches its Volume. Different Sessions then use
independently fenced Tool bindings in that same Cube concurrently. A connected
human terminal uses the same runtime. File overwrites, process visibility and
port conflicts are ordinary user-managed Linux behavior. The Workspace pointer
records the last settled observation, while each Session keeps its own
settlement lineage.

### Workspace Web Terminal

The authenticated public path
`/v1/conversations/:sessionId/terminal` is a WebSocket proxy, not a public Cube
port. The Control Plane resolves tenant, Project, Workspace, Sandbox Domain and
active environment from PostgreSQL. A newly-created deployment-owned
environment may still be `pending`, matching the first Agent Run's admission
rule; a `failed` environment is rejected. Terminal readiness is not persisted
as Agent environment-validation evidence because that evidence remains bound
to a fenced Run/Attempt. The Control Plane sends the trusted descriptor over a
dedicated service credential to the Tool Broker, which lazily creates a Cube
and opens a UID 1000 PTY in `/workspace` through Cube's standard envd process
API. Cube-agent starts envd through the VM's vsock control path. The generic
guest agent is transport only: tenant identity, writer admission, ExecutionLease
and operation idempotency remain in PostgreSQL and the external Tool Broker.

Human terminal authority is deliberately separate from Agent ExecutionLeases
and Tool policy snapshots. It does not advance or revoke a Session's Agent
fence. Opening a terminal reuses the Workspace runtime when it exists, or
creates that one runtime when it does not. Agent Tool bindings and the PTY may
remain active together. Conflicting file/process operations
use ordinary user-managed Linux semantics. No in-guest secret is an ownership
authority. Input, output and resize frames are bounded; terminal transcripts
are not persisted.

### User-owned development environments

`DevelopmentEnvironment` is a PostgreSQL product allocation keyed by tenant,
owner user and an internal `development_environment` Workspace. This storage
kind is rejected by elastic Session and Workspace APIs. Public REST and WebSocket handlers always derive the
owner from authenticated request identity; responses contain no Cube runtime
ID, traffic token or Broker credential. Tool Broker is the only CubeAPI client.

Creation synchronously checks tenant durable-resource admission,
Sandbox-Domain capacity and the real Cube scheduling result. The API returns `201` only after
the requested profile is running; capacity exhaustion returns a structured
retryable error and the rejected machine allocation is retired. A reconciler
removes a `requested` row abandoned by a Control Plane crash before provisioning.

Provisioning eagerly creates one Cube KVM with the deployment-owned template,
resource policy and network boundary. Its private persistent file Volume is
mounted at `/home/user`; the elastic-only `/workspace` path is removed during
machine initialization. The Cube timeout is disabled for this explicit
allocation. A terminal opens inside the existing KVM, and disconnect kills only
the PTY. Pause snapshots VM memory/filesystem; resume reconnects the same Cube
identity. Release destroys the Cube and tombstones its machine-owned Workspace;
the Volume reaper deletes the complete home Volume after every activation has
retired.

The user selects one deployment-owned immutable template profile (starter,
standard or performance). CPU, memory and system-disk values come from the
registered Cube template catalog; arbitrary template IDs and resource overrides
are never accepted from the browser.

The product calls this allocation a cloud development machine. It is requested
independently from elastic Workspaces. The Control Plane allocates its private
machine Volume and internal project identity transactionally; neither ever
enters the elastic Workspace inventory. Several conversations may select
working directories from the complete guest filesystem. The directory is a
Session binding, not another Volume. The machine permits one active Agent
authority and one human terminal/SSH session at the same time; pause and release
still wait for both.

The authenticated folder chooser may create one bounded child directory in an
owned running machine. Control Plane binds tenant/user identity, Tool Broker
validates the parent/name and asks envd to start a bounded, root-owned one-shot
filesystem helper. It may run alongside an Agent or terminal under ordinary
filesystem semantics. The helper exits after returning the directory result.
The browser never sends a shell command or receives Cube authority.

Guest evidence includes a bounded control-protocol version. Broker and guest
must match the current version exactly; an older exclusive machine is released
instead of carrying a compatibility execution path or silently rebuilding a
different machine. Users create a new machine explicitly after release.

The allocation participates in Sandbox-Domain capacity. `agent_activation_id`
and `terminal_active` are independent durable ownership facts. Tool Broker
grants a temporary Agent Tool binding to the existing machine and returns that
binding without changing the Cube's physical identity. A
planned Broker shutdown stores an encrypted reconnect capsule, detaches its
process-local handle and leaves each cloud development machine in its existing
physical state. It does not pause a running VM. A replacement Broker validates
the capsule, PostgreSQL ownership and Cube metadata before it adopts the same
runtime; already-running processes, SSH and Preview therefore do not share the
Broker process lifetime. Healthy replicas periodically reconcile machines whose
owner lease ended, so takeover does not require restarting the replacement. An
explicit user pause remains paused across takeover. The capsule is pinned to
the machine's own guest image revision, not the deployment's current default
template. A template upgrade therefore affects only newly created machines;
recovery still requires the capsule, environment evidence, short-lived Tool
Worker report and physical Cube metadata to agree on the old machine's exact
revision. The Tool report is produced by a short-lived uid-1000 worker, not a
resident PiCloud daemon. Elastic Cubes retain fail-closed orphan cleanup.

Broker replacement is not transparent exactly-once migration for an in-flight
Tool RPC. The old Run loses its external authority and records an interruption
or unknown effect, while an already-started guest process may continue as part
of the user-owned machine. The replacement adopts the VM under machine
authority before any later Agent or terminal receives a new writer lease.

Pausing a full VM is a long Cube operation. If CubeAPI returns its standard-route
HTTP 408 while CubeMaster is still snapshotting, Tool Broker treats the response
as uncertain and polls the same physical Sandbox identity. It commits `paused`
only after Cube reports that state; disappearance or a bounded wait expiry stays
an error. Production and Helm timeout policies keep at least a two-minute Cube
lifecycle budget so deployment overrides cannot silently restore the former
30-second failure mode.

### Authenticated Sandbox service preview

The browser reaches a service through a same-origin PiCloud preview path. The
Control Plane authenticates the user and resolves the conversation or owned
development environment. Tool Broker resolves the local live handle and uses
Cube's authenticated envd ingress to launch an unprivileged, bounded one-shot
HTTP helper. That helper reaches the requested localhost application port and
exits after returning the response. Applications must bind `0.0.0.0` or
localhost; envd port 49983 is never a Preview target. Cube traffic
tokens, envd access tokens, physical Sandbox IDs and external routing details
never leave the trusted execution plane or reach the application. Responses are
bounded and security-sensitive hop-by-hop headers are not forwarded. Applications
should use relative asset URLs under the path-based preview endpoint. HTML
responses get a per-response CSP nonce on inline script/style blocks.

The immutable template exposes and probes only envd, so PiCloud does not reserve
fixed application ports or depend on Cube host-port mappings. After each Bash
operation, Cube Provider uses its trusted management channel to run a fixed,
credential-free listener probe inside the VM. The probe reads the VM's
listening-socket table and checks bounded unprivileged candidates as HTTP; it
does not change the Agent Tool response contract or depend on the guest's PiCloud
image revision. Tool Broker persists that evidence against the physical runtime
and conversation/development-environment target. A trusted `preview` Tool
resolves a model-selected verified port into an authenticated conversation
route, and its structured Tool result renders the application link inline in
the transcript. There is no persistent top-bar application hint and no parsing
of assistant text. The Agent never calculates a public IP, signed URL or NAT
mapping.

Cube's ordinary Sandbox ingress is HTTP/WebSocket-oriented. PiCloud does not
expose Sandbox port 22. A separate trusted SSH gateway validates a one-time
PostgreSQL ticket and translates a standard SSH shell channel to the existing
Tool Broker PTY protocol. Tickets are issued only for an owned, running cloud
development machine with no other human terminal. An unused ticket lasts
24 hours by default, but the first successful authentication consumes it. The
gateway has no CubeAPI or model credential.

### Independent resource lifetimes

A Session freezes `executionMode=elastic|development_environment`. The first
requires a `user` Workspace and gets a disposable/bounded-warm Cube on demand;
the second requires a live owned development machine and borrows that exact
Cube. The removed `ephemeral/persistent` retention protocol has no runtime
compatibility path.

A Session's Pi entries and tree remain in PostgreSQL when its Workspace is
soft-deleted. The Session reports `workspaceState=missing`, accepts no new Turn
and can be rebound idempotently to another live tenant Workspace. Historical
Runs keep the original Workspace foreign key; a new Run freezes the new
binding. Workspace deletion never archives a Session or Subagent transcript
merely to release storage.
The browser opens this rebind chooser immediately when such a Session is
selected, instead of waiting for the user to submit a Turn that must fail.

### Persistent Workspace Volume gateway

Workspace Volume Gateway is a narrow trusted POSIX data service. It does not
copy Workspaces to Kopia or object storage. It:

- prepares and verifies the stable tenant/Workspace Volume identity;
- initializes an empty/imported Workspace once;
- deletes Workspace file bytes only when asked by the Tool Broker deletion coordinator;
- records a lightweight provider settlement revision without walking the file tree;
- lists one current directory or reads one current file for the UI;
- rejects traversal and symlink escapes and hides platform/Git metadata;
- serializes operations with a process lock and PostgreSQL advisory lock;
- creates revision-bound internal Volume copies for isolated Subagent lanes.

The deletion coordinator runs in Tool Broker because only that service holds
CubeAPI authority. It waits for the Workspace runtime, Tool bindings and human terminals,
deletes the POSIX directory through the narrow gateway, deletes the deterministic
Cube Volume record, and only then commits `storage_purged_at`. Repeated cleanup
is idempotent; no empty Cube Volume metadata is retained.

Creating an elastic Workspace reserves its tenant/project identity but not CPU
or memory. Compute admission occurs on the first Tool-using Run, so an idle
Workspace consumes storage only. A cloud development machine differs: its
selected CPU/memory/system-disk template is synchronously admitted at creation.

Stopping an elastic Cube loses its processes and memory. A new elastic Cube
attaches the same persistent Volume, so project files and dependencies remain.
A cloud development machine is paused and adopted as the same machine; its
rootfs, memory and process state are node-affine Cube state. Its `/home/user`
Volume belongs to that machine and is deleted on explicit release. Conversation
history remains independent and reports a missing Workspace until the user
rebinds it.

Source browsing lists and reads the current persistent Volume directly through
the trusted Volume gateway. It neither creates a Cube nor consumes Cube
admission capacity. Directory expansion performs one bounded directory read;
opening a file performs one bounded file read and verifies that response.

### Durable browser stream

Pi exposes separate Assistant-message, Tool-execution and Agent lifecycle
events. The public adapter intentionally ignores thinking fragments, streamed
Tool-call JSON and partial Tool stdout. It publishes Assistant text deltas,
complete Tool start/result Items and low-frequency lifecycle boundaries.

After PostgreSQL issues the current Session lease, the Worker opens one logical
Fact Stream bound to that lease, Session and Turn. All active Streams in one
Worker share one service-authenticated WebSocket to the ingest Gateway. The
Gateway records a distinct short channel lease for every logical Stream on its
Session lease row. Both Agent events and complete Pi Session mutations cross
that multiplexed Worker connection. A single PostgreSQL Authority Gate binds
canonical scope and removes the lease;
the resulting AcceptedFact is appended through a broker-neutral bus. The
Kafka adapter keys every Fact by Session ID and uses `acks=all`. Different
Session leases publish concurrently, while one logical Stream keeps one Fact
in flight. Stream ownership renews set-wise outside the Fact hot
path. After PubAck, a separate progress store checkpoints the acknowledged
Agent-event sequence set-wise and flushes it on normal Stream close; this is a
terminal-stream boundary, not an admission decision. Normal settlement closes
the Stream before releasing the lease; crash recovery waits for its short
lease rather than admitting overlapping generations. Workers have no Kafka
credentials or network route.

There is no second mutation endpoint or mutation-specific authority. The Gate
does not inspect event sequence, deduplicate, replay, choose a Stream or wait
for a projector. Those responsibilities start after acceptance. Pi still waits
for its mutation result/projection barrier when the next Agent operation
causally depends on canonical Session state.

Each Gateway consumes the Kafka topic into a rebuildable in-memory tail holding
incomplete active Turns only. The public SSE request carries no cursor. Its first
frame replaces the browser view with PostgreSQL canonical messages plus an
immutable snapshot of that tail; later frames contain new events. Terminal Facts
are sent to existing subscribers and then unload the covered shared tail. Slow
connections have bounded queues and reconnect for another snapshot.

Accepted Pi Session mutations contain immutable logical Run identity for result
correlation plus the Authority-Gate-resolved physical Pi Session/lane target,
but no ExecutionLease. A shared Kafka consumer group applies complete entries,
records and compaction facts idempotently to PostgreSQL. Before opening a Session,
every Run appends a keyed recovery barrier and waits for its projection; all
older accepted Session mutations have then been applied before the Worker
reads PostgreSQL. Each semantic Pi write also waits for its own mutation result
before the Agent Loop advances.
PostgreSQL therefore stores semantic Pi state, not token fragments. Terminal
Run state and a one-row event outbox commit in the same PostgreSQL transaction.
Abnormal interruption recovery reads only the retained Kafka Session tail needed to
preserve a visible prefix that never reached `message_end`.

## State ownership

| State | Authority |
| --- | --- |
| tenants, users, sessions, durable-resource admission | PostgreSQL |
| local PiCloud identities and non-exclusive Issue claims | PostgreSQL |
| Runs, Attempts, leases, fences, ready queue | PostgreSQL |
| Pi Session entries/compaction/operation records | PostgreSQL SessionStorage |
| Session desired model/reasoning/Fast settings and immutable Turn snapshots | PostgreSQL |
| Session Tool grants and immutable Run capability snapshots | PostgreSQL |
| conversation parent/fork graph | PostgreSQL |
| canonical completed conversation | PostgreSQL |
| bounded accepted live facts | Kafka topic keyed by Session ID |
| incomplete browser view | rebuildable Gateway memory |
| elastic Workspace bytes | persistent Cube Volume |
| elastic Workspace runtime identity/owner | PostgreSQL `tool_broker_workspace_runtimes` |
| active Run Tool bindings | Tool Broker memory + PostgreSQL Session leases/operation rows |
| cloud development machine guest root, memory and processes | one Cube pause snapshot on its compute node |
| encrypted machine reconnect capsule | PostgreSQL; key held only by Tool Broker |
| Workspace settlement/reference | PostgreSQL + trusted Volume envelope |
| user Git metadata and Code Host tokens | persistent environment bytes under `.git` and hidden `.git-credentials`, visible to Cube/Agent |
| live process tree | one Cube KVM only |
| active in-memory `messages[]` | Pi SDK for one active Run |
| development-environment ownership/lifecycle | PostgreSQL |
| development-environment process/memory/rootfs state | one node-affine Cube KVM snapshot |
| Agent definitions, immutable revisions and Session/Run routing | PostgreSQL |
| source-control connections/repository grants and Issue Jobs | PostgreSQL |
| GitLab project token and Webhook signing token | encrypted PostgreSQL credential row |
| GitHub App private key and Webhook secret | deployment Secret files |
| deployment provider token plaintext | ephemeral trusted API memory only |

## First and later messages

For the first message, the Control Plane creates/uses a Workspace and Pi
Session, then queues the Run. Pure conversation stays entirely in the trusted
plane. If Pi chooses a Tool, the Broker lazily creates Cube and mounts the
Workspace Volume.

For a later message, the current owner handles it while another Lane remains
active; otherwise any Worker may acquire and restore the cold Pi Session. It
first crosses the Session mutation projection barrier, rechecks its newer
fence, then Pi reconstructs the active model context and respects its native
compaction boundary. If the Workspace Cube is still warm, the Run receives a
new Tool binding without changing physical identity; otherwise a new KVM mounts
the same persistent Volume. Process state is not
claimed as durable. Cube has no competing absolute lifetime: Broker idle TTL is
the sole elastic-compute expiry policy, so continuously active Sessions are not
terminated because their VM crosses one Turn's timeout.

## Failure rules

- queue delivery is at-least-once; state commits are idempotent/fenced;
- arbitrary shell start is not exactly-once and is never blindly replayed;
- stale Workers cannot mutate Pi SessionStorage, execute Tools, commit a
  terminal Run or advance a Workspace settlement;
- an unreachable Worker endpoint cannot strand a Session after its connection
  and lease expire: logical retirement proceeds under the durable fence, the
  interrupted Run and model reservation fail, terminal Tool ownership is
  retired before the next writer, and the Session returns to idle for a
  barriered next Run;
- cancellation revokes authority before process termination;
- during `cancel_requested`, Tool authority is revoked while the current
  ExecutionLease retains narrowly bounded Pi Session write authority to commit
  interruption and unknown-effect facts; terminal cancellation then closes it;
- visible live events are durable before SSE; successful terminal messages are
  Pi-native and canonical before completion;
- interruption and Sandbox reset boundaries are minimal model-visible facts;
  an unfinished Tool becomes an explicit unknown effect, never a fabricated
  success or an automatic replay;
- Cube/process loss preserves files only; the next model is told when the
execution world materially changed.

A conversation fork resumes through the same path as any other Session. Its
Pi branch already contains the selected inherited context, while its product
transcript renders the parent history through the fork Turn followed by child
Turns. SSE sequence numbers remain local to the child Session.

## Scaling

Control Plane, Pi Worker and Tool Broker are independent replica sets.
PostgreSQL/PgBouncer, Workspace storage and Cube are external authorities.
Scaling the Worker pool adds Agent Loop slots;
scaling Cube compute adds concurrent Tool environments. No Cell abstraction or
private per-Worker queue is required; active Session ownership is derived from
the shared RunAttempt authority.
