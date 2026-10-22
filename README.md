# PiCloud

A self-hosted, multi-tenant coding agent. Pi Durable 1.0.0 runs the native Harness in a shared
Worker pool; file and shell tools execute in isolated CubeSandbox KVM guests.

[Guest browser and preview delivery](docs/adr/0270-guest-browser-and-tool-result-actions.md)
is being delivered: the standard image bundles pinned Playwright/Chromium and CJK
fonts for Bash-driven UI checks and native screenshot Read. Successful preview
actions retain their link metadata and remain visible outside collapsed Tool groups.
The serving release below remains current until matched acceptance completes.

- Multi-round chat, model switching, hosted search and Subagents.
  New conversations default to GPT-6.1 Sol; GPT-6 Luna, GPT-6 Astra and DeepSeek
  V4.1 Flash remain selectable. The reviewed catalog and gateway metadata must
  both support a new model; upstream discovery alone does not add a UI choice.
- Native Pi follow-up/steer within one Run, with editable pending messages,
  ordering, individual removal and promotion to active steer.
  Stop withdraws pending messages and restores their text and attachments to the
  composer for editing, alongside the existing draft.
- Persistent conversations, context compaction and interruption recovery.
- Ultra in the effort picker: provider Max plus proactive delegation. Other
  efforts retain explicitly requested delegation. Parent Tool cards show compact
  child progress and navigation, with invocation details closed by default.
- Streaming chat file uploads into Workspace; attached images reach the model directly.
- Elastic Workspaces or dedicated development machines, with file browsing,
  terminals and app previews. Dedicated machines also support SSH.

Self-hosted defaults impose no product quotas on Session counts, concurrency,
Subagent trees or uploaded file sizes/counts. Resource requests, physical VM
specifications, memory-pressure admission and transport/provider limits remain;
see [configuration](docs/CONFIGURATION.md) and [uploads](docs/CHAT_ATTACHMENTS.md).

Operators can use [independent provider/catalog releases](docs/COMPONENT_RELEASE.md),
the [matched procedure](docs/MATCHED_RELEASE.md) for application/protocol changes,
and optional [conversation/image recovery](docs/ASSET_RECOVERY.md).
The [private pilot criteria](docs/PRIVATE_PILOT.md) distinguish readiness checks
from actual-use and fleet-capacity evidence; the pilot has not started.

The current [runtime-capability delivery](docs/reports/runtime-capabilities-delivery-20261021.md)
is `runtime-capabilities-5d39828d`, schema 197. Execution-owned ordinary Control
Tools synchronize to Workers over their existing management connection; the next
prepared model request uses the updated full tool list. Fixed Pi guest Tools and
native child/workflow adapters retain their SDK/lifecycle contracts. Compatible
single-Control-Plane replacement stops the old Pod and waits for its owner lease
before starting/adopting; Workers and Cube continue running.

The preceding [component release delivery](docs/reports/component-release-20261021.md)
introduced independent provider/catalog publication. Model choices/capabilities are deployed
configuration; each accepted Run freezes its settings. Real Luna acceptance keeps
an active Tool/Run, Worker boots and VM intact across provider/catalog updates,
then verifies new-Run settings and physical cleanup. Text/Tools, vision and hosted
search pass. GPT-6.1 Sol remains the default; effective Fast is still unconfirmed.

Management reconnect preserves authorized idle and busy Worker processes across
Control Plane outages. [Current recovery evidence](docs/reports/idle-worker-reconnect-20261014.md)
covers 60/90-second outages and a Control Plane process crash. Full matched
application/schema updates still use the drained release procedure above.

The [resource and interaction repair](docs/reports/resource-interaction-repair-20261020.md)
was delivered as `resource-repair-1cdccb80`, including recoverable direct Subagents,
shared-VM holder protection, Volume evidence, attachment cleanup and connection
lifetimes. Schema 194 / Session topic v18, source/artifact gates, native recovery,
long work, browser, S3 cancellation and full Cube acceptance pass. Single-image
24.2 MB vision/cold recall and the unchanged combined 6/6/25 MB model/cold-recall
gate pass. Failed upstream and model-answer samples remain in the delivery record.
Original configuration and confirmed cleanup are preserved.

