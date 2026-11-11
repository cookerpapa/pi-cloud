# CubeSandbox execution provider

## Current role

CubeSandbox KVM is the only untrusted Tool runtime. Pi and provider credentials
stay in the trusted Worker. The Control Plane owns VM lifecycle and immutable
Run bindings; the separate Session runtime dispatches existing bindings and
serves workflow/image/Skill/preview data without that controller. The fixed Guest
service owns Tool admission/cancellation; the independent HTTPS completion service
owns reply publication. [Boundary](adr/0307-guest-execution-and-session-activity.md).

```text
Pi Tool -> Worker validates and commits through its Session producer -> Kafka
  -> Projector dispatch commit -> execution-side binding preparation
  -> Cube adapter -> ordinary CubeProxy/envd process API -> fixed Guest service
  -> fixed guest Tool -> HTTPS completion service -> original Kafka reply topic
  -> authorized Worker callback -> Pi after-Tool hooks -> canonical Session append
```

The Projector waits for bounded takeover. It does not relay Tool duration or
large results. The guest runs the complete pinned Pi Tool under UID 1000 inside
an operation cgroup; no user extension or Agent Loop enters that boundary.
The ordinary process API starts a short fixed control client; bounded JSON travels
on stdin/stdout. Tool data and images leave the Guest over HTTPS. The Guest service
persists admission before launching an independent operation process. Neither the
caller connection nor service restart cancels or repeats an admitted command.
A lost completion ACK cannot retroactively kill completed background work.

## Identity and authority

PG is Run/control authority. Source admission uses installed memory and closes
before seals. A Guest request carries immutable physical endpoint/node/boot,
Run/writer, operation identity and its Kafka topic/partition/offset. The Guest checks
boot identity, active duplicate fingerprints and monotonic VM/partition progress,
without a per-command PG lease query. Domain-independent Projector ownership
uses a deployment-owned Cube endpoint registry; metadata cannot select an
unconfigured credential destination.

PG closes resource/new-binding admission first; its closed reference follows the
same Kafka Session queue. The partition owner consumes it and records stopped
routing admission in the existing Outbox before management can retire the VM
(ADR-0305). Kafka publication alone is not that acknowledgement. Normal cancellation carries an operation ID
and position through that path to the Guest. It acknowledges only signal acceptance;
the fixed guest delivers cancellation to its Tool AbortController. Native Durable
abort may settle before physical completion and discard the original waiter.
Already committed results remain; late replies cannot overwrite native abort.
No cancellation ACK or missing reply proves process exit. Explicit cancellation
retains its bounded target/run/writer in the existing Outbox so a lost Worker or
deleted binding cannot erase that address (ADR-0229). Worker inventory retirement
itself only revokes routing and preserves accepted Guest work, whether the old
management endpoint remains reachable or has disappeared.

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

There is no completed-result GET/cache or PG Tool operation ledger. The Guest
retries the same finalized payload until its original delivery deadline. A scoped,
opaque credential fixes operation, tenant and destination; the Guest cannot select
a Kafka topic or submit control/lifecycle messages. HTTPS verifies the configured
service hostname and CA. Encryption does not prove Guest output truthful.

The independent completion role holds its required PG/S3/Kafka credentials,
externalizes images and acknowledges only after Kafka publication. Previews remain
bounded lossy HTTP/SSE data. The receiver bounds concurrent request memory; source
limits and the 64 MiB image envelope remain. Cube carries only the small process
control exchange. It has no Tool output buffer, completion fallback or admission
manager. The Guest's private SQLite store contains outstanding registrations and
ordered-position boundaries, never finalized results or conversation history.

Reply topic v4 still contains the original boot ID. A replacement restores native
pending-task waiters, replays the protected suffix and then follows live results.
Only the current Session writer can commit the canonical Pi result. Original
deadlines and cancellation targets survive handoff; native terminal settlement
wins over late/duplicate replies. Control Tools retain their specific native
recovery policies. Structured `execution_failure` remains distinct from Tool text.

Chat image preparation uses the same processor through fixed `envd-input-files.mjs`
under the current Run binding. It reads immutable source references, normalizes in
Cube and returns references through the Session execution API, without fabricating an Agent Tool
or changing Kafka dispatch semantics. The same fixed helper writes dedicated-machine
uploads under UID 1000; elastic uploads use the existing Volume Gateway. See
[chat uploads](CHAT_ATTACHMENTS.md) for limits and claims.

