# PiCloud

A self-hosted, multi-tenant coding agent. Pi Durable 1.0.0 runs the native Harness in a shared
Worker pool; file and shell tools execute in isolated CubeSandbox KVM guests.

- Multi-round chat, model switching, hosted search and Subagents.
- Native Pi follow-up/steer within one Run, with editable pending messages,
  ordering, individual removal and promotion to active steer.
  Stop withdraws pending messages and restores their text and attachments to the
  composer for editing, alongside the existing draft.
- Persistent conversations, context compaction and interruption recovery.
- Streaming chat file uploads into Workspace; attached images reach the model directly.
- Elastic Workspaces or dedicated development machines, with file browsing,
  terminals and app previews. Dedicated machines also support SSH.

Self-hosted defaults impose no product quotas on Session counts, concurrency,
Subagent trees or uploaded file sizes/counts. Resource requests, physical VM
specifications, memory-pressure admission and transport/provider limits remain;
see [configuration](docs/CONFIGURATION.md) and [uploads](docs/CHAT_ATTACHMENTS.md).

Operators can follow the [matched release procedure](docs/MATCHED_RELEASE.md)
and optional [conversation/image recovery procedure](docs/ASSET_RECOVERY.md).
The [private pilot criteria](docs/PRIVATE_PILOT.md) distinguish readiness checks
from actual-use and fleet-capacity evidence; the pilot has not started.

## Architecture

```text
Browser -> Control Plane -> PostgreSQL (Run queue/control) -> Pi Worker
Pi Worker <-> Worker-local Model Gateway <-> CLIProxyAPI <-> Model

Pi Worker -> Publication ingress -> Kafka -> Session Projector
                                            +-> PostgreSQL (conversation history)
                                            +-> Browser (SSE)
                                            `-> Cube native execution endpoint

Control state -> PostgreSQL + Outbox -> same ingress/Kafka -> Projector memory views
Cube completion -> boot-scoped Kafka replies -> original Pi Worker

Chat upload -> Control Plane -> Cube Workspace Volume
                            `-> S3 (immutable source images)
```

The maintained source uses two core business tables: Session configuration/state
and Run input/configuration/lifecycle. Initial requests are accepted in PG;
additional messages go to the running Pi native queue and are confirmed after
its Kafka-backed Storage commit. An unavailable Worker leaves the browser draft
unconfirmed. [ADR-0238](docs/adr/0238-native-input-queue-and-run-record.md) is deployed;
the [Worker claim cleanup](docs/adr/0242-worker-claim-schema-cleanup.md) is retained
in the current matched schema 186/application release.

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
share one physical Session lease and writer.
Incomplete local Tool calls stay in Worker memory; complete model responses
enter native persistence before validated Tool execution (ADR-0230).
The [current deployed release](docs/reports/native-live-state-20261012.md) uses
schema 186, guest input protocol 4, Tool Worker protocol 4 and Cube management
protocol 7. Inbox/input metadata and Submissions retain current values without
permanent edit bodies; streaming live bodies no longer accumulate in PG.
Native input/Stop, actual Worker/Projector crash recovery, browser/image and
multi-Conversation checks pass. The report also records broader Cube checks and
model-proxy failures encountered during acceptance. It exercises the
maintained matched release workflow and preserves
the previously deployed [source repairs](docs/reports/review-repair-20261007-r3.md), which
correct quarantine recovery, returned-input identity and oversized-line Read,
and remove unnecessary document-revision queries. Confirmed loss of a user-selected
working directory now returns a native Tool error so the Agent can continue the dialogue.
Real Luna directory restoration, native input/Stop and browser/image/Read checks
pass in the preceding [directory release](docs/reports/working-directory-20261010.md).
The [preceding Worker-claim release](docs/reports/worker-claim-repair-20261010.md)
verifies indexed Worker admission/history reads, removes unused
physical-Session metadata and gives Worker registry/lease references consistent names.
Real Luna native-input/browser tests, cross-Worker restoration and same-Run crash
recovery pass; normal claim still uses nine business SQL statements.
The retained publication-admission repair rejects already-known stale/closed registrations
without SQL; every registration that could succeed still verifies PG. Real Luna
native-input/Stop and Control Plane process-restart acceptance pass.
Earlier cold-VM/preview acceptance, releases, reviews and
the Durable migration remain indexed in [the documentation map](docs/README.md).

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
The API, publication ingress, Projector and sandbox lifecycle controller share
one Control Plane process. Cubelet owns accepted fixed Tool processes and their
Kafka completion delivery. There is no separate Broker service.
Ingress serializes Session writes, control changes and seals; its ordinary Worker
append path uses no SQL. PG remains the Run/control authority. Committed control
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
physical reply does not replace it. Worker replacement preserves the logical Run,
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

One physical Session family stays on one Worker, and each Kafka partition keeps
ordered projection. The single-host profile does not provide physical-node HA.
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
