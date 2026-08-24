# PiCloud

PiCloud is a self-hosted, multi-tenant Cloud Coding Agent built on the Pi SDK.
Pi and model credentials run in a trusted Worker pool; model-generated file and
shell operations run in CubeSandbox KVM microVMs.

## What you get

- browser registration/login and tenant-isolated conversations;
- per-browser Chinese/English UI selection without translating prompts, Tool output or model replies;
- multi-round Pi Sessions, native Compaction, tree navigation, Fork and Steer;
- durable recursive Subagents with bounded depth/concurrency;
- named Workspaces, source browsing, Web Terminal and authenticated service preview;
- elastic Sandboxes or user-owned full-VM Cube environments with root SSH/terminal access;
- resumable SSE whose visible bytes were acknowledged by Kafka first;
- horizontally replaceable Pi Workers and Kubernetes/KEDA deployment support.

PiCloud targets private or controlled enterprise deployments. It is not a
hostile public-SaaS security or abuse-management product.

## Architecture

```text
Browser ──REST/SSE──> Control Plane ──> PostgreSQL Run queue
                                             │
                                      shared Pi Workers
                                      Pi SDK / Agent Loop
                                             │ fenced Tool RPC
                                             ▼
                                         Tool Broker
                                             │
                                             ▼
                                      CubeSandbox KVM
                                elastic Volume / exclusive VM state

Worker events ──> Raw Kafka ──fence check──> Accepted Kafka ──> SSE
complete Pi entries ──> Session Mutation Kafka ──> PostgreSQL
```

There are three durable authorities:

- PostgreSQL owns product state, the Run queue and canonical Pi Sessions;
- Kafka owns the bounded hot event log used for live replay;
- a persistent Cube Volume owns elastic Workspace bytes; Cube pause state owns
  an exclusive machine's guest root, memory and processes on its compute node.

Any healthy Worker may run a Session's next message. RunAttempt leases and
fencing tokens reject stale effects; no Session is permanently assigned to a
process. See [Architecture](docs/ARCHITECTURE.md),
[Run lifecycle](docs/RUN_LIFECYCLE.md) and
[stream durability](docs/STREAM_DURABILITY.md) for the detailed contracts.

## One-host quick start

Requirements: a clean Git checkout on x86_64 Debian/Ubuntu or WSL2 with
systemd, writable `/dev/kvm`, at least 8 GiB RAM and 40 GiB free disk.

```bash
./install.sh --check-only
./install.sh
```

The installer can supply Docker, K3s, Node.js, Helm and the pinned Cube source.
It never asks for a model key or administrator password.

After deployment:

1. Open `http://127.0.0.1:8080` and register the platform administrator.
2. Promote that registered account and restart the Control Plane:

   ```bash
   npm run production:administrator -- --username <registered-username>
   ```

3. Sign in again and configure the provider, model, encrypted API key and Cube
   proxy in the administrator page.
4. Open **开发资源** to create Workspaces or an optional exclusive environment.
5. Start a conversation in either mode:
   - **Elastic execution** selects/creates a Workspace and chooses a deployment-owned size;
   - **Exclusive environment** selects a running user-owned Cube and a live
     directory from its complete guest filesystem; its GNOME-style folder
     chooser can create a user-writable directory before selection.

The language selector is available on the sign-in page and beside the current
username. It is a browser-local presentation preference: switching it does not
modify Session context, system prompts, user messages or Agent output.

Service preview is a same-origin HTTP proxy to any unprivileged HTTP port inside
the active Cube. When the Agent reports a `localhost` application URL, the Web
client opens it through the authenticated PiCloud gateway; Cube addresses and
public port mappings are never exposed to the Agent. SSH is available only for
exclusive environments, only while no Agent Run or browser terminal owns the
environment, and each password can be used once.

Re-running `./install.sh` reconciles the same private runtime. Generated
credentials and state live under `deploy/production/runtime/` by default and
must never be committed.

Common operations:

```bash
npm run production:ps
npm run production:logs
npm run production:config
npm run production:backup
npm run production:restore
npm run production:down
```

See [one-host deployment](docs/PRODUCTION_DEPLOYMENT.md) and
[configuration](docs/CONFIGURATION.md) before changing bind addresses,
registration quotas, retention, SSH or Sandbox capacity.

## Distributed Kubernetes deployment

The Helm chart expects external PostgreSQL/PgBouncer, Kafka, ReadWriteMany
Workspace storage and Cube control/compute authorities. Copy and replace every
example endpoint, image, UUID and CIDR before preflight:

```bash
cp deploy/helm/pi-cloud-platform/values.distributed.example.yaml values.yaml
npm run kubernetes:distributed:render -- --values values.yaml
npm run kubernetes:distributed:preflight -- --values values.yaml
npm run kubernetes:distributed:deploy -- --values values.yaml
```

KEDA scales Worker replicas from PostgreSQL ready-Run backlog; database claim
and fence logic remains the scheduling authority. See
[distributed deployment](docs/DISTRIBUTED_DEPLOYMENT.md).

## Verification

Deterministic, zero-token checks:

```bash
npm ci --ignore-scripts
npm run dependencies:harden
npm run check
npm run runtime-policy:check
npm run helm:check
```

Live checks consume model tokens and Cube capacity, so each requires an
explicit acknowledgement:

```bash
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
PI_CLOUD_LIVE_PRODUCT_SURFACE_CHECK=1 npm run production:product-surface-check
PI_CLOUD_LIVE_SNAKE_PREVIEW_CHECK=1 npm run production:snake-preview-check
PI_CLOUD_LIVE_BROWSER_UI_CHECK=1 npm run production:browser-ui-check
PI_CLOUD_LIVE_DIRECTORY_PICKER_CHECK=1 npm run production:directory-picker-check
PI_CLOUD_LIVE_WORKER_POOL_CHECK=1 npm run production:worker-pool-check
PI_CLOUD_LIVE_SUBAGENT_CHECK=1 npm run production:subagents-check
PI_CLOUD_LIVE_DEVELOPMENT_ENVIRONMENT_CHECK=1 npm run production:development-environment-check
PI_CLOUD_LIVE_LONG_CONTEXT_CHECK=1 npm run production:long-context-check
```

Reports under `docs/reports/` are evidence for their named revision and test
topology, not timeless capacity or HA claims. See [Evaluation](docs/EVALUATION.md).

## Documentation

- [Documentation map](docs/README.md)
- [Configuration](docs/CONFIGURATION.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Cube provider](docs/CUBESANDBOX_PROVIDER.md)
- [Current ADRs](docs/adr/README.md)
- [Roadmap](docs/ROADMAP.md) and [backlog](docs/BACKLOG.md)
