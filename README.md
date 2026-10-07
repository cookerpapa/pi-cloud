# PiCloud

A self-hosted, multi-tenant coding agent. Pi Durable 1.0.0 runs the native Harness in a shared
Worker pool; file and shell tools execute in isolated CubeSandbox KVM guests.

- Multi-round chat, model switching, hosted search and Subagents.
- Editable queued messages, ordering, individual removal and promotion to active steer.
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

Native tasks, submissions, entries and documents use one atomic commit stream.
Kafka RF3 confirms each prepared commit before the Worker adopts it. PostgreSQL
stores the native body once, with rebuildable record/document indexes for cold
reads. Native Conversations share one physical Session lease and writer.
Incomplete local Tool calls stay in Worker memory; complete model responses
enter native persistence before validated Tool execution (ADR-0230).
See [Durable migration and verification](docs/reports/pi-durable-migration-20261006.md).
The [post-migration repository review](docs/reports/repository-review-20261006.md)
records the baseline findings. [Source repairs and validation](docs/reports/review-repair-20261006.md)
cover recovery, file locking, query costs and guest dependency reduction.
The [matched schema 181 release](docs/reports/review-release-20261006.md) is deployed
with real Luna, native Fork, Subagent, upload and cold-Worker acceptance.
The [October 7 source repairs](docs/reports/review-repair-20261007.md) preserve
send identity after a lost response, validate reused guest provenance, page Session
headers before counting history, and allow concurrent Volume browsing/uploads
with exclusive deletion. The [schema 182 rollout](docs/reports/review-release-20261007.md)
is deployed, with real browser retry/concurrent-upload and Luna Tool/image acceptance.

The [post-release source repairs](docs/reports/review-repair-20261007-r2.md)
unify ordinary/Steer submission identity, isolate partition progress guards,
recover abandoned upload staging and preserve EXIF image orientation.
These source changes require a matched Gateway/guest-protocol-4 rollout;
they have not replaced the deployed schema-182 application release above.

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
The [review and repair record](docs/reports/review-repair-20261003.md) records
verified behavior and remaining limits. Original images stream to Cube for
normalization; native context still materializes normalized image content.
Cube mounts, configuration and completion credentials are rendered into one
Helm release before deployment, with native-version and source-identity checks.
Template and artifact cleanup follows stable node identity through current
discovery, so Pod address changes do not strand historical replicas.
See the [deployed cleanup repair](docs/reports/template-cleanup-20261007.md).
The [follow-up review](docs/reports/repository-review-20261003-r2.md) records
findings and baseline evidence at `3dbf49fb`; [the repairs](docs/reports/review-repair-20261004.md)
track the approved fixes and matched protocol-3 verification.

The [October 4 whole-repository review](docs/reports/repository-review-20261004.md)
records lifecycle/recovery, Pi request-policy and validation gaps with isolated
reproductions and SQL measurements. [The October 5 repairs](docs/reports/review-repair-20261005.md)
close those gaps with staged adoption, PG-time authorization, shared Compaction
policy, structured Tool failures and recoverable Cube Volume reference state.

The [October 5 follow-up review](docs/reports/repository-review-20261005.md)
covers the current 22 workspaces and matched Cube release. It records four new
behavior findings, a documentation inconsistency, isolated reproducers and SQL
counts. The [approved improvements](docs/reports/review-improvements-20261005.md)
track recovery isolation, consistent Tool outcomes, eight large-reply permits
and matched verification/release status.

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
