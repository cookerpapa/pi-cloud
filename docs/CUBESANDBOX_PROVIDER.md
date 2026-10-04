# CubeSandbox execution provider

## Current role

CubeSandbox KVM is the only untrusted Tool runtime. Pi and provider credentials
stay in the trusted Worker. The Control Plane owns VM lifecycle and immutable
Run bindings; Cubelet owns native execution and final delivery.

```text
Pi Tool -> validation/prepare in Worker -> publication ingress -> Kafka
  -> Projector dispatch commit -> Cube API/Master -> Cubelet native exec
  -> fixed guest Tool -> trusted Cube completion adapter -> Kafka reply
  -> original Worker callback -> Pi after-Tool hooks -> canonical Session append
```

The Projector waits for bounded takeover. It does not relay Tool duration or
large results. The guest runs the complete pinned Pi Tool under UID 1000 inside
an operation cgroup; no user extension or Agent Loop enters that boundary.
The native raw-PTY transport has ready and byte-receipt frames because upstream
non-terminal exec does not expose pipes. It is the single fixed transport, not
an alternate runtime or fallback.

## Identity and authority

PG is Run/control authority. Source admission uses installed memory and closes
before seals. A Cube request carries immutable physical endpoint/node/boot,
Run/writer, operation identity and its Kafka topic/partition/offset. Cube checks
boot identity, active duplicate fingerprints and monotonic VM/partition progress,
without a per-command PG lease query. Domain-independent Projector ownership
uses a deployment-owned Cube endpoint registry; metadata cannot select an
unconfigured credential destination.

PG binding revocation is installed at publication admission; its closed reference
follows the same Kafka Session queue. Normal cancellation carries an operation ID
and position through that path to Cube. Cube acknowledges only signal acceptance;
the guest Tool's original final reply carries cancellation/partial output to Pi.
The Worker bounds its result wait and records UNKNOWN if unconfirmed. Abnormal
retirement retains a bounded target/run/writer in the existing Outbox so a lost
Worker or deleted binding cannot erase the cancellation address.

Normal Agent cancellation follows the Tool's process-group boundary. Completed
background services and independent setsid groups remain alive. Native Tool
execution timeout and explicit VM lifecycle retain separate cgroup cleanup; no
PG process-stop receipt or completed-result cache is introduced. A normal Tool
error or missing reply has no VM-destruction power.
Controller replacement adopts
persisted VM capsules and active binding descriptors. Controller expiry/shutdown
preserves the last physical state of capsule-backed VMs; it does not quarantine
them or close their bindings. Adoption still checks VM/boot continuity, and a
real recovery failure closes admission. Cubelet boot replacement
is different: old execution outcomes are unknown and are never replayed.

There is no completed-result GET/cache or PG Tool operation ledger. The bounded
host adapter may retry final delivery, never execution. The Worker boot mailbox
resolves the original callback; a new Worker does not revive old promises.
The v2 boot reply envelope separates native `tool_result` from structured
`execution_failure` with a code and `not_started`/`unknown` effect status.
The Harness never classifies infrastructure from Tool stdout/stderr. Pi retains
its normal Tool error/hooks path and canonical-result ownership (ADR-0225).

The guest receives no model, PG, S3, Kubernetes or control-plane credential.
The trusted Cube host completion adapter holds only its required PG/S3/Kafka
and observation credentials. It stores images in S3 before sending references;
the Worker verifies tenant/length/hash and restores ordinary Pi ImageContent.
Two large-read permits bound image materialization independently of ordinary
execution capacity.

Chat image preparation uses the same processor through fixed `envd-input-files.mjs`
under the current Run binding. It reads immutable source references, normalizes in
Cube and returns references through the control-plane management API, without fabricating an Agent Tool
or changing Kafka dispatch semantics. The same fixed helper writes dedicated-machine
uploads under UID 1000; elastic uploads use the existing Volume Gateway. See
[chat uploads](CHAT_ATTACHMENTS.md) for limits and claims.

