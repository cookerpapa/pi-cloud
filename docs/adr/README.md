# Current architecture decisions

This directory contains only decisions that constrain the maintained Pi Cloud
product. Superseded experiments and pre-release decisions are intentionally not
kept beside current ADRs; Git history is their archive.

The current append contract is [ADR-0161](0161-kafka-native-session-commit.md).
Earlier PG receipt/cache experiments are preserved in Git history and their
revision-bound reports, not as alternate production backends.

Read the documents in this order:

1. [ADR-0215](0215-unlimited-product-quotas.md) — owner-approved removal of
   default resource/product quotas and streamed uploads; deployed and verified.

1. [ADR-0214](0214-unified-self-hosted-k3s.md) — approved self-hosted K3s
   consolidation, stable Services and owner-approved data reset; deployed and verified.

1. [ADR-0213](0213-control-recovery-and-propagation-budgets.md) — approved control
   recovery repairs and bounded propagation/read improvements; deployed and verified.

1. [ADR-0212](0212-ordered-control-read-models.md) — deployed ordered control
   changes and bounded binding, queue and Subagent read views.

1. [ADR-0211](0211-execution-path-and-runtime-probes.md) — deployed execution-path
   observations and unified physical-runtime probes, with independent stage evidence.

1. [ADR-0210](0210-cube-execution-handoff-and-scoped-stop.md) — native Cube handoff,
   scoped stopping and controller-owned VM recovery.

1. [ADR-0209](0209-control-plane-publication-and-sandbox-authority.md) — owner-approved
   control-plane publication and sandbox authority; deployed with real-model and process-failure acceptance.

1. [ADR-0208](0208-session-lifecycle-matches-atomic-admission.md) — Session states
   aligned with atomic admission and guarded recovery.
1. [ADR-0207](0207-permanent-conversation-deletion.md) — permanent conversation
   deletion, native-history ownership and unused elastic VM reclamation.
1. [ADR-0206](0206-interrupted-output-context.md) — incomplete visible text and
   confirmed interruption reasons in recovered model context.
1. [ADR-0205](0205-bounded-inherited-context-preview.md) — bounded delegated
   context preview with native Compaction summary/tail and explicit truncation.
1. [ADR-0204](0204-bounded-subagent-task-input.md) — delegated task character and
   encoded-byte budgets before native publication and PG admission.
1. [ADR-0203](0203-consumption-confirmed-direct-steer.md) — durable direct Steer,
   consumption confirmation and restoration through the existing input queue.
1. [ADR-0202](0202-development-machine-workspace-rebinding.md) — recover a missing
   Workspace using a user-owned development machine and selected directory.
1. [ADR-0201](0201-runtime-activity-and-path-probes.md) — runtime activity,
   Session path probes and independent PG-time lease sweeps.
1. [ADR-0200](0200-workspace-uploads-and-user-image-input.md) — Workspace file uploads,
   durable input attachments and native user image content.
1. [ADR-0199](0199-bounded-publication-and-projection.md) — proved publication
   rejection isolation, shared projection waits, phase timings and bounded SQL work.
1. [ADR-0198](0198-atomic-tool-invocation.md) — one atomic remote Tool intent and
   command publication, preserving native hooks and commit-before-dispatch.
1. [ADR-0197](0197-indexed-native-session-log.md) — one indexed native log body,
   independent Fork copies and bounded current operation state.
1. [ADR-0196](0196-bounded-subagent-results.md) — bounded Subagent returns that
   fit native history, with explicit errors and unchanged effect semantics.
1. [ADR-0195](0195-final-tool-reply-lifetime.md) — final-only Tool replies and
   bounded callback lifetime across publication, cancellation and image decoding.
1. [ADR-0194](0194-editable-pending-inputs.md) — editable pending inputs,
   ordered queue mutations and consumption-confirmed promotion to steer.
1. [ADR-0193](0193-native-run-lifecycle-boundaries.md) — native input closure,
   per-sampling retry state, compaction usage freshness and Run-local cancellation.
1. [ADR-0192](0192-session-image-attachments.md) — immutable image attachments,
   reference-only Kafka transport and lossless native Session decoding.
1. [ADR-0191](0191-gpt6-model-catalog.md) — GPT-6 selection migration and
   verified DeepSeek search availability.
