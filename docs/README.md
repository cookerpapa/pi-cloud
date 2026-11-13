# Pi Managed Agents documentation

Start with the current behavior, then follow the relevant decision or evidence.
Release names and historical measurements belong to reports, not the component map.

## Understand the system

| Document | Purpose |
| --- | --- |
| [Project README](../README.md) | Product, topology and quick start |
| [Architecture](ARCHITECTURE.md) | Current message flow, ownership and failure boundaries |
| [Run lifecycle](RUN_LIFECYCLE.md) | Admission, claiming, continuation, Stop and closure |
| [Stream durability](STREAM_DURABILITY.md) | Commit, projection, live coverage and crash contracts |
| [Session clients](SESSION_CLIENT.md) | Shared HTTP/SSE client, input identities and state; independent of execution targets |
| [Cube provider](CUBESANDBOX_PROVIDER.md) | Tool execution, lifecycle and transport boundaries |
| [Subagents](SUBAGENTS.md) | Native children, shared ownership and Workspace choices |
| [Attachments](CHAT_ATTACHMENTS.md) | Long paste, uploads, visual input and retained originals |
| [Workspace uploads](WORKSPACE_UPLOADS.md) | Working files, tus continuation, browser drafts and explicit retention |
| [Skills](SKILLS.md) | Cloud discovery, Agent publication, version selection and Sandbox resources |
| [Model billing](MODEL_BILLING.md) | Model receipts, price versions, statements and limits |
| [Resource billing](RESOURCE_BILLING.md) | Compute/capacity receipts, uncertainty and statements |
| [Schedules](SCHEDULES.md) | Scheduled input and ordinary Run admission |
| [Threat model](THREAT_MODEL.md) | Trusted Runner and untrusted execution boundaries |
| [Network matrix](NETWORK_MATRIX.md) | Component connections and network ownership |

[Reading progress](READING_PROGRESS.md) records the owner's message-by-message
walkthrough. [Roadmap](ROADMAP.md) and [backlog](BACKLOG.md) distinguish delivered
work from remaining proposals and unverified limits.

## Operate and verify

| Document | Purpose |
| --- | --- |
| [Configuration](CONFIGURATION.md) | Maintained configuration authorities |
| [Workspace storage pool](WORKSPACE_STORAGE_POOL.md) | XFS capacity, migration, mount recovery and growth |
| [Resource backends](RESOURCE_BACKENDS.md) | Dynamic cluster registration, explicit selection and device ownership |
| [Deployment](PRODUCTION_DEPLOYMENT.md) | Self-hosted runtime operations |
| [Matched release](MATCHED_RELEASE.md) | Coordinated changes, draining and artifact checks |
| [Component release](COMPONENT_RELEASE.md) | Supported independent publication scopes |
| [Evaluation](EVALUATION.md) | Deterministic, infrastructure and live-model verification |
| [Observability](OBSERVABILITY.md) | Metrics, traces, logs and diagnostic limits |
| [Asset recovery](ASSET_RECOVERY.md) | Conversation/attachment recovery and exclusions |
| [Distributed deployment](DISTRIBUTED_DEPLOYMENT.md) | Multi-machine deployment requirements |
| [Private pilot](PRIVATE_PILOT.md) | Trial scope and acceptance |
| [Optional modules](OPTIONAL_MODULES.md) | Optional integrations |
| [Android target](ANDROID_EXECUTION.md) | Existing-device registration/binding, original-operation recovery and userdata |
| [BoxLite provider](BOXLITE_EXECUTION.md) | Explicit stock compute adapter, shared storage and live acceptance |

## Decisions and evidence

- [Full repository review, November 1](reports/repository-review-20261101.md):
  feature coverage, confirmed issues, architecture tradeoffs and validation limits.
- [Current ADR index](adr/README.md): why the maintained design was chosen.
- [Delivery and research index](reports/README.md): evidence grouped by the revision
  that was actually exercised, including failed samples and superseded experiments.
- [Sandbox capability study](research/pi-runtime-adapter-comparison-20261031.md):
  comparison with Rivet Pi and Pi on Cloudflare; the bounded implementation scope.
- [Capability refactor delivery](reports/sandbox-capabilities-20261031.md):
  implementation, validation and publication status.

A report does not establish that its old topology remains supported. Research
does not authorize a replacement runtime. Superseded executable paths stay removed;
Git preserves their implementation history.

The remaining product/contributor guides are [Web direction](WEB_UI_DIRECTION.md),
[release policy](RELEASE_PROCESS.md) and [collaboration discipline](VIBE_CODING_PLAYBOOK.md).

Latest delivery and validation: [Decoupling, resource backends and scoped releases](reports/decoupling-delivery-20261113.md).
Previous validation: [Integrated BoxLite / Android acceptance](reports/alternate-runtimes-20261112.md).
Latest maintenance: [Obsolete Cube metadata cleanup](reports/cube-metadata-cleanup-20261111.md).
Serving runtime delivery: [Platform-owned elastic expiry](reports/platform-idle-expiry-20261111.md).
Previous delivery: [Stock Cube deployment](reports/stock-cube-source-20261111.md).
Previous delivery: [Guest execution and Session activity](reports/guest-execution-20261110.md).
Previous delivery: [Runtime decoupling and continuation](reports/runtime-decoupling-20261109.md).
Previous delivery: [Execution-owned tools and independent publication](reports/execution-tools-20261108.md).
Previous foundation: [Independent runtime and resource accounting](reports/runtime-accounting-20261107.md).
Related assessment: [CLIProxyAPI upstream candidates](reports/provider-upstream-candidates-20261106.md)
(the community contribution assessment is separate from the implementation issue).

Execution-boundary research: [Pi / OpenMA / BoxLite comparison](research/execution-boundaries-20261108.md), with [ADR-0305](adr/0305-execution-owned-tools-and-bindings.md).
The historical [Cube patch assessment](research/cube-patch-assessment-20261110.md)
distinguishes the Guest application from the former execution and lifecycle patches.

Current boundary: [Stock sandbox contract](adr/0309-stock-sandbox-contract.md).
Earlier assessment: [Guest and provider resource boundaries](research/guest-and-resource-boundaries-20261110.md), supporting [ADR-0307](adr/0307-guest-execution-and-session-activity.md).

[Complete Cube patch inventory](research/cube-patch-inventory-20261110.md) lists
all 87 patched upstream paths, runtime callers, supporting/generated changes and
the additional build-time Dockerfile transformations for #26.

- [Resource backend registration](RESOURCE_BACKENDS.md): registry, placement, private configuration and device boundaries.
