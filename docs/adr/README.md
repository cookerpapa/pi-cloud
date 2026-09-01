# Current architecture decisions

This directory contains only decisions that constrain the maintained Pi Cloud
product. Superseded experiments and pre-release decisions are intentionally not
kept beside current ADRs; Git history is their archive.

Read the documents in this order:

1. [ADR-0139](0139-provider-native-model-capabilities.md) — Provider-native
   model capabilities and hosted Tools.
1. [ADR-0138](0138-subscription-provider-gateway.md) — CLIProxyAPI model-supply
   authority, native provider protocols, Session affinity and separate operator UI.
1. [ADR-0137](0137-code-host-connections.md) — independent PiCloud identity,
   Issue intake and environment-scoped Code Host connections.
1. [ADR-0136](0136-workspace-owned-elastic-runtime.md) — one physical elastic
   Cube per Workspace with independently fenced concurrent Tool bindings.
1. [ADR-0135](0135-live-workspace-browser-and-lightweight-settlement.md) —
   lightweight Volume settlement and live, directory-scoped Workspace reads.
1. [ADR-0134](0134-user-managed-git-workspaces.md) — ordinary user-visible Git
   state with no platform Diff or post-Run commit/push.
1. [ADR-0133](0133-versioned-agent-identity-and-native-session-storage.md) —
   explicit Agent Revision routing and Runtime-native Session Storage.
1. [ADR-0132](0132-source-control-app-and-issue-automation.md) — GitLab/GitHub
   repository grants, Workspace-local Git authorization and user-directed Issue Runs.
1. [ADR-0131](0131-run-table-postgres-queue.md) — Run as the only PostgreSQL
   execution queue, typed Cancel/Steer control requests and terminal-only Outbox.
1. [ADR-0130](0130-user-managed-workspace-concurrency.md) — same-Session FIFO
   with user-managed concurrency across Sessions, terminals and shared files.
1. [ADR-0129](0129-multiplexed-worker-fact-connection.md) — one physical Fact
   connection per Worker with independently authorized logical Run Streams.
1. [ADR-0128](0128-kafka-soft-state-session-gateway.md) — Kafka AcceptedFact
   durability, rebuildable Gateway hot tails and cursor-free snapshot-first SSE.
1. [ADR-0127](0127-authority-gate-and-accepted-fact-bus.md) — one
   ExecutionLease Authority Gate, one logical per-Run FactChannel and a
   broker-neutral AcceptedFactBus before independent downstream projections.
1. [ADR-0124](0124-session-lease-fencing-authority.md) — one durable Session
   lease with a monotonically increasing fence across every Run effect boundary.
1. [ADR-0123](0123-isolated-preview-origins.md) — target-scoped capabilities
   and independent browser origins for untrusted application Preview.
1. [ADR-0120](0120-exclusive-full-vm-authority.md) — exclusive Cube full-VM
   state, restart adoption and the elastic/exclusive durability split.
1. [ADR-0118](0118-session-workspace-environment-and-ssh.md) — independent
   Session/Workspace/compute lifetimes, exclusive Cube Tool bindings and SSH access.
1. [ADR-0111](0111-current-production-architecture.md) — current end-to-end
   architecture, state authorities and scaling boundary.
1. [ADR-0112](0112-run-scoped-tool-capabilities.md) — Session grants, immutable
   Run Tool snapshots and Broker-side execution authorization.
1. [ADR-0113](0113-cloud-native-pi-subagents.md) — upstream-compatible Pi
   subagents on durable Child Sessions/Runs with explicit Workspace modes.
1. [ADR-0114](0114-conversation-subtree-delete-and-tail-prune.md) — recursive
   tree deletion and Pi-native conversation tail pruning.
1. [ADR-0115](0115-user-owned-development-environments.md) — tenant-aware,
   user-owned exclusive Cube development environments.
1. [ADR-0109](0109-postgres-session-reference-checkpoints.md) — PostgreSQL Pi
   SessionStorage as the sole conversation authority.
1. [ADR-0105](0105-pi-session-backend-conformance.md) — compatibility with Pi's
   public Session backend contract.
1. [ADR-0104](0104-human-session-tree-and-conversation-forks.md) — human tree
   navigation and conversation forks.

An ADR absent from this index is not part of the current design. Historical
migration source may contain retired table or component names solely so a new
database can replay the ordered migration chain.
