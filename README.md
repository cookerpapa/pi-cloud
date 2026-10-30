# PiCloud

A self-hosted cloud runtime for coding agents, built around Pi Durable 1.0's
public embedded SDK. Agent loops run in trusted Workers; file and shell tools
run in separate CubeSandbox KVM guests. Conversations and retained images survive
Worker replacement and Workspace changes.

PiCloud is a personal infrastructure project with integration and failure-recovery
acceptance on a single-host K3s deployment. It has not been validated at fleet
scale or as a highly available production service.

## What it does

- **Coding conversations:** streamed text, tool results, hosted search where the
  provider supports it, model selection and native context compaction.
- **Interactive input:** native steer/follow-up queues with editing, ordering,
  cancellation and promotion to steer. Enter defaults to follow-up; Stop returns
  unconsumed inputs to the composer.
- **Long histories:** bounded pagination and virtual scrolling, history navigation,
  search and streamed Markdown export. `/usage` shows committed token usage and
  context estimates; `/compact [instructions]` requests native compaction.
- **Independent branches:** Fork only the selected Agent's history while later
  work continues. Forks are peers in the conversation list and retain a source
  link; deleting the source preserves independent Forks. Old subagents and pending
  inputs are not inherited. Native and display history use shared immutable
  references; source pruning preserves Forks.
  Workspace files are shared, not copied or rolled back by conversation Fork.
- **Workspaces:** elastic compute or dedicated development machines, persistent
  Volume-backed files, browser tooling, terminals, SSH and application previews.
- **Images:** chat uploads enter the model directly. `generate_image` creates or
  edits images using file/recent-image references; `show_image` displays Workspace
  images. Retained image objects stay available in conversation history.
- **Delegation and automation:** native child Conversations within one Session
  family, compact child progress, and scheduled inputs that start a new Run when
  the conversation is idle. Ultra enables proactive delegation.
- **Recovery:** durable accepted input, ordered writer handoff, native continuation
  and explicit uncertainty for interrupted external effects. Cancelled visible
  assistant text is retained for later context through native context edits.

New conversations default to GPT-6.1 Sol. Model availability comes from the
validated deployment catalog; provider discovery alone does not publish a model.
GPT-6 Luna is used for routine live checks. Provider capabilities and availability
remain separate from declaring a tool in the catalog.

## Architecture

```text
Browser -> Control Plane -> PostgreSQL (Run queue/control) -> Pi Worker
Pi Worker <-> Worker-local Model Gateway <-> CLIProxyAPI <-> Model

Pi Worker -> Session Kafka producer -> Kafka -> Session Projector
                                               +-> PostgreSQL (native state/history)
                                               +-> Browser (SSE)
                                               +-> Control Tool handlers
                                               `-> Cube native execution endpoint

Control changes -> PostgreSQL + Outbox -> same Session Kafka partition
Cube/control Tool completion -> boot-scoped Kafka replies -> original Pi Worker

Workspace files -> persistent Cube Volumes
Retained images -> private S3 objects; Kafka/PG carry references
```

| Component | Responsibility |
| --- | --- |
| PostgreSQL | Session configuration, Run admission, leases and control authority; materialized native history and current state |
| Pi Worker | The pinned native Harness, context preparation, model requests and canonical Tool Result settlement |
| Kafka | Acknowledged ordered Session commits and control propagation; separate Worker-boot reply transport |
| Session Projector | Native-state materialization, live views and dispatch of committed tool intents |
| CubeSandbox | KVM isolation, fixed native file/shell tools and completion delivery |
| CLIProxyAPI | Provider credentials, account selection and upstream model transport |
| S3 / Cube Volumes | Immutable conversation images / mutable Workspace files |

The API, Projector and sandbox lifecycle controller share one Control Plane
process. There is no independent Tool Broker. Ordinary control tools are registered
on the execution side; their definitions reach Workers over the existing management
connection and take effect at the next model request.

One physical Pi Session has one renewable execution lease, one writer and one
Worker family slot. Its child Conversations share that ownership. Workers publish
directly with a stable transactional Kafka producer identity; takeover checks PG
authorization before and after initialization. There is no per-commit HTTP ingress.

Kafka acknowledgement precedes adoption into Pi's committed memory state.
PostgreSQL retains semantic history and authoritative current Inbox/Submission
values. Native live progress stays in Kafka with PG checkpoints at settlement or
ordered handoff. Temporary tool-output previews and health observations use lossy
HTTP/SSE and never become model context or a second execution authority.

Tools execute only after dispatch admission is durably confirmed. A lost reply
does not establish whether a shell command ran: unsafe external effects are not
automatically replayed. Chat Stop follows native cancellation; late replies cannot
overwrite an already settled abort. Workspace ownership and VM cleanup remain
separate from a tool's success or failure.

See [architecture and failure boundaries](docs/ARCHITECTURE.md),
[current decisions](docs/adr/README.md) and [run lifecycle](docs/RUN_LIFECYCLE.md).

## Quick start

Requires x86_64 Debian/Ubuntu or WSL2 with systemd, writable `/dev/kvm`,
at least 16 GiB RAM and 40 GiB free disk. The maintained setup targets private
networks. All runtime services run in K3s; Docker builds the images.

```bash
./install.sh --check-only
./install.sh
```

1. Open `http://127.0.0.1:8080` and register an account.
2. Promote your administrator account with
   `npm run production:administrator -- --username <username>`.
   This operation restarts the Control Plane.
