# Documentation map

Start with the current behavior, then follow the relevant decision or evidence.
Release names and historical measurements belong to reports, not the component map.

## Understand the system

| Document | Purpose |
| --- | --- |
| [Project README](../README.md) | Product, topology and quick start |
| [Architecture](ARCHITECTURE.md) | Current message flow, ownership and failure boundaries |
| [Run lifecycle](RUN_LIFECYCLE.md) | Admission, claiming, continuation, Stop and closure |
| [Stream durability](STREAM_DURABILITY.md) | Commit, projection, live coverage and crash contracts |
| [Cube provider](CUBESANDBOX_PROVIDER.md) | Tool execution, lifecycle and transport boundaries |
| [Subagents](SUBAGENTS.md) | Native children, shared ownership and Workspace choices |
| [Attachments](CHAT_ATTACHMENTS.md) | Uploads, visual input and retained images |
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
| [Deployment](PRODUCTION_DEPLOYMENT.md) | Self-hosted runtime operations |
| [Matched release](MATCHED_RELEASE.md) | Coordinated changes, draining and artifact checks |
| [Component release](COMPONENT_RELEASE.md) | Supported independent publication scopes |
| [Evaluation](EVALUATION.md) | Deterministic, infrastructure and live-model verification |
| [Observability](OBSERVABILITY.md) | Metrics, traces, logs and diagnostic limits |
| [Asset recovery](ASSET_RECOVERY.md) | Conversation/image recovery and exclusions |
| [Distributed deployment](DISTRIBUTED_DEPLOYMENT.md) | Multi-machine deployment requirements |
| [Private pilot](PRIVATE_PILOT.md) | Trial scope and acceptance |
| [Optional modules](OPTIONAL_MODULES.md) | Optional integrations |
| [Android target](ANDROID_EXECUTION.md) | Retained operator prototype; no Web product picker |

## Decisions and evidence

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
