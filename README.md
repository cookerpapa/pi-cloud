# Pi Managed Agents

Self-hosted infrastructure for managed agents, powered by Pi.

Built around Pi Durable 1.0's public embedded SDK. Coding-agent loops run in trusted Workers; file and shell tools
run in separate KVM guests, with CubeSandbox as the default provider. Conversations and retained attachments survive
Worker replacement and Workspace changes.

Pi Managed Agents is a personal infrastructure project with integration and failure-recovery
acceptance on a single-host K3s deployment. It has not been validated at fleet
scale or as a highly available production service.

[Alternate runtime acceptance](docs/reports/alternate-runtimes-20261112.md) covers
an explicit stock BoxLite backend and Android operator targets. Linux providers
share the fixed Guest; device operations share the original-reply recovery and
HTTPS completion path. There is no automatic provider fallback or phone picker.

## What it does

- **Coding conversations:** streamed text, tool results, hosted search where the
  provider supports it, model selection and native context compaction.
- **Interactive input:** native steer/follow-up queues with editing, ordering,
  cancellation and promotion to steer. Enter defaults to follow-up; Stop returns
  unconsumed inputs to the composer. Initial messages appear directly in the
  transcript with sending/acknowledgement states; only follow-up/steer uses the
  pending-input list.
- **Long histories:** bounded pagination and virtual scrolling, history navigation,
  search and streamed Markdown export. `/usage` shows committed token usage and
  context estimates; `/compact [instructions]` requests native compaction.
- **Independent branches:** Fork only the selected Agent's history while later
  work continues. Forks are peers in the conversation list and retain a source
  link; deleting the source preserves independent Forks. Old subagents and pending
  inputs are not inherited. Native and display history use shared immutable
  references; source pruning preserves Forks.
  Forks keep the source Workspace, directory and stable development-machine
  binding. Files are shared, not copied or rolled back by conversation Fork.
- **Workspaces:** elastic compute or dedicated development machines, persistent
  Persistent Workspace files, browser tooling, terminals, SSH and application previews.
- **Attachments:** long text pastes become editable text files. Uploaded originals
  stay with the conversation in object storage; Workspace copies support normal
  file/shell tools. History originals can be viewed, downloaded and reused.
- **Working files:** choose Workspace-only uploads in the composer or file panel.
  Large working files resume from receiver-confirmed progress. Browser drafts
  survive page reload without caching ordinary local file bodies; sending waits
  for upload completion. [Storage and recovery](docs/WORKSPACE_UPLOADS.md).
- **Images:** chat image uploads enter the model directly. `generate_image` creates or
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

The organization-only [Skill market](docs/SKILLS.md) supports browsing/search,
instruction/file previews, Agent-authored publication and versioned installations.
Installed Skill summaries appear in the model prompt; instructions load on demand,
and execution files are prepared in the current Tool Sandbox only when used.

## Architecture

```text
Browser -> Session API -> PostgreSQL (Run queue/control) -> Pi Worker
Pi Worker <-> Worker-local Model Gateway <-> CLIProxyAPI <-> Model

Pi Worker -> Session Kafka producer -> Kafka -> Session Projector
                                               +-> PostgreSQL (native state/history)
                                               +-> Browser (SSE)
                                               +-> Ordinary Tool host (HTTP)
                                               `-> Provider process API -> fixed Guest

Control changes -> PostgreSQL + Outbox -> same Session Kafka partition
Guest -> HTTPS completion -> Kafka replies -> authorized Pi Worker
Control Tool completion -> Kafka replies -> authorized Pi Worker

Workspace files -> independent Workspace storage (local XFS)
Retained attachment originals -> private S3 objects; Kafka/PG carry references
Model / storage receipts -> independent Metering service -> PG ledger
Provider observations -> independent Metering -> PG ledger (unverified time unpriced)
```

| Component | Responsibility |
| --- | --- |
| PostgreSQL | Session configuration, Run admission, leases and control authority; materialized native history and current state |
| Pi Worker | The pinned native Harness, context preparation, model requests and canonical Tool Result settlement |
| Kafka | Ordered Session commits/control propagation, Worker-boot replies and a separate compacted Tool catalog |
| Session API | Authentication, Run admission, history/statements and browser connections |
| Session runtime | Worker membership and the sole Projector for native projection, live views and Tool dispatch |
| Tool completion | Scoped Guest HTTPS callbacks, image claim checks and Kafka reply publication |
| Tool host | Independently published trusted ordinary Tool implementations; no Pi or Session consumer |
| Control Plane | VM allocation, lifecycle recovery, resource maintenance and scheduled/SCM admission |
| Sandbox providers | CubeSandbox by default, explicit stock BoxLite, and operator Android targets; fixed Guest/receiver admission and scoped completion |
| CLIProxyAPI | Provider credentials, account selection and upstream model transport |
| S3 / Workspace storage | Immutable conversation attachments and Skill packages / mutable Workspace files |

The provider adapter targets pinned CLIProxyAPI v8 with native Responses and
cross-request continuation. Existing installations use the reviewed provider
configuration conversion in the [component release procedure](docs/COMPONENT_RELEASE.md).
[Model metering](docs/MODEL_BILLING.md) records request receipts separately from
conversation history, with versioned prices and an informational Model costs page.
The independent metering service collects native compute observations and separately receives persistent Workspace capacity receipts; [resource statements](docs/RESOURCE_BILLING.md) preserve
unconfirmed gaps. Payment collection and production tariffs are not enabled.

The `session-api` process owns public requests and relays live views from the
single Session Projector. It can be replaced without draining the Worker family.
`session-runtime` retains Worker control and execution; `control-plane` retains
physical resource lifecycle. Already-bound Tools continue while management is
stopped. New VM activation and physical recovery wait for management. Fixed Guest
Tools deliver through the independent `tool-completion` HTTPS role, so replacing
the dispatch caller does not discard their completion path. There is no independent
Tool Broker. [Runtime delivery and recovery evidence](docs/reports/runtime-decoupling-20261109.md)
covers API/Worker/VM replacement, callback loss, retained images, actual 30-minute
idle expiry and external resource accounting.
The [Guest execution follow-up](docs/reports/guest-execution-20261110.md) moves
operation admission and exact cancellation out of Cubelet. Session activity uses
the existing Kafka writer; execution renews eligible resources without polling
Worker ownership or leases. The stock-provider migration moves remaining resource and Volume protection into
conservative admission and the supported Volume Plugin; see [ADR-0309](docs/adr/0309-stock-sandbox-contract.md).
Ordinary control tools run in a separate `tool-host` process. Complete versioned
definitions reach every Worker through a compacted Kafka configuration topic and
take effect at the next model request. Updating these tools does not replace the
Session API or Projector. [Live publication and execution acceptance](docs/reports/execution-tools-20261108.md)
verified the same Run continuing with its original Worker, lease and VM while
its next model request observed the updated directory.

Sandbox integration uses focused lifecycle, execution, file, image, terminal,
preview, workflow and credential interfaces. Cube and BoxLite share fixed Guest
behavior while each adapter owns its provider mechanics.
Workers describe logical targets; the Session execution side prepares bindings
when needed. The resource owner keeps physical admission and recovery; file access adds no lifecycle
authority or extra network hop. See the [provider boundaries](docs/ARCHITECTURE.md#tools-and-cube).

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
git clone https://github.com/cookerpapa/pi-managed-agents.git
cd pi-managed-agents
./install.sh --check-only
./install.sh
```

