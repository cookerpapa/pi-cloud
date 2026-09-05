# PiCloud

PiCloud is a self-hosted, multi-tenant Cloud Coding Agent built on the Pi SDK.
Pi runs in a trusted Worker pool; subscription/API credentials live in a
dedicated Provider Gateway, while model-generated file and shell operations run
in CubeSandbox KVM microVMs.

## What you get

- browser registration/login and tenant-isolated conversations;
- per-browser Chinese/English UI selection without translating prompts, Tool output or model replies;
- multi-round Pi Sessions, native Compaction, tree navigation, Fork and Steer;
- cascading per-conversation Provider/model/reasoning selection, GPT Fast mode,
  and immutable request-setting snapshots for every Turn;
- Provider-native hosted capabilities on verified model routes, without a second PiCloud search service;
- durable recursive Subagents with bounded depth/concurrency and shared Pi
  Session lanes instead of copied inherited transcripts;
- named Workspaces, source browsing, Web Terminal and authenticated service preview;
- self-managed GitLab public/private project connection and explicit Issue-to-Run automation;
- one elastic Cube runtime per active Workspace, or user-owned full-VM Cube environments with root SSH/terminal access;
- snapshot-first SSE whose visible bytes were acknowledged by Kafka first;
- horizontally replaceable Pi Workers and Kubernetes/KEDA deployment support.
- Worker-ready prewarming for isolated Pi model-runtime slots and the governed Subagent contract.

PiCloud targets private or controlled enterprise deployments. It is not a
hostile public-SaaS security or abuse-management product.

## Architecture

```text
Browser
  │ UI / REST / snapshot-first SSE / Terminal WebSocket / Preview
  ▼
Caddy ingress
  ▼
Control Plane replicas
  ├─ local identity, tenant and conversation APIs
  ├─ Session desired model/reasoning/Fast settings
  ├─ Run admission, cancellation, Steer and resource APIs
  ├─ Worker Control Channel + AcceptedFact Authority Gate
  ├─ cursor-free SSE / Terminal / Preview gateways
  └─ optional GitLab/GitHub Issue intake
            │
            ├──────────────▶ PostgreSQL
            │                product state + ready Run queue
            │                RunAttempt + ExecutionLease/Fence
            │                immutable Turn model/Tool snapshots
            │                self-contained Pi Session logs
            │                + Entry/Lane query projections
            │
            └─ snapshot + live SSE ──────────────────────────────▶ Browser

PostgreSQL ready Runs
  └─ physical Pi Session owner claim + SKIP LOCKED + LISTEN/NOTIFY
       ▼
Trusted Pi Worker pool (replaceable, bounded slots)
  ├─ one active owner per physical Pi Session
  ├─ parallel main/Subagent Lane Agent Loops + native Compaction
  ├─ bounded Session context read from PostgreSQL
  ├─ Worker-local capability Model Gateway
  │    └─ frozen Provider/model/reasoning/Fast/modalities/Hosted Tools
  │          ▼
  │       CLIProxyAPI Provider Gateway
  │       subscription/API credentials, quota and soft Session affinity
  │          ▼
  │       OpenAI / DeepSeek native Responses APIs
  ├─ TrustedToolRuntime
  │    ├─ platform: Preview publication
  │    ├─ orchestration: Subagent + supervisor channel
  │    └─ integration: reserved external-system executor
  └─ leased read/write/edit/bash RPC
         ▼
      Tool Broker replicas
      Cube lifecycle + Tool binding + Workspace runtime ownership
         ▼
      CubeSandbox KVM microVM ───────▶ persistent Cube Workspace Volume
      untrusted code and processes

Every Worker
  └─ one authenticated multiplexed Fact connection
       └─ one logical stream per Session ExecutionLease
            ▼
AcceptedFact Authority Gate
  └─ one PostgreSQL Lease/Fence admission per logical stream
       ▼
Kafka (Session-keyed, replication factor 3, acks=all)
  ├─ canonical consumer ─────────────▶ PostgreSQL Pi SessionStorage
  └─ incomplete-Turn consumer ───────▶ rebuildable live tail ─────▶ SSE

Workspace browser: Browser ─▶ Control Plane ─▶ Workspace Volume Gateway ─▶ Cube Volume
Human terminal:    Browser ─▶ Control Plane ─▶ Tool Broker PTY ───────────▶ Cube
Owned machine SSH: SSH client ─▶ SSH Gateway ─▶ Tool Broker PTY ─────────▶ Cube
```

