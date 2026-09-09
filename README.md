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

## Architecture

```text
Browser ── Caddy ── Control Plane
                     ├─ authentication, conversations, resources, model settings
                     ├─ PostgreSQL: durable Run queue + ExecutionLease/Fence
                     └─ snapshot-first SSE / Terminal / isolated Preview gateway

PostgreSQL Run queue
  └─ claim by a free Pi Worker (SKIP LOCKED + LISTEN/NOTIFY)
       └─ Native Session Host
            ├─ cold bootstrap: latest Compaction + active suffix from PG
            ├─ concurrent main/Subagent Lane Agent Loops
            ├─ one ordered native log writer per active physical Session
            └─ model requests → local Model Gateway → CLIProxyAPI → Provider

Pi semantic records + display events + concrete Tool commands
  └─ multiplexed Worker Fact connection
       └─ Authority Gate (current ExecutionLease)
            └─ Kafka: physical-Session key, RF=3, acks=all
                 ├─ canonical projector → PG native log + query projections
                 │                        + terminal/commit Outbox
                 ├─ live-tail consumer → immutable snapshot + SSE → Browser
                 └─ Broker consumer group → owner routing → Tool executor → Cube KVM
                                             raw result → Worker/Pi → same Fact path

Run settlement → PG Outbox → Kafka execution seal
  → canonical closure → PG Outbox → Kafka commit notification → Browser
```

The Harness consumes a `SessionStorage` port. Its active writer assigns immutable
Entry/Record IDs, parents, sequences and timestamps **before** publication, and
returns after Kafka ACK. PostgreSQL projects those exact records asynchronously;
ordinary model Steps neither reload their branch nor wait for PG projection receipts.
Cold history queries and a replacement Worker still use PostgreSQL.

All active Lanes of one physical Pi Session stay on one Worker, but their Agent
Loops run concurrently. Only native append order is shared. A cold Session can
move to any healthy Worker. Creating a Child Lane uses acknowledged parent context,
not a query for a possibly unprojected parent prompt. Human Fork creates an
independent Session; Subagent Branch creates another Lane.

Before an arbitrary Tool effect, complete model output and Pi-validated Tool
intent cross two native Kafka acknowledgement boundaries. Concrete execution
commands then reach Tool Broker through Kafka. Broker retains bounded raw results
for the Worker; the subsequent native Tool Result retires those copies. There is
no second raw-result transcript or automatic command replay.

Broker replicas share partition consumption within a Sandbox Domain. The consumer
forwards commands and small seal/result-retirement notifications to the binding's
exact owning boot; Worker result reads go directly to that owner. Kafka partition
reassignment does not move VMs or re-execute old bindings.

A cleanly drained Run seals independently. An uncertain native publication retires
the shared writer incarnation, including its other Lanes. Canonical, live and
Tool consumers reject later records from that incarnation. The next ownership
period waits for the affected seals to be projected. Interrupted visible text is
saved with the terminal, then incorporated into the next native context through
the current writer. Run authority remains the existing PostgreSQL ExecutionLease;
writer identity is not another credential.

Kafka owns accepted, not-yet-reclaimed facts. PostgreSQL retains the self-contained
semantic Session log and business state; it does not store token-fragment rows.
Broker automatic expiry is disabled for the active topic. A reaper deletes only
behind PG's safe recovery position **and** the retention grace, so a stopped
projector does not silently lose accepted data. Gateway memory is rebuildable.

Elastic Workspace bytes belong to a persistent Cube Volume. A development
machine's full-VM snapshot is node-affine; host shutdown is not an automatic
snapshot. Releasing resources never deletes conversations: users can rebind them.

See [Architecture](docs/ARCHITECTURE.md), [Run lifecycle](docs/RUN_LIFECYCLE.md)
and [stream durability](docs/STREAM_DURABILITY.md) for boundaries and failure rules.

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

**Existing installations:** the native-append cutover requires drained Workers
and fully projected predecessor seals/Outbox before migration 131. Do not mix
old/new Worker and Gateway protocols during a rolling upgrade. Existing PG
semantic history is preserved; no old-protocol fallback is retained.

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

KEDA scales Worker replicas from ready-Run backlog; PostgreSQL claim remains
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
[ADRs](docs/adr/README.md) · [Roadmap](docs/ROADMAP.md) · [Backlog](docs/BACKLOG.md)
