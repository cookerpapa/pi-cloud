# PiCloud

A self-hosted, multi-tenant Cloud Coding Agent built on Pi's public SDK.
Pi runs in a trusted Worker pool; model-generated file and shell operations run
in CubeSandbox KVM microVMs. Provider credentials stay in CLIProxyAPI, outside
the guest environment.

## Features

- Chinese/English Web UI, native multi-round conversations, Compaction, Fork,
  tree navigation, Steer and cursor-free streaming recovery;
- per-conversation Provider/model/reasoning settings and GPT Fast mode, frozen
  for each accepted Turn; native Web Search on verified GPT/DeepSeek routes;
- recursive Subagents with bounded depth and concurrency: inherited or empty
  Lanes share a physical Pi Session, with shared or isolated Workspaces;
- elastic Workspaces and named, user-owned development machines;
- live file browsing, Web Terminal, machine SSH and authenticated application previews;
- optional GitLab Issue intake and environment-local GitLab/GitHub credentials;
- replaceable Workers, PostgreSQL Run scheduling and Kubernetes/KEDA deployment.

This targets private or controlled enterprise deployments, not hostile public SaaS.
Recovery preserves conversation meaning and reports uncertain Tool effects;
it does **not** automatically replay arbitrary shell commands or restore lost process memory.

Subagent control requests follow the ordered Kafka log. Workflow JavaScript runs
inside Cube, never in the trusted Worker or Projector. See [Subagents](docs/SUBAGENTS.md)
for the execution contract and its recovery limits.

## Architecture

```mermaid
flowchart TD
  B["Browser / admin UI"] <--> E["Caddy: app / admin / isolated preview origins"]
  subgraph CP["Control Plane replicas — API and Projector share a process"]
    API["Auth / Run admission / resources / model settings"]
    P["Session Projector — one Kafka consumer group"]
    SC["Subagent controller: admission / mailbox / result delivery"]
    O["Seal Outbox relay"]
    G["Web Terminal / isolated Preview gateways"]
  end
  E -->|"REST"| API
  E <-->|"Terminal / Preview"| G
  P -->|"snapshot-first SSE"| E
  PG[("PostgreSQL: Run queue + Session Lease/Fence<br/>native Session log + query projections")]
  API --> PG
  PG --> O
  subgraph WPOOL["Trusted Pi Worker pool"]
    W["Session-family slots + Native Session Host<br/>concurrent Lanes / fair model permits"]
    M["Local Model Gateway"]
    W --> M
  end
  PG -->|"Workers claim; cold context restore"| W
  W -.->|"registration / control channel"| API
  W -->|"one owner-lease renewal per active Session"| PG
  M --> C["CLIProxyAPI — provider credentials"]
  C --> L["GPT / DeepSeek + hosted search"]
  W -->|"direct append; acks=all"| K[("Kafka — RF=3")]
  O -->|"ordered execution seals"| K
  K --> P
  P -->|"semantic records + progress"| PG
  P -->|"ordered Subagent facts"| SC
  SC <-->|"durable child Run / mailbox state"| PG
  SC <-->|"Lane preparation / control / result notifications"| W
  P -->|"Tool commands / seal / result receipt"| TB["Tool Broker"]
  TB <-->|"owner-direct results / workflow duplex IO"| W
  API -->|"resource lifecycle"| TB
  G --> TB
  S["SSH client"] --> SG["SSH Gateway"] --> TB
  TB --> CC["Cube control plane<br/>internal MySQL / Redis"]
  CC --> VM["Cubelet / KVM microVM"]
  VM <--> V["Cube Volume Plugin / persistent POSIX storage"]
  TB --> VG["Workspace Volume Gateway"] --> V
  GL["Optional GitLab Issue intake"] -.-> API
```

Solid arrows show logical calls or data flow, not additional services. Workers
claim child Runs from the same PG queue as ordinary Runs; the Subagent controller
wakes the owning Worker but does not run another scheduler. Workflow scripts run
inside Cube and send `runs.*` requests back through the Worker → Kafka path.
Operator monitoring and one-host network relays are optional/supporting paths,
not transcript storage or execution authorities.

PostgreSQL accepts user inputs and owns Run scheduling and execution authority.
Workers pull ready Runs; notifications only reduce queue latency. A cold Session
occupies no slot. Active Lanes share one physical Session writer and owner lease
on one Worker. The family occupies one slot; model requests use a separate fair
concurrency budget, released before waiting for Tools/children. The Harness consumes a `SessionStorage`
port: active context is an acknowledged in-memory view; cold recovery loads the
latest Compaction and active suffix, not lifetime JSONL.

Workers stamp native records before appending directly to Kafka. One partitioned
Projector group checks recorded openings/seals, projects complete semantic data to
PG, maintains the live view, and routes Tool commands to the owning executor.
There is no Fact Gateway, second scheduler, separate live/Tool consumer group,
record signature or per-token PG authority query. Ordinary Steps return at Kafka
ACK rather than waiting for a PG projection receipt.

A browser opens a materialized snapshot of complete history plus pending output,
then receives new SSE events. Complete native messages and display coverage commit
together, allowing covered fragments to leave memory before Run end. Snapshots are
framed; interrupted values are discarded. The browser holds no Kafka cursor.
Requests on a non-owning API replica proxy to the partition owner. History opens
on the latest 40 Turns and older pages load on demand.

Complete model output and validated Tool intent have separate native durability
boundaries. Concrete commands also require Kafka publication and Broker admission;
the Projector does not wait for guest execution. Raw results return to the Worker
for Harness processing, then the native Tool Result follows the same Kafka path
and retires the Broker's bounded retry copy. Platform Tools and provider-hosted
search do not become arbitrary guest shell commands.