The guest uses Pi's public image processor hook with pinned Sharp. `read` accepts
optional image `detail: high | original`; high is the default. The dimensions and
32px patch budgets match the inspected Codex client: high 2048/2500, original
6000/10000. Images are sniffed by content and normalized to static lossless 8-bit
PNG; hints report the delivered dimensions. Image inputs have no PiCloud byte/pixel quota; normalized replies retain the
64 MiB transport envelope and the existing model sizing policy. Available guest
memory and provider capabilities still apply. Decode errors and unsupported model vision
are visible; the system never silently switches models or reduces detail on retry.

The guest helper reuses fixed Pi edit/write logic locally and emits native
`tool_execution_update`/`tool_execution_end` payloads. Source-side bounded output
does not kill a command just because its preview is full. No full-output archive
is created. Kafka credentials remain in the trusted host adapter, never in the guest.
Updates take a separate best-effort host HTTP → Projector SSE path, not Kafka
or Worker. They are collapsed temporary log previews, not durable Tool results.

## Workspace and process lifetime

One tenant Workspace maps to one stable persistent Cube Volume. Only the
`workspace/` child of its trusted Volume envelope is mounted into the guest as
`/workspace`; plugin-owned identity and deletion metadata stay outside the guest view.
User-managed `.git` directories remain inside `/workspace` and are created only
by ordinary `git clone/init`. A hidden `.git-credentials` file stores the
selected environment's GitLab/GitHub origin connections. It is excluded from
product source browsing while remaining readable to untrusted code in that
environment, like credentials on an ordinary developer machine.

The filesystem owns file durability independently of Run completion. There is
no per-Run capture, reference object or Workspace settlement head in PostgreSQL.
Initialization and live reads address the bound Volume directly. Subagents never
copy this Volume: optional temporary Cubes mount it at the same guest path.
Machine home Volumes use `/home/user`, not the machine's private system disk.

Managed Volume placement records a hold before the node Create. Cubelet's
synchronous reference metadata retains unfinished detach and a durable
incarnation/revision; Master materializes the latest node state. Deletion closes
new attachment admission and checks existing holds plus confirmed node detach.
Zero local references alone do not prove physical cleanup. Allocation receipt
loss/GC cannot erase the node identity needed to reconcile Volume state.
Unreachable nodes and untracked historical references remain held (ADR-0226).

A Workspace-owned Cube runtime may remain warm for one deployment-bounded TTL.
Its processes, sockets and PTYs survive only while that exact runtime
survives. After destruction or failure, a new KVM reattaches the same Volume and
recovers files, not RAM or process state. Warm retention is an optimization,
never a conversation or Workspace durability dependency. User-owned development
machines use the separate pause/resume/release lifecycle and never enter the
elastic warm pool.

Cube's absolute timeout is disabled for controller-managed runtimes. The
Control Plane owns elastic lifecycle: active Tool bindings keep their Workspace Cube;
an idle elastic runtime is destroyed
after `PI_CLOUD_SANDBOX_WARM_TTL_MS`. A user owns an exclusive machine's
lifecycle through authenticated pause/resume/release operations. Controller
restart adopts both elastic and user-owned VMs without changing their physical
state. Destruction is an explicit lifecycle action and is followed by an exact
node observation before quota is released.

## Tool and terminal channels

Managed execution includes `POST /sandboxes/:id/execution/probe`.
The recorded node and executor boot are required. A fixed guest program echoes
a probe UUID and its kernel boot identity over the same native raw-PTY transport
as Tools, without Workspace access or user commands. Controller probes return
within the bounded HTTP request; Session probes use bounded asynchronous takeover
and the existing completion adapter/Worker reply topic. The latter groups shared
VM bindings in one echo. Direct observation works even when Kafka completion is
unavailable. Probe lifetimes use a separate four-request Cubelet budget and no
retained Tool operation ledger. Failure has no quarantine or deletion authority.
The provider replaces its former envd command-based execution probe with this
single native implementation. Probes never advance Tool admission positions;
late observations have no effect authority. Managed submit requires a source
position. Protocol 5 adds idempotent `execution/cancel`; its accepted response
does not assert process exit. Guest wire 3 forwards cancellation over the original
operation pipe. There is no old-wire fallback.
Cube/app upgrades require the drained, matched build in
[ADR-0221](adr/0221-pi-tool-cancellation.md); probe semantics remain those of
[ADR-0211](adr/0211-execution-path-and-runtime-probes.md).

