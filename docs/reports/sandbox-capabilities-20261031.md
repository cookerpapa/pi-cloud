# Sandbox capability refactor and current documentation

Date: 2026-10-31. Baseline: `b2aa6168`.

## Scope

The provider composition is divided into lifecycle, execution preparation,
Workspace files, images, terminals, previews, workflows and Git credentials.
SandboxController retains all ownership, allocation and closure coordination.
WorkspaceFileAccess receives the file port and callbacks to the owner's existing
admission checks. It adds no network hop, state authority, output copy or retry.

The documentation map and architecture are organized around current behavior.
The former map's report/research links are retained in [the evidence index](README.md).
Evaluation's retired Worker-to-control-ingress path is corrected to direct Kafka
publication. ADRs retain design rationale and reports retain dated evidence.

No Pi version, schema, public protocol, tool behavior, storage retention or runtime
provider changes. Project text discovery/Skills, tracing expansion and Pi upgrades
remain separate proposals. [Research](../research/pi-runtime-adapter-comparison-20261031.md).

## Verification and publication

The targeted 107 tests pass, including seven file-capability cases and existing
controller, Cube-provider, shared-compute and recovery-publication checks. The
sandbox-control typecheck passes. A TypeScript declaration comparison confirms
all 39 provider member signatures and their optionality are unchanged.

Documentation checks and an additional traversal of changed Markdown links pass.
The architecture is reduced from 1,886 to 403 lines and the navigation page from
900 to 56; dated evidence links have their own 182-line index. Runtime policy,
build-context/image closure, Helm rendering, observability, formatting and build
checks pass. Full workspace/fault checks and matched live publication are pending.