## Architecture

```text
Browser -> Control Plane -> PostgreSQL (Run queue/control) -> Pi Worker
Pi Worker <-> Worker-local Model Gateway <-> CLIProxyAPI <-> Model

Pi Worker -> Session Kafka producer -> Kafka -> Session Projector
                                               +-> PostgreSQL (native state/history)
                                               +-> Browser (SSE)
                                               +-> Control Tool handlers
                                               `-> Cube native execution endpoint

Control state -> PostgreSQL + Outbox -> control publisher -> same Kafka partition
Cube/control Tool completion -> boot-scoped Kafka replies -> original Pi Worker

Chat upload -> Control Plane -> Cube Workspace Volume
                            `-> S3 (immutable source images)
```

The maintained source uses two core business tables: Session configuration/state
and Run input/configuration/lifecycle. Initial requests are accepted in PG;
additional messages go to the running Pi native queue and are confirmed after
its Kafka-backed Storage commit. An unavailable Worker leaves the browser draft
unconfirmed. [ADR-0238](docs/adr/0238-native-input-queue-and-run-record.md) is deployed;
the [Worker claim cleanup](docs/adr/0242-worker-claim-schema-cleanup.md) is retained
in the current schema 197 runtime.

The intake path shares its locked Session and request lookup between
routing and Run creation: eight ordinary business SQL statements, two on an
initial-request retry, with no cross-request cache
([ADR-0240](docs/adr/0240-transaction-scoped-input-admission.md)).