The current matched guest/Tool Worker protocol is 7 (see the build manifest). Fixed file/Bash
requests carry binding/operation identity, arguments, timeout and output budget;
workflow requests retain their Turn/Step context checks. No old guest decoder is
kept. Guest input protocol 4 introduced `reap_upload_staging`, retained through the existing
fixed input helper for owned, running development machines. It takes guest-local
filesystem exclusion and consults derived staging locators. Elastic uploads are
maintained by the Volume Gateway; this operation does not allocate/wake a VM or
contribute health/deletion evidence. The current native Tool Worker reply protocol
is 7; managed Cube resource protocol is 10 and Guest executor control is 1. See
[ADR-0235](adr/0235-upload-staging-recovery.md) for staging layout and
[ADR-0307](adr/0307-guest-execution-and-session-activity.md) for the current matched cutover.

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
is created. Kafka credentials remain in the trusted completion service, never in the Guest
or Cubelet. Updates use Guest HTTPS → completion service HTTP → Projector/live
relay SSE, not Kafka history or Worker context. They are collapsed temporary log previews, not durable Tool results.

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

Cube invokes the supported external [Volume Plugin](../deploy/cubesandbox/cube-volume-picloud-posix.sh)
through its normal Master/Cubelet extension interface. The plugin maps a Volume
identity to its persistent Workspace directory and records an opaque attachment
receipt before returning the mount description. Only a matching Detach receipt
releases that hold. A repeated Attach with a lost acknowledgement can retain an
extra hold; missing metadata never means zero references.

The plugin and Volume Gateway share deletion admission. Deletion closes new
attachments and refuses unresolved holds. Native zero-reference counts alone do
not authorize erasing bytes. This is external integration under ADR-0309; the
former private node-reference/incarnation API is no longer part of the contract.

A Workspace-owned Cube runtime may remain warm for one deployment-bounded TTL.
Its processes, sockets and PTYs survive only while that exact runtime
survives. After destruction or failure, a new KVM reattaches the same Volume and
recovers files, not RAM or process state. Warm retention is an optimization,
never a conversation or Workspace durability dependency. User-owned development
machines use the separate pause/resume/release lifecycle and never enter the
elastic warm pool.

The native Cube lifecycle manager owns elastic expiry through the stock timeout API (ADR-0309).
The Worker outer runtime declares logical family resource use through its single
fenced Session Kafka writer, including model/child waits. Execution renews from its
resource view without querying Worker ownership or leases. Cold metadata reads
and binding updates populate the view; missing compute is a no-op. The default
is one declaration per minute and thirty minutes of finite retention. Stale replay
keeps its original timestamp. When renewal stops, expiry may reclaim even an
unfinished Tool. Control Plane has no competing deadline scanner; management still
requires positive provider deletion evidence before releasing allocation/quota records.
Management health reads native status only: periodic Guest probes would refresh
CubeProxy activity and prevent idle expiry.
A user owns an exclusive machine's
lifecycle through authenticated pause/resume/release operations. Controller
restart adopts both elastic and user-owned VMs without changing their physical
state. Destruction is an explicit lifecycle action. A successful native delete or matching
retained native delete event supplies the provider's completion evidence; generic
404, an unreachable node or a missing heartbeat remains uncertain.

## Tool and terminal channels

The fixed Guest control client exposes info, submit, cancel and probe actions
through ordinary envd process/stdin APIs. A probe echoes its UUID and kernel boot
identity without Workspace access or user commands. Direct probes return within
the bounded request; on-demand Session probes return via Guest HTTPS and the
original Kafka mailbox. The Worker registers its waiter before publishing the
probe through Session Kafka. Execution never calls the Worker to prepare a
receiver. Probes do not send timeout renewals, advance Tool positions, create compute
or authorize quarantine/deletion. Stock CubeProxy can count actual Guest traffic
as activity, so only active execution uses on-demand Guest probes. A cancellation ACK does not assert process exit.

There are no native Cube `/execution/*` routes or old-wire fallbacks. Cube/app
upgrades require drained matched publication. The Web Terminal keeps its
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

The provider contract uses native sandbox IDs, separate from PG resource request
IDs. PG authorizes one create send; an encrypted receipt records the native ID and
connection data before Guest initialization. Recovery uses that receipt or unique
native metadata lookup, never another uncertain POST create. Empty/ambiguous
lookup remains pending. A user may have only one unresolved machine application
and cannot pause/release it until its creation outcome is known.

Creation/close allocation extensions and private observation/history APIs are
removed. Cold data connections use retained capsules; connect/resume is not a
health probe. Native provider uncertainty may require operator reconciliation;
exactly-once physical creation is not claimed. The supported Volume Plugin owns
opaque attachment receipts under the trusted Volume envelope. Lost Attach replies
or Detach metadata retain holds; stale Detach cannot release a newer attachment.
Destroy and Attach share deletion admission, and missing hold state is not zero.

Schema 216 removes creation-deadline/protocol fields after old compute retirement;
schema 217 adds provider attribution and observation cursors. No old runtime
capsule reader or private-API fallback is retained. The matched operator retires
known physical addresses without adopting old runtime state, then initializes
attachment directories only during the guarded first stock-provider cutover.

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