Before an arbitrary Tool effect, the Worker crosses two atomic durability
boundaries: complete model output plus usage, then Pi-validated Tool intent.
Each boundary is one Session mutation with its matching public event in the
same Kafka AcceptedFact; the Tool runs only after the intent is projected to
PostgreSQL.

Session projection and its receipt commit together; Workers wait on their
shared PostgreSQL notification connection. Gateways consume Kafka partitions
concurrently and initialize the browser from one consistent history/live snapshot.

There are three durable authorities:

- PostgreSQL owns product state, the Run queue and one self-contained,
  append-only semantic log per physical Pi Session; Entry/Lane tables are
  transactional query projections;
- Kafka owns the bounded AcceptedFact log; Gateway memory holds only rebuildable
  incomplete Session tails;
- a persistent Cube Volume owns elastic Workspace bytes; Cube pause state owns
  a cloud development machine's guest root, memory and processes on its compute node;
  releasing that machine deletes its private Volume but never its conversations.

Any healthy Worker may acquire a cold Pi Session. While any Lane is active,
that physical Session stays on one Worker; its main and Subagent Lanes execute
in parallel inside that ownership boundary. PostgreSQL atomically issues one
versioned, never-reused `ExecutionLease` per active Lane operation, and every
effect boundary rejects an expired or replaced lease. See
[Architecture](docs/ARCHITECTURE.md),
[Run lifecycle](docs/RUN_LIFECYCLE.md) and
[stream durability](docs/STREAM_DURABILITY.md) for the detailed contracts.

Sandbox-backed Pi function Tools execute through Tool Broker. A verified
Provider-hosted Tool is instead declared in that Turn's native model request and executes at the
Provider; the current OpenAI Codex and DeepSeek Responses routes enable Web
Search. Each Provider search item keeps one stable Codex-style activity row
that changes in place from searching to searched; repeated searches remain
separate and show portable query/open/find details through the existing
Kafka/SSE live tail. Completed activity is rebuilt from the same Pi assistant
message after reload.
The completed Pi assistant message retains the Provider-native search action,
assistant text and URL citations; native IDs replay only to the exact issuing
Provider/API/model. Switching the conversation model while idle keeps the
portable text and links but omits incompatible native action IDs, without
adding a synthetic model-visible notice or a fabricated local Tool result.
Reasoning effort and GPT Fast mode are Session defaults stored in PostgreSQL;
an accepted Turn freezes both before Worker execution. Fast is an OpenAI
request service tier, never Pi context, and is not available on DeepSeek.

Not every Pi function Tool runs in Cube. The Worker loads trusted platform and
orchestration Tools through a separate `TrustedToolRuntime`; Preview and
Subagent coordination execute against trusted PostgreSQL services, while
`read`, `write`, `edit` and `bash` alone cross Tool Broker into Cube. The
runtime already reserves an `integration` execution plane for future external
systems without putting their credentials in Pi Workers or Sandboxes.

## One-host quick start

Requirements: a clean Git checkout on x86_64 Debian/Ubuntu or WSL2 with
systemd, writable `/dev/kvm`, at least 16 GiB RAM and 40 GiB free disk.

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