Native tasks, submissions, entries and documents use one atomic commit stream.
Kafka RF3 confirms each prepared commit before the Worker adopts it. PostgreSQL
stores native history and authoritative current Inbox/input/Submission values,
with rebuildable indexes for cold reads
([ADR-0243](docs/adr/0243-native-input-current-state.md)). In-flight `pi.live` bodies
stay in Kafka; PG keeps small commit headers and exact settlement/handoff checkpoints
([ADR-0244](docs/adr/0244-kafka-backed-native-live-state.md)). Native Conversations
share one physical Session lease and writer. Assistant display descriptions now
travel in the same native commit, referencing its text instead of publishing a
second copied body ([ADR-0245](docs/adr/0245-native-commit-text-presentation.md));
[rollout status](docs/reports/native-text-presentation-20261012.md) is tracked separately.
Incomplete local Tool calls stay in Worker memory; complete model responses
enter native persistence before validated Tool execution (ADR-0230).
The [Session work migration](docs/adr/0247-session-work-and-tool-dispatch.md) is
deployed as `session-work-6ac697f9`: one root Run with native child Conversations,
unified Tool replies, one Session closure and Worker direct Kafka publication.
The preceding `resource-repair-1cdccb80` release used schema 194, execution-topic
v18, boot reply v3, guest/Tool Worker protocol 7, completion startup protocol 3,
preview schema 2 and Cube management protocol 7. Host KVM is available; templates
and application workloads are ready. The preceding [model response/lifetime repair](docs/reports/model-runtime-repair-20261020.md)
removes the overall Agent duration limit and fixed model-grant TTL. Grants follow
existing ownership; Worker retirement remains bounded and resumes the same Run.
One Models adapter preserves native retry classification, text phases and completed
hosted searches; Gateway transport metrics are separate from model outcomes.
A real 16-minute Run, graceful Worker handoff, native/browser/child/outage/image
and full Cube gates passed on that preceding release. Its report retains one failed model-generated repeat
delegation sample and the unchanged passing repeat. Physical cleanup and original
configuration preservation are confirmed.
The [Worker/Harness recovery repair](docs/reports/worker-harness-recovery-repair-20261019.md)
bounds and cancels native data reads, indexes pending Submissions and reattaches
existing children without another prompt/configuration commit. Native/browser,
child Worker recovery, Control Plane outage, 6/6/25 MB image cold recall and full
Cube acceptance pass. Owned resources are cleaned and original configuration is
preserved. Image hydration retains per-decode validation because Pi's public hooks
start after context reads.
The [Session seal projection repair](docs/reports/seal-projection-repair-20261019.md)
bounds projection PG I/O, retires closed-writer live views after lost commit
returns, limits checkpoint proof reads to pending ranges and reuses the locked
Run. The measured recovery transaction uses 19 business SQL statements instead
of 20. Source/artifact and native/browser/child/outage/full-Cube gates pass.
That release's large-image cold recall remained unaccepted after model
response-header timeouts; the current recovery release passes the unchanged gate.
Owned fixtures are physically cleaned and original configuration is preserved.
Failed upstream samples remain recorded separately. Docker's persistent build
proxy now uses the active port.
The [Session seal publication repair](docs/reports/seal-publication-repair-20261019.md)
bounds control-publication PG work, joins borrowed group transactions before
consumer disposal and rediscovers failed cached peers through existing Outbox
retries. Source, RF3, native/image/child/outage and full Cube acceptance pass;
owned fixtures are cleaned and original configuration is preserved. Initial
upstream TLS failures and slow image requests remain documented separately.
The [Control Plane expiry repair](docs/reports/control-plane-expiry-repair-20261018.md)
advances past busy Sessions and pending seals, admits failed Workers into existing
retirement even with live management connections, and removes healthy-Session
cleanup from expiry. One-expiry SQL stays at 13 statements for 1/8/64 Sessions;
management scans are separate. Live recovery, images, child handoff and full Cube
acceptance pass, including 63.8 seconds without a Control Plane while both Worker
Boots and the active lease remain unchanged. Initial test corrections and one
upstream TLS/EOF sample remain documented.
The [Session lease repair](docs/reports/session-lease-repair-20261018.md) enforces
local deadlines independently of pending PG reads, revokes locally before waiting
for quarantine, and renews healthy Sessions without waiting for another Session's
row lock. Ordinary batch renewal remains three business SQL statements. Real
acceptance preserves both Worker Boots and the active lease through 65 seconds
without a Control Plane; source, image, child and full Cube checks pass.
The [browser delivery repair](docs/reports/projector-browser-repair-20261018.md)
uses the existing execution generation to refresh Working/VM observations after
Worker replacement. Pending SSE delivery has byte and count guards with snapshot
recovery, and same-message commentary compacts in the live cache. Real recovery
keeps one SSE connection across generation 1 → 2; source, browser, image, child
and Cube checks pass. Reload open pages for the matched observation schema.
The [Session completion repair](docs/reports/session-publication-completion-repair-20261018.md)
restores the persisted terminal notification on replay after a lost PG commit reply.
Proved pre-send refusal reaches native Pi without unnecessarily aborting the shared
Session; uncertain or post-ACK failure still interrupts its writer. Normal completion
reuses one locked Run read instead of three. This does not add automatic retries or
preserve an uncommitted Tool Result after native rejection.
The [native settlement repair](docs/reports/worker-harness-settlement-repair-20261018.md)
uses Pi's 50 KiB/2,000-line defaults for coordination result text, with explicit
errors for oversized structured results. Sequence-only reads no longer fetch
history bodies/images, and native/packed Tool replies have strict content schemas.
Real Luna/Cube checks cover boundary errors, supervisor replies, images, Stop,
Worker/Control Plane recovery and the full Workspace/preview suite.
The [Worker reply repair](docs/reports/worker-reply-repair-20261017.md) adds local
reply-consumer health to new-Run admission, resumes same-boot reply delivery from
memory and distinguishes attachment failure from missing execution evidence.
The local WSL web adapter also restores Windows localhost access through the
existing systemd TCP proxy and the Kubernetes web Service.
The [preceding preview repair](docs/reports/tool-receipt-preview-repair-20261016.md)
records its earlier scanned artifacts, recovery and acceptance samples.
Current source implements [ADR-0252](docs/adr/0252-tool-receipt-and-ephemeral-preview.md):
receipt-only loss preserves confirmed results; bounded CR/ANSI-aware previews send
incremental edits and periodic resets over HTTP/SSE, independently of final results.
[ADR-0249](docs/adr/0249-compact-projector-publication.md) compacts shared publication
identity and derives Tool presentation from the same native commit. Private
projection prefixes keep sequence/identity only, and fixed Tool requests omit
workflow-only context fields. [Repair and acceptance evidence](docs/reports/projector-repair-20261015.md)
records source verification, the matched deployment and live checks.
[ADR-0250](docs/adr/0250-cube-handoff-outcomes-and-runtime-admission.md) separates
failure notification from quarantine, uses exact binding lookups and prevents late
requests from recreating admission state after confirmed VM removal.
[Handoff repair and acceptance](docs/reports/projector-cube-handoff-repair-20261015.md)
records that preceding release, real Luna/Cube/browser/child recovery and cleanup.
[ADR-0251](docs/adr/0251-guest-attachment-and-execution-bounds.md) gives ordinary
Tools a small execution attachment, aligns Read paths with Pi, bounds final native
cleanup and refuses known-expired work before Start. The
[guest-6 delivery record](docs/reports/cubelet-guest-execution-repair-20261015.md)
includes the guest 6 rollout, real path/image/child recovery and preserved configuration.
[Implementation and acceptance evidence](docs/reports/session-work-implementation-20261013.md)
records source tests, real Luna/Cube/browser checks and rolling-update findings.
Each active physical Session adds a native Kafka producer; the
[bounded comparison](docs/reports/session-work-transport-20261014.md) records both
the latency improvement and its thread/connection cost. It is not a fleet-capacity claim.
Earlier releases remain indexed in [the documentation map](docs/README.md).