1. [ADR-0190](0190-gitlab-issue-note-convergence.md) — short-transaction GitLab
   note synchronization, independent reconciliation and remote convergence.

1. [ADR-0189](0189-guest-build-input-identity.md) — guest build-input identity
   independent of the platform Git revision, with existing image/READY checks.
1. [ADR-0188](0188-bounded-conversation-discovery.md) — bounded conversation-list
   paging; no change to cursor-free SSE.
1. [ADR-0187](0187-model-retry-ownership.md) — Runner-owned sampling retry,
   one Gateway send and separate provider credential selection.
1. [ADR-0186](0186-runner-and-guest-pi-parity.md) — guest cwd/file semantics,
   eligible native Tool parallelism and one sampling-preparation path.
1. [ADR-0185](0185-native-record-and-invocation-contract.md) — native Step/Tool
   ordinals, result-Entry invocation identities and trusted Pi hooks.

1. [ADR-0184](0184-ephemeral-tool-progress.md) — lossy Tool progress through
   internal HTTP and SSE; final results alone return through Kafka.

1. [ADR-0183](0183-native-remote-tool-execution.md) — whole guest-side Tools,
   native Pi Kafka replies and commit-before-dispatch without effect replay.

1. [ADR-0182](0182-assistant-message-presentation.md) — complete commentary and
   streaming final answers using verified provider phases; no prose heuristics.

1. [ADR-0181](0181-review-repair-boundaries.md) — HTTP-only Steer delivery,
   revocable model uploads, native usage without dormant accounting, and
   transaction-local SQL consolidation.

1. [ADR-0180](0180-run-identity-and-session-ownership.md) — one Run execution
   identity, lease-owned Session writer and Worker-local capacity, replacing
   independent Attempt/PG slot bookkeeping.

1. [ADR-0179](0179-ready-runs-and-single-admission.md) — durable Lane readiness,
   bounded family closure state and one atomic execution admission.

1. [ADR-0178](0178-admission-and-first-record.md) — admitted execution without
   separate startup commits or opening records; first-record recovery floor.

1. [ADR-0177](0177-terminal-wake-and-local-sql.md) — commit-time seal wake hints
   and fewer SQL round trips without moving durable boundaries.

1. [ADR-0176](0176-bounded-context-overflow-recovery.md) — Pi-native bounded
   overflow compaction and sampling continuation without Tool replay.

1. [ADR-0175](0175-bounded-parallel-claims.md) — approved two-way claim trial,
   conservative pending capacity and unchanged PG authority.

1. [ADR-0174](0174-atomic-worker-admission.md) — one claim/lease/publication
   transaction, with running/first-record placement refined by ADR-0178.

1. [ADR-0173](0173-startup-context-reuse.md) — single candidate selection, claimed
   metadata reuse and fewer state-transition round trips; admission boundaries
   now follow ADR-0174.

1. [ADR-0172](0172-plugin-owned-volume-initialization.md) — one plugin-owned
   identity publication, read-only Gateway verification and non-destructive seeds.

1. [ADR-0171](0171-shared-volume-subagent-compute.md) — explicit child cwd and
   temporary compute scopes on a shared Volume; user-managed Git worktrees.

1. [ADR-0170](0170-postgres-authority-time.md) — database decision-time authority
   after lock waits; monotonic local cancellation observations.

1. [ADR-0169](0169-confirmed-session-recovery-and-github-entry.md) — resume a
   quarantined Session only after confirmed exit and seal; remove unauthenticated
   GitHub App installation binding.

1. [ADR-0168](0168-direct-workspace-storage.md) — direct Volume/full-VM file
   storage and live browsing, without per-Run objects or raw Tool-output archives.

1. [ADR-0167](0167-session-family-capacity.md) — active physical-Session capacity
   and independent model-request fairness.
1. [ADR-0166](0166-log-driven-subagents.md) — Projector-admitted Subagent control,
   Worker-native Lanes and Cube-isolated workflows.
1. [ADR-0165](0165-message-level-display-and-framed-snapshots.md) — idempotent
   projection, message-level display coverage and bounded SSE snapshot framing.
1. [ADR-0164](0164-trusted-private-log-publication.md) — unsigned publication on
   trusted private infrastructure; retain scope/recovery/seal boundaries.