3. Open `http://127.0.0.1:8081`, sign in again, and choose the Pi model route or
   configure the Cube proxy. Open the linked Provider Gateway page on port
   `8318` to manage subscriptions, API keys, quota and account health. Retrieve
   its management key with `npm run production:provider-gateway:key`; add an
   independent ChatGPT/Codex subscription with
   `npm run production:provider-gateway:codex-login`.
4. Open **开发资源** to create Workspaces or an optional cloud development machine.
5. Start a conversation in either mode:
   - **Elastic execution** selects/creates a Workspace and chooses a deployment-owned size;
   - **Cloud development machine** selects a running user-owned Cube and a live
     directory from its complete guest filesystem; its GNOME-style folder
   chooser can create a user-writable directory before selection.

The optional deployment-controlled GitLab adapter connects one public or
private project through the source-control API with a project access token
scoped to that repository. PiCloud encrypts this project-integration credential
for signed Webhooks and Issue API synchronization; it never copies it into a
user environment. Adding the configured `picloud` label to an Issue, or posting
`/picloud solve`, creates a pending request without spending model quota. Any
authorized PiCloud user in the tenant may express a non-exclusive claim, select
elastic compute or an owned development-machine directory, choose a
conversation name, and start the ordinary Session/Run. PiCloud login, project
Issue intake, and Git access are independent.

The conversation header exposes **Code Hosts**. A user can connect a GitLab
origin or `https://github.com` by writing an appropriately scoped token directly
to that Workspace or development machine. PostgreSQL stores neither token nor a
token copy. One environment may hold several origin-scoped connections. Issue
startup performs a real `git ls-remote` against the exact repository; missing or
rejected credentials return the user to the same Code Host dialog. The Agent
then performs the visible `git clone` itself. The initial Run implements and
tests the change but does not commit, push, create an MR, comment on or close the
Issue. Delivery remains an explicit later user/Agent action. Neither Code Host
tokens nor project-integration credentials enter Pi context or Kafka. Run the
optional local acceptance instance with `npm run gitlab:up`; see
[its README](deploy/gitlab/README.md).

An elastic Workspace is durable storage, not reserved compute: Cube capacity is
admitted on its first Tool call, then concurrent Session Tool bindings share
that Workspace runtime until its bounded idle TTL. Creating a cloud development machine is
synchronous and succeeds only after durable-resource admission, Sandbox Domain
capacity and the selected Cube profile have all been admitted.

Releasing a cloud development machine deletes that machine and all of its files.
Its conversations remain readable and must be rebound to another Workspace
before they can run again.

The language selector is available on the sign-in page and beside the current
username. It is a browser-local presentation preference: switching it does not
modify Session context, system prompts, user messages or Agent output.

Service preview uses structured listener discovery rather than assistant-text
parsing. Cube Provider identifies live HTTP ports through the trusted guest
management channel, Tool Broker records them, and the Web client renders
an authenticated application link when the Agent calls the trusted `preview`
Tool. The link appears with that Tool result rather than as a permanent top-bar
hint. The
main origin issues a short-lived target capability and redirects to an isolated
`*.preview.localhost` origin, so application storage and scripts work without
receiving PiCloud cookies. Production DNS/TLS must cover
`*.preview.<application-host>`; Cube addresses and public port mappings are
never exposed to the Agent. SSH is available only for cloud development
machines and only while no other human terminal owns the environment; it may
coexist with one Agent Run, and each password can be used once.

Re-running `./install.sh` reconciles the same private runtime. Generated
credentials and state live under `deploy/production/runtime/` by default and
must never be committed.

Common operations:

```bash
npm run production:ps
npm run production:logs
npm run production:config
npm run production:up:observability
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
PI_CLOUD_LIVE_PROVIDER_CAPABILITY_CHECK=1 npm run production:provider-capability-check
PI_CLOUD_LIVE_MODEL_SETTINGS_CHECK=1 npm run production:model-settings-check
PI_CLOUD_LIVE_HOSTED_SEARCH_REPLAY_CHECK=1 npm run production:hosted-search-replay-check
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