Whole file/shell Tools execute in Cube. Replies return through the separate
Worker-boot Kafka transport; Pi processes them before publishing the canonical
Tool Result to the Session log. Optional temporary logs go through Projector HTTP/SSE.
Workspace files live on persistent Cube Volumes.
Physical allocation uses a stable identity and frozen creation authorization.
Cube records its VM/node before launch; lost replies resolve through that same
allocation. Retirement closes creation admission before confirming node absence,
so a delayed creation cannot reopen a released allocation (ADR-0223).
Images used by the Agent are immutable Session attachments in private S3 storage;
Kafka carries their references and Pi receives ordinary image content.
The API, control publisher, Projector and sandbox lifecycle controller share
one Control Plane process. Cubelet owns accepted fixed Tool processes and their
Kafka completion delivery. There is no separate Broker service.
Worker commits bypass the Control Plane. Producer initialization verifies PG authority
before and after Kafka takeover; ordinary native commits use no SQL or HTTP hop.
Normal `work_finished` projects the root outcome and voluntary writer retirement;
forced recovery retains one ordered Session seal. PG remains the Run/control authority. Committed control
references refresh bounded binding, queued-input and Subagent views. Tool/probe
routes read owner memory; pending inputs use SSE and relevant work wakes on changes
or known deadlines. Worker admission uses the available publication partitions;
binding bootstrap pages only the owner’s state. Transaction-local queue/state
notifications are coalesced, and independent Outbox sends prevent a slow request
from holding an entire batch. Lifecycle mutations and recovery retain PG checks.
The projection path combines Run/writer validation into one SQL read and
skips unchanged replay updates while retaining authority locks
([ADR-0239](docs/adr/0239-projection-query-and-replay-writes.md)). Commentary and
final-answer text share the typing animation; restored history displays immediately.
Chat Stop interrupts the Worker Agent and sends operation-scoped cancellation
through the same Session Kafka path. Durable records the native abort; a late
physical reply does not replace it. During startup, Stop is retained through
authorized writer initialization; Pi opens with effects blocked to settle it.
Worker replacement preserves the logical Run,
Turn and native input, resuming only after old-writer closure and a new PG lease.
Unsafe interrupted Tools are reported to the model without automatic replay. Completed background services and independent process groups survive.
Routing revocation still precedes the final seal. Abnormal retirement carries a
bounded cleanup target in the existing Outbox, without a process-stop receipt
ledger (ADR-0221/0229). Cube's VM/partition progress rejects delayed old submissions.
Queue display refreshes coalesce outside ordered projection, using a separate
two-connection read pool. Responses carry 20 inputs per page; all queued inputs
remain accessible, with drafts preserved when queue changes invalidate a page.
Control references carry identities and revisions; changed views can still read
PG. This is not a complete copy of control state inside Kafka.