1. [ADR-0163](0163-direct-log-and-unified-projector.md) — direct Worker log,
   one Session Projector group, direct terminal projection and owner-routed SSE.

1. [ADR-0162](0162-sharded-tool-command-routing.md) — positioned owner routing,
   exact owner boots; native Kafka replies follow ADR-0183.
1. [ADR-0161](0161-kafka-native-session-commit.md) — Kafka-acknowledged native
   Session storage, shared Lane ordering, bounded restore and safe retention.
1. [ADR-0158](0158-bounded-transport-backpressure.md) — bounded Producer/Broker
   transport and shared configuration; native commit placement follows ADR-0161.
1. [ADR-0154](0154-ordered-execution-stream-seals.md) — ordered Run closure
   before handoff, shared canonical/live cutoff and interrupted-prefix recovery.
1. [ADR-0152](0152-volume-deletion-and-tool-preparation.md) — native Volume
   deletion with retained authority and visible write/edit preparation.
1. [ADR-0151](0151-development-machine-failure-boundaries.md) — separate Tool,
   machine and application failures; retain exclusive VM recovery authority.
1. [ADR-0150](0150-root-origin-streaming-preview.md) — root-origin application
   preview with scoped Cookies and streaming HTTP/WebSocket transport.
1. [ADR-0148](0148-two-phase-tool-effect-checkpoint.md) — two atomic
   post-sampling checkpoints distinguish complete model output, validated Tool
   intent and the later effect.
1. [ADR-0147](0147-self-contained-pi-session-event-log.md) — one
   self-contained append-only semantic log per physical Pi Session, with
   rebuildable query projections and context-independent Subagent communication.
1. [ADR-0145](0145-fork-and-branch-semantics.md) — Fork creates an independent
   Session; delegated inherited context is a Branch/Lane.
1. [ADR-0144](0144-subagent-pi-session-lanes.md) — shared Pi Session Entry
   trees with owner-local, lane-bound Subagents.
1. [ADR-0143](0143-hosted-search-activity-and-stable-markdown.md) — per-call
   Provider Web Search activity and stable-region Markdown streaming.
1. [ADR-0142](0142-session-model-settings-and-fast-tier.md) — complete
   next-Turn model settings and GPT Fast service tier.
1. [ADR-0141](0141-provider-hosted-transcript-items.md) — Codex-shaped Hosted
   Web Search items and exact-route replay in Pi SessionStorage.
1. [ADR-0140](0140-native-responses-provider-gateway.md) — native Responses
   passthrough for Provider-hosted DeepSeek Web Search.
1. [ADR-0139](0139-provider-native-model-capabilities.md) — Provider-native
   model capabilities and hosted Tools.
1. [ADR-0138](0138-subscription-provider-gateway.md) — CLIProxyAPI model-supply
   authority, native provider protocols, Session affinity and separate operator UI.
1. [ADR-0137](0137-code-host-connections.md) — independent PiCloud identity,
   Issue intake and environment-scoped Code Host connections.
1. [ADR-0136](0136-workspace-owned-elastic-runtime.md) — one physical elastic
   Cube per Workspace with independently fenced concurrent Tool bindings.
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
1. [ADR-0123](0123-isolated-preview-origins.md) — target-scoped capabilities
   and independent browser origins for untrusted application Preview.
1. [ADR-0120](0120-exclusive-full-vm-authority.md) — exclusive Cube full-VM
   state, restart adoption and the elastic/exclusive durability split.
1. [ADR-0118](0118-session-workspace-environment-and-ssh.md) — independent
   Session/Workspace/compute lifetimes, exclusive Cube Tool bindings and SSH access.
1. [ADR-0112](0112-run-scoped-tool-capabilities.md) — Session grants, immutable
   Run Tool snapshots and Broker-side execution authorization.
1. [ADR-0114](0114-conversation-subtree-delete-and-tail-prune.md) — recursive
   tree deletion and Pi-native conversation tail pruning.
1. [ADR-0105](0105-pi-session-backend-conformance.md) — compatibility with Pi's
   public Session backend contract.
1. [ADR-0104](0104-human-session-tree-and-conversation-forks.md) — human tree
   navigation and conversation forks.

An ADR absent from this index is not part of the current design. Historical
migration source may contain retired table or component names solely so a new
database can replay the ordered migration chain.
