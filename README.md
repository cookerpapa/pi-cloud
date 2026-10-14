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

Management reconnect preserves authorized idle and busy Worker processes across
Control Plane outages. [Current recovery evidence](docs/reports/idle-worker-reconnect-20261014.md)
covers 60/90-second outages and a Control Plane process crash. Full matched
application/schema updates still use the drained release procedure above.

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
in the deployed schema 188 / execution-topic v16 release.

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
The matched contracts are schema 188, execution-topic v16, boot reply v3,
guest input protocol 4, Tool Worker protocol 4 and Cube management protocol 7.
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