This is a first-installation command. An existing deployment must use the
[matched](docs/MATCHED_RELEASE.md) or [scoped](docs/COMPONENT_RELEASE.md) release
operator; rerunning the installer refuses before changing the serving release.

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

The stock Cube integration in [#26](https://github.com/cookerpapa/pi-managed-agents/issues/26)
is deployed using unchanged, digest-pinned official v0.7.3 images. The owner accepted
the reviewed findings for those four exact images under [ADR-0310](docs/adr/0310-stock-cube-release-exception.md);
other release gates remain enforced. Serial deployment and acceptance are recorded in the
[delivery report](docs/reports/stock-cube-source-20261111.md). Stock compute observations
are unconfirmed/unpriced; model and Workspace-capacity metering remain independent.

The repository contains native SDK contract tests, PostgreSQL/Kafka integration
checks, browser layout tests, deterministic fault scenarios and opt-in live
model/Cube acceptance. [Evaluation](docs/EVALUATION.md) describes their scope;
individual delivery reports retain both successes and unresolved failures.
The [runtime and resource-accounting delivery](docs/reports/runtime-accounting-20261107.md)
records real quota growth, receipt recovery, an 86-second management outage,
native crash recovery and image preservation on the maintained single-host setup.

- The provider-owned continuation implementation uses full HTTP/SSE input inside
  the cluster and reuses compatible OpenAI upstream context across Run/Worker
  changes. Caches are disposable; reconnects or changed context can require full
  input. Native token compaction and manual `/compact` remain the reduction policy.
  [ADR-0289](docs/adr/0289-provider-owned-model-continuation.md) records the contracts.
  Cross-Worker image/Tool continuation and native recovery are verified on the
  deployed stack. Very large cold uploads remain a
  [separate limitation](docs/BACKLOG.md#very-large-cold-visual-context--investigation-remains).
- The single-host deployment does not provide node-level HA. Active Cubelet loss
  may leave Volume references unconfirmed; cleanup waits for positive evidence.
- Arbitrary shell commands and remote effects do not have exactly-once guarantees.
  Recovery preserves uncertainty instead of silently executing them again.
- Self-hosted defaults have no product quotas on conversations or concurrency.
  Workspace storage has an explicit, growable capacity enforced by the filesystem;
  physical pool capacity and transport/provider bounds still apply.
- Shared native/presentation roots and safe reclamation are implemented under
  [ADR-0287](docs/adr/0287-single-path-shared-forks.md). A measured 1 GiB Fork takes
  about 0.8 seconds; ordinary complete-message writes cost about 8 ms more in the
  isolated comparison. [Measurements and limits](docs/reports/single-path-shared-forks-20261030.md)
  include cold reads and incremental collection. These are not fleet-scale SLAs.

## Development and releases

`main` is the maintained development branch. The `pre-pi-durable-1.0` tag preserves
the version before the native Durable migration. Retired architecture experiments
are historical references, not supported runtime alternatives.

The public project name is **Pi Managed Agents** (formerly PiCloud). Existing
package scopes, protocol names and deployment resource identifiers use `pi-cloud`;
these are stable technical identities, not separate product editions.

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
[Conversation/attachment recovery](docs/ASSET_RECOVERY.md)

## License

Pi Managed Agents is licensed under the [MIT License](LICENSE).
Third-party components and files with explicit license declarations retain their
own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).

Workspace persistence is now separate from the compute adapter ([ADR-0318](docs/adr/0318-workspace-persistence-and-native-mounts.md)). The local implementation uses the existing XFS storage service; Cube and BoxLite mount the same guarded storage without making Cube its byte owner. This source change requires the recorded cold adoption before deployment; multi-node and hosted storage are not yet live-verified.
