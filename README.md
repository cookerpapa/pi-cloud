# PiCloud

A self-hosted, multi-tenant coding agent. Pi SDK runs the Agent Loop in a shared
Worker pool; file and shell tools execute in isolated CubeSandbox KVM guests.

- Multi-round chat, model switching, hosted search and Subagents.
- Editable queued messages, ordering, individual removal and promotion to active steer.
  Stop pauses pending messages; new input runs independently, with explicit Send
  or Continue queue to resume old input.
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
through the same Session Kafka path. The original Tool result carries partial
output and cancellation back to Pi; a bounded wait yields UNKNOWN if it cannot be
confirmed. Completed background services and independent process groups survive.
Routing revocation still precedes the final seal. Abnormal retirement carries a
bounded cleanup target in the existing Outbox, without a process-stop receipt
ledger (ADR-0221). Cube's VM/partition progress rejects delayed old submissions.
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
The [follow-up review](docs/reports/repository-review-20261003-r2.md) records
findings and baseline evidence at `3dbf49fb`; [the repairs](docs/reports/review-repair-20261004.md)
track the approved fixes and matched protocol-3 verification.

The [October 4 whole-repository review](docs/reports/repository-review-20261004.md)
records lifecycle/recovery, Pi request-policy and validation gaps with isolated
reproductions and SQL measurements. [The October 5 repairs](docs/reports/review-repair-20261005.md)
close those gaps with staged adoption, PG-time authorization, shared Compaction
policy, structured Tool failures and recoverable Cube Volume reference state.

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