3. Open `http://127.0.0.1:8081` to configure model routes and Cube networking.
   Configure credentials in the linked Provider Gateway; retrieve its management
   key with `npm run production:provider-gateway:key`.
4. Create a Workspace and send a task. Dedicated machines are created under
   **开发资源**. Pure chat does not activate sandbox compute.

Configuration and credentials live in the private, ignored
`deploy/production/runtime/` directory. Never commit that directory.
To change the local outbound proxy consistently:

```bash
npm run production:proxy -- http://127.0.0.1:12450
```

After importing Codex subscription accounts into CLIProxyAPI, run
`node scripts/configure-provider-websockets.mjs` to enable native upstream
continuation. Follow [configuration](docs/CONFIGURATION.md) and
[deployment](docs/PRODUCTION_DEPLOYMENT.md) for non-local addresses and previews.

## Validation and current limits

The repository contains native SDK contract tests, PostgreSQL/Kafka integration
checks, browser layout tests, deterministic fault scenarios and opt-in live
model/Cube acceptance. [Evaluation](docs/EVALUATION.md) describes their scope;
individual delivery reports retain both successes and unresolved failures.

- Normal-size GPT image continuation has been verified through the actual provider
  route: one measured request of about 3.11 MB was followed by 19.8 KB requests.
  This is a transport-size result, not a general latency claim. New Runs, reconnects
  and changed context can still require full input. Very large cold visual context
  remains a [tracked limitation](docs/BACKLOG.md#very-large-cold-visual-context--investigation-remains).
- The single-host deployment does not provide node-level HA. Active Cubelet loss
  may leave Volume references unconfirmed; cleanup waits for positive evidence.
- Arbitrary shell commands and remote effects do not have exactly-once guarantees.
  Recovery preserves uncertainty instead of silently executing them again.
- Self-hosted defaults have no product quotas on conversations, concurrency or
  uploads. Physical capacity and transport/provider bounds still apply.
- Shared native/presentation roots and safe reclamation are implemented under
  [ADR-0287](docs/adr/0287-single-path-shared-forks.md). A measured 1 GiB Fork takes
  about 0.8 seconds; ordinary complete-message writes cost about 8 ms more in the
  isolated comparison. [Measurements and limits](docs/reports/single-path-shared-forks-20261030.md)
  include cold reads and incremental collection. These are not fleet-scale SLAs.

## Development and releases

`main` is the maintained development branch. The `pre-pi-durable-1.0` tag preserves
the version before the native Durable migration. Retired architecture experiments
are historical references, not supported runtime alternatives.

```bash
npm ci
npm run check
npm run docs:check
```

Some integration checks require Docker and additional local tooling; use the
[evaluation guide](docs/EVALUATION.md) for prerequisites and opt-in live checks.

Use [scoped component releases](docs/COMPONENT_RELEASE.md) for supported Web,
provider, catalog or ordinary control-tool changes. Protocol, storage and ownership
changes use the [matched release procedure](docs/MATCHED_RELEASE.md), including
writer draining, fencing and relevant live acceptance. Accounts and configuration
are preserved; obsolete development compatibility paths are removed.

[Roadmap](docs/ROADMAP.md) · [Backlog](docs/BACKLOG.md) ·
[Documentation index](docs/README.md) ·
[Distributed deployment](docs/DISTRIBUTED_DEPLOYMENT.md) ·
[Conversation/image recovery](docs/ASSET_RECOVERY.md)