Fixed Agent Tools use native Cubelet execution. The Web Terminal keeps its
separate human reservation and envd PTY through the control-plane module:

```text
authenticated browser WebSocket
  -> Control Plane
  -> sandbox lifecycle module
  -> CubeProxy -> envd
  -> unprivileged PTY in /workspace
```

A human terminal and any number of authorized Agent Runs may write the same
Workspace at the same time. Ordinary Sessions use the default Workspace-owned
Cube; a cloud development machine likewise uses one Cube. Subagents may select
another temporary compute scope on the same Volume and an existing cwd, including
a user-created Git worktree. Each scope has its own runtime lifetime; retiring
one cannot delete the Volume or stop its siblings. Standard SSH is
terminated by PiCloud's trusted ticket gateway and translated into this PTY
protocol; Cube port 22 remains private. Envd is the single generic guest agent
and holds no PiCloud, model or database credential.

## Network policy

The guest has no route to platform services. Optional public HTTP/HTTPS egress
crosses a deployment-owned proxy that resolves targets and rejects loopback,
private, link-local, metadata, Kubernetes and platform destinations. A
deployment may separately add bounded RFC1918 CIDRs to Cube `allowOut`; these
destinations bypass the proxy through `NO_PROXY` and are reached directly from
the guest. No tenant-controlled request may expand that list.

## Template and resource policy

The deployment-owned immutable template supplies the language toolchain,
Cube's envd and the one-shot Tool Worker code. Elastic Agent Tools use the fixed non-root user. An
exclusive machine's authenticated human terminal/SSH channel may start as guest
root; KVM and the absence of platform credentials are then the tenant boundary.
Users cannot submit a template,
kernel, device, host mount, privileged flag or network policy. Cube, Control Plane
and the short-lived Worker enforce bounded CPU, memory, process count, open
files, output and execution time.

Template retention deletes only superseded Pi Cloud templates after proving no
active Sandbox references them. It does not touch tenant Workspace Volumes or
Pi Session records.

## Reconciliation and evidence

Managed protocol 7 retains recoverable allocations (ADR-0223) and adds queryable
Volume reference state (ADR-0226), alongside v2 boot replies. `SandboxProvider`
receives an immutable PG-issued creation deadline alongside the physical identity.
Cube creation carries that identity and deadline, and queries/closure use the
private `/allocations/:allocationId/get|close` POST endpoints. Duplicate creation
retains its original VM/node and private-ingress token. A timeout is not a proved
capacity refusal or absence. Closed admission plus node absence is required for
cleanup completion; endpoint acceptance alone cannot release resources.
The rendered Cubelet metadata configuration requires `no_sync = false`; the
allocation adapter refuses startup if durable admission cannot be guaranteed.

`workspace_runtimes`, `development_environments` and independent terminal
allocations retain their creation configuration until resource deletion. Existing
capsule adoption remains supported; incomplete creation recovers through its
recorded allocation. Legacy UNKNOWN rows without this protocol are not relabelled
as safe. Cubelet metadata loss rejects old-boot creation and retains uncertainty
when a prior unfinished creator cannot be physically accounted for.

PostgreSQL records physical Workspace runtime identity and control-plane ownership.
Run Tool bindings are independently fenced and never masquerade as Cube
identity. The controller periodically reconciles physical runtime state with Cube
inventory, so an old binding cleanup cannot delete a shared or newer KVM.

Verification includes:

```bash
npm run cubesandbox:template-check
npm run cubesandbox:live-check
npm run production:check
```

The live gate is required for claims about guest identity, credentials,
cross-tenant file isolation, configured private-network reachability, public proxy behavior,
timeout/cancellation, persistent Volume reattachment and orphan cleanup. The
one-host profile still shares one physical host and does not claim host or Cube
administrator compromise tolerance.