Canonical conversation output is durable before display. Runtime activity, Tool
previews and health observations are disposable. Control Plane probes existing
VMs directly and reuses confirmed execution-path evidence; missing probes do not
authorize VM destruction or quota release. Recovery never automatically replays
uncertain commands. Quarantine closes PG bindings before confirming propagation,
so a publication outage cannot leave a failed VM eligible for new work.
The [chat status display](docs/reports/run-status-presentation-20261021.md) shows
the current phase and connection/update-delay warnings; diagnostic confirmation
ages are collapsed by default.
Fixed Tool reply waits use that invocation's execution budget plus the existing
120-second transport allowance. An eligible lost reply remains UNKNOWN; a fresh,
bounded path check can allow a separate inspection Tool. An unconfirmed path or
repeated uncertainty interrupts the Run. Probe traffic stays outside native
history and model context. [Implementation and acceptance](docs/reports/tool-reply-continuation-20261016.md)
record the limits and verified failure cases.

One physical Session family stays on one Worker, and each Kafka partition keeps
ordered projection. The single-host profile does not provide physical-node HA.
An active Cubelet crash can leave Volume references unconfirmed; automatic GC
then remains blocked pending positive operator recovery
([tracked limit](docs/BACKLOG.md#cubelet-restart-and-unconfirmed-volume-references)).
Original images stream to Cube for normalization; native context still
materializes normalized image content.
Cube mounts, configuration and completion credentials are rendered into one
Helm release before deployment, with native-version and source-identity checks.
Template and artifact cleanup follows stable node identity through current
discovery, so Pod address changes do not strand historical replicas.
See the [architecture and failure boundaries](docs/ARCHITECTURE.md).

## Quick start

Requires x86_64 Debian/Ubuntu or WSL2 with systemd, writable `/dev/kvm`,
at least 16 GiB RAM and 40 GiB free disk. Intended for private deployments.

```bash
./install.sh --check-only
./install.sh
```

1. Open `http://127.0.0.1:8080` and register an account.
2. Promote your administrator account (restarts Control Plane):

   ```bash
   npm run production:administrator -- --username <username>
   ```

3. Open `http://127.0.0.1:8081` to configure model routes and Cube networking.
   Add model credentials through the linked Provider Gateway; its management key
   is available with `npm run production:provider-gateway:key`.
4. Return to the chat page, create a Workspace and send a task. For a dedicated
   machine, request one under **开发资源** first. Pure chat needs no sandbox.

Configuration and secrets are stored in the private `deploy/production/runtime/`
directory. All runtime services run in K3s; Docker is used for image builds.
Services track Pod replacement automatically. See the guides below for upgrades,
public access and distributed deployment.

## Documentation

[Deployment & upgrades](docs/PRODUCTION_DEPLOYMENT.md) ·
[Configuration](docs/CONFIGURATION.md) · [Kubernetes](docs/DISTRIBUTED_DEPLOYMENT.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Tests](docs/EVALUATION.md) ·
[More docs](docs/README.md)