At settlement, PG requests an ordered Kafka seal. Projector commits the terminal
and any uncovered interrupted text before a successor can restore context. Late
records after closure cannot affect history, UI or new Tool dispatch. Already-issued
Cube effects may remain UNKNOWN: this is semantic recovery, not exactly-once shell
execution or restoration of lost process memory. Kafka retention follows safe PG
recovery progress plus a grace interval; token fragments do not become PG rows.

Workspace files belong to persistent Cube Volumes. Development-machine snapshots
are node-affine; deleting compute does not delete conversations. Cube's internal
MySQL/Redis manage Cube, not PiCloud Runs. Provider account credentials remain in
CLIProxyAPI. Optional GitLab and Prometheus/Grafana/Alertmanager/Jaeger integrations
are outside the core scheduling/log authorities. One-host relays supply network
reachability, not additional event-processing stages.

See [Architecture](docs/ARCHITECTURE.md), [Run lifecycle](docs/RUN_LIFECYCLE.md),
[stream durability](docs/STREAM_DURABILITY.md) and
[deployment](docs/PRODUCTION_DEPLOYMENT.md) for implementation boundaries.

## One-host deployment

Requirements: x86_64 Debian/Ubuntu or WSL2 with systemd, writable `/dev/kvm`,
at least 16 GiB RAM and 40 GiB free disk.

```bash
./install.sh --check-only
./install.sh
```

The installer can supply Docker, K3s, Node.js, Helm and the pinned Cube runtime.
It does not request model credentials or administrator passwords.

1. Open `http://127.0.0.1:8080` and register an account.
2. Promote the administrator, then restart Control Plane:

   ```bash
   npm run production:administrator -- --username <registered-username>
   ```

3. Open the administrator site at `http://127.0.0.1:8081`. Configure model routes
   and Cube networking; follow its link to the Provider Gateway on port `8318`
   for subscription/API credentials. Retrieve the management key with
   `npm run production:provider-gateway:key`.
4. Create an elastic Workspace or a cloud development machine under **开发资源**,
   then start a conversation. Pure chat does not activate Cube.

Optional Code Host credentials are written to the selected environment, not the
conversation database. GitLab Issue intake is separate, deployment-controlled
integration. Users select a Workspace and explicitly start the ordinary Run;
the Agent clones the repository and only commits/publishes/closes Issues when
asked. See [the GitLab lab](deploy/gitlab/README.md).

Application previews use an authenticated, isolated `*.preview.localhost` origin
and support HTTP/WebSocket streaming, Vite and HMR. For remote deployment,
configure wildcard DNS/TLS for `*.preview.<application-host>`; a guest's localhost
is never the user's public application URL. SSH is available for user-owned machines.

Configuration and credentials live under the private `deploy/production/runtime/`
directory. Read [configuration](docs/CONFIGURATION.md) and
[deployment](docs/PRODUCTION_DEPLOYMENT.md) before changing public addresses,
storage, timeouts or capacity.

```bash
npm run production:ps
npm run production:logs
npm run production:config
npm run production:up:observability
npm run production:backup
npm run production:restore
npm run production:down
```

**Existing installations:** this pre-release protocol cutover is not a rolling
upgrade. Drain Runs, project all seals/Outbox, back up and release old runtime
instances, then stop the old execution services. Apply migration 137 and deploy
matching Worker, Control Plane/Projector and Broker images. New records use the
v8 Kafka topic and task execution references; there is no old-wire decoder.
PG semantic history, identities and configuration are not reset by migration.
Remove the retired v7 topic only after confirming its complete projection.

## Kubernetes

The Helm chart expects external PostgreSQL/PgBouncer, Kafka, shared Workspace
storage and Cube control/compute authorities. Replace the example endpoints,
images, UUIDs and CIDRs before deployment:

```bash
cp deploy/helm/pi-cloud-platform/values.distributed.example.yaml values.yaml
npm run kubernetes:distributed:render -- --values values.yaml
npm run kubernetes:distributed:preflight -- --values values.yaml
npm run kubernetes:distributed:deploy -- --values values.yaml
```

KEDA scales Worker replicas from active/starting/ready Session families; PostgreSQL claim remains
the only scheduler. See [distributed deployment](docs/DISTRIBUTED_DEPLOYMENT.md).

## Verification

```bash
npm ci --ignore-scripts
npm run dependencies:harden
npm run check
npm run runtime-policy:check
npm run helm:check
```

Live checks consume model tokens and Cube capacity and require explicit opt-in:

```bash
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
PI_CLOUD_LIVE_SUBAGENT_CHECK=1 npm run production:subagents-check
PI_CLOUD_LIVE_LONG_CONTEXT_CHECK=1 npm run production:long-context-check
PI_CLOUD_LIVE_SNAKE_PREVIEW_CHECK=1 npm run production:snake-preview-check
```

[Evaluation](docs/EVALUATION.md) lists the wider suite. Reports are evidence for
their named revision and topology, not timeless throughput or HA guarantees.

## Documentation

[Map](docs/README.md) · [Configuration](docs/CONFIGURATION.md) ·
[Threat model](docs/THREAT_MODEL.md) · [Cube](docs/CUBESANDBOX_PROVIDER.md) ·
[Subagents](docs/SUBAGENTS.md) ·
[ADRs](docs/adr/README.md) · [Roadmap](docs/ROADMAP.md) · [Backlog](docs/BACKLOG.md)
