# Current architecture decisions

[ADR-0264](0264-subagent-recovery-and-discovery.md) is **accepted**, with prototype and
implementation pending; it is not yet a deployed runtime contract. The [repair plan](../reports/resource-interaction-repair-plan-20261020.md)
uses pinned Pi examples to propose recoverable direct delegation, target-free
child discovery and separate safe/unsafe Tool registrations. It requires native
and PG/RF3 failure proof before implementation; boot mailboxes and unsafe
shell/workflow semantics remain deployed as described by existing ADRs.

[ADR-0263](0263-model-response-and-work-lifetimes.md) records the owner-approved
model-response and unbounded-work repair: response semantics at public Models,
native hosted progress carriers, preserved native retry classification, distinct
transport/model outcomes and owner-bound capabilities with bounded Worker
retirement. It is deployed as `model-runtime-058925bb`, schema 192;
[delivery](../reports/model-runtime-repair-20261020.md) records required source,
artifact, long-work/handoff and live acceptance, retained failed samples and cleanup.

[ADR-0262](0262-native-recovery-read-lifetimes.md) records the approved native
recovery repair: bounded/cancellable Worker reads, same-Run continuation through
ordered closure, indexed pending Submissions and native child reattachment.
It is deployed as `native-recovery-8c00826a`, schema 191. [Delivery](../reports/worker-harness-recovery-repair-20261019.md)
records passing source/artifact, native/browser, child Worker recovery, Control Plane
outage, large-image cold recall and full-Cube/cleanup verification.
Public hooks do not encompass context reads, so image reuse stays within one decode.

[ADR-0261](0261-session-seal-projection-boundaries.md) records the approved closure
projection repair: bounded PG I/O, writer-owned disposable live views, bounded
checkpoint proof lookup and transaction-local Run reuse. It is deployed as
`seal-projection-0de1fe7f`; [verification/delivery](../reports/seal-projection-repair-20261019.md)
record passing source/artifact and native/browser/child/outage/full-Cube gates,
retained failures and confirmed physical/configuration cleanup. Large-image cold
recall remained unaccepted in that release after model response-header timeouts;
the current recovery release passes the unchanged gate. Current authorities
and protocols remain.

[ADR-0260](0260-session-seal-publication-lifetimes.md) records the owner-approved
seal publication repair: bounded PG metadata work, reader-owned transaction
retirement and cached peer rediscovery. It is deployed as
`seal-publication-8d9e7bc2`; [verification/delivery](../reports/seal-publication-repair-20261019.md)
record passing source/artifact/live gates, retained provider failures and confirmed
physical/configuration cleanup.
The existing Session/Outbox/Kafka authorities and wire schemas are preserved.

[ADR-0259](0259-control-plane-expiry-progress.md) implements independent bounded
maintenance, paged Session candidates, failed Worker retirement admission and
transaction-local SQL reuse. It is deployed as `control-expiry-c9d8112d`, schema
190. [Delivery evidence](../reports/control-plane-expiry-repair-20261018.md) records
source/artifact/live gates, retained failed samples and confirmed fixture cleanup
with original configuration fingerprints preserved.

[ADR-0258](0258-bounded-session-lease-renewal.md) implements independent local
expiration, bounded lease database I/O, local revocation before quarantine and
nonblocking batched renewal with explicit deferral. The private acknowledgement
changes are deployed on matched Worker/Control Plane artifacts as
`session-lease-079dbddc`. [Delivery evidence](../reports/session-lease-repair-20261018.md)
records passing gates, real recovery/control-independent renewal and confirmed
configuration/physical cleanup, retaining the initial failures separately.

[ADR-0257](0257-browser-observation-and-buffer-boundaries.md) records the approved
Projector/browser repair: reuse the existing execution generation in disposable
observations, account for pending SSE bytes, compact same-message commentary and
correct streaming documentation. It refines the review's resync-first suggestion
after inspecting the queued recovery interval. It is deployed as
`browser-delivery-205e6ac0`; [verification and release](../reports/projector-browser-repair-20261018.md)
record passing source/artifact/live gates, the Go test-directory correction,
same-SSE generation recovery and confirmed configuration/physical cleanup.

[ADR-0256](0256-session-publication-and-completion-boundaries.md) records the
approved publication/completion repair: terminal replay, definite pre-send
refusal, transaction-local Run reuse and current lifecycle documentation.
It is deployed as `session-completion-6e74fd5b`. The
[delivery record](../reports/session-publication-completion-repair-20261018.md)
records passing source/artifact/live gates, retained failed samples, confirmed
fixture cleanup and unchanged configuration fingerprints.

[ADR-0255](0255-native-tool-result-boundaries.md) records the approved settlement
repairs: native 50 KiB/2,000-line coordination result admission, metadata-only
sequence reads and strict native/packed Tool result shapes. It replaces the old
256 KiB result policy without changing Pi's canonical settlement authority.
It is deployed as `tool-settlement-20ac9696`; the
[delivery record](../reports/worker-harness-settlement-repair-20261018.md) separates
source, artifact and real Luna/Cube verification and confirms cleanup.

[ADR-0254](0254-worker-reply-admission-and-settlement.md) records the approved
Kafka → Worker repair plan following the owner's thin-admission decision:
local reply health, removal of provider HEAD admission gates, same-boot volatile
resume and separate receipt/attachment settlement. The repair is deployed as
`worker-reply-b1f67dba`; [verification](../reports/worker-reply-repair-20261017.md)
records source/artifact gates, real Luna/Cube/recovery checks and confirmed cleanup
after host KVM restoration.

[ADR-0253](0253-tool-reply-uncertainty-and-continuation.md) records the approved
implementation of bounded fixed-Tool UNKNOWN continuation using existing
execution probes. [Verification](../reports/tool-reply-continuation-20261016.md)
is complete and deployed as `tool-unknown-791a6ed0`. The bounded exception
preserves ownership/closure checks, native Stop and probe isolation from
history/context; automatic unknown Volume-reference recovery remains separate.

[ADR-0252](0252-tool-receipt-and-ephemeral-preview.md) is accepted and implemented
in source: receipt-only failure classification, source terminal-aware previews
and bounded delta/reset delivery over existing HTTP/SSE. The
[delivery record](../reports/tool-receipt-preview-repair-20261016.md) separates
passing source/artifact/live gates and the deployed `tool-preview-325f0ebd` from
earlier failed samples. Windows rollback restored KVM; the measured SSE recovery
corrected a too-short fixture deadline, and all required acceptance now passes.
The pre-existing external AnyTLS-path issue remains separately documented.

[ADR-0251](0251-guest-attachment-and-execution-bounds.md) is the deployed guest
execution repair: bounded native cleanup/startup, native Read path parity and
separate initialization/attachment messages. It is deployed as
`guest-execution-5536fc73`, guest protocol 6 / descriptor 2, retaining PG 189,
execution Topic v17, boot reply v3 and Cube management 7.
[Acceptance evidence](../reports/cubelet-guest-execution-repair-20261015.md)
records full source/live checks and preserved configuration.

[ADR-0250](0250-cube-handoff-outcomes-and-runtime-admission.md) repairs failure
notification/evidence, exact binding lookup and removed-VM admission. It is
deployed as `handoff-6ab91bb7`, retaining schema 189 / topic v17 / guest 5.
[Acceptance evidence](../reports/projector-cube-handoff-repair-20261015.md)
includes native race tests, real Luna/Cube/browser/child recovery and cleanup.

[ADR-0249](0249-compact-projector-publication.md) implements the
October 15 Projector review: minimal prefix state, compact publication, shared
dispatch preparation, Tool presentation references and fixed/workflow request
separation. It was deployed as `projector-compact-bf55d9bd` and remains in the
current release, preserving the ownership and recovery contracts below.

This directory contains only decisions that constrain the maintained Pi Cloud
product. Superseded experiments and pre-release decisions are intentionally not
kept beside current ADRs; Git history is their archive.

The current append contract is [ADR-0161](0161-kafka-native-session-commit.md).
Earlier PG receipt/cache experiments are preserved in Git history and their
revision-bound reports, not as alternate production backends.

Current ownership and publication: [ADR-0247](0247-session-work-and-tool-dispatch.md)
consolidates Session ownership, root cloud work, native Subagents, unified Tool
dispatch/replies, writer closure and direct Kafka publication. It is deployed as
`session-work-6ac697f9` under schema 188 / topic v16 / boot reply v3.
It replaces the earlier ADR-0246 draft, archived in Git, and supersedes the
Worker-ingress/child-Run clauses in ADR-0209/0229/0238.

Current management reconnect: [ADR-0248](0248-idle-worker-management-reconnect.md) separates
idle management-connection expiry from Boot retirement, with claim/registration
race gates. It is deployed as `worker-reconnect-5b6ba003` under schema 189, retaining
ADR-0247 Session ownership and execution-topic v16 / boot reply v3.

Read the documents in this order:

1. [ADR-0247](0247-session-work-and-tool-dispatch.md) — one cloud root work item,
   native descendants, one Session writer and unified Tool dispatch/replies.

1. [ADR-0245](0245-native-commit-text-presentation.md) — removes the extra Kafka
   assistant-text copy through same-commit display descriptions; implemented and
   deployed as `native-text-c9b8b2a3`, schema 187 / execution-topic v15.

1. [ADR-0244](0244-kafka-backed-native-live-state.md) — Kafka retention of native
   live progress, PG boundary/handoff checkpoints, and protected recovery ranges.
   Deployed under schema 186, including native recovery and full Cube acceptance.

1. [ADR-0243](0243-native-input-current-state.md) — native Inbox/input metadata and
   Submission current values, atomic consumption and checked history/state reconstruction;
   deployed with schema 185 and real Worker-crash/native-input/browser acceptance.

1. [ADR-0242](0242-worker-claim-schema-cleanup.md) — indexed Worker admission and
   control history, removal of unused physical-Session metadata, and Worker table naming.

1. [ADR-0241](0241-missing-working-directory-tool-errors.md) — report confirmed
   user-directory loss as a native Tool error, retaining infrastructure UNKNOWN.

1. [ADR-0240](0240-transaction-scoped-input-admission.md) — reuse locked Session
   and fresh idempotency reads within a single input-admission transaction;
   deployed with real HTTP/Luna/Cube/browser acceptance.

1. [ADR-0239](0239-projection-query-and-replay-writes.md) — combine native projection
   authority reads and avoid unchanged replay writes, preserving PG locking and cutoffs;
   deployed with real Luna/Cube/browser acceptance.

1. [ADR-0238](0238-native-input-queue-and-run-record.md) — approved native human
   input queue, durable edits and Session/Run record consolidation; deployed with schema 183.

1. [ADR-0237](0237-private-pilot-asset-recovery.md) — optional cold conversation/image
   recovery through PG/S3, with fresh Workspaces and no old execution grants.

1. [ADR-0236](0236-recovery-input-identity-and-tool-diagnostics.md) — execution-based
   recovery, returned-input identity and native Tool diagnostics; verified and deployed.
1. [ADR-0235](0235-upload-staging-recovery.md) — filesystem-owned upload staging,
   cross-process cleanup exclusion and recoverable guest locators; source implemented.
1. [ADR-0234](0234-volume-gateway-shared-access.md) — shared browsing/upload access,
   narrow credential exclusion and exclusive Volume lifecycle; verified and deployed.
1. [ADR-0233](0233-template-cleanup-node-routing.md) — template and rootfs cleanup
   follows stable node identity through current discovery, retaining unresolved targets;
   deployed and verified against the historical backlog.
1. [ADR-0232](0232-indexed-native-navigation.md) — thin native navigation
   classification and bounded independent-Fork history copying; deployed.
1. [ADR-0231](0231-volume-filesystem-mutation-locks.md) — filesystem-held Volume
   Gateway mutation locks, independent of PG connection lifetime; deployed.
1. [ADR-0230](0230-complete-tool-call-publication.md) — incomplete Tool calls stay
   in Worker memory; only complete model responses expose calls to native persistence.
1. [ADR-0229](0229-native-durable-runtime.md) — native adoption of Pi Durable
   1.0 execution semantics; implemented, verified and deployed.
1. [ADR-0228](0228-pi-durable-evaluation.md) — isolated Pi Durable 1.0 commit and
   remote Tool verification; no production runtime adoption.
1. [ADR-0227](0227-review-recovery-and-tool-outcomes.md) — recoverable POSIX
   cleanup, bounded controller ownership, consistent Tool outcomes and wider Read concurrency.
1. [ADR-0226](0226-recoverable-volume-reference-state.md) — durable node reference
   state and attachment admission for managed Cube Volume deletion.
1. [ADR-0225](0225-structured-tool-completion.md) — typed execution failures on
   the boot reply transport; native Tool text cannot control Run liveness.
1. [ADR-0224](0224-review-lifecycle-boundaries.md) — accepted cleanup budgets,
   staged recovery, PG decision time and shared native model request policy.
1. [ADR-0223](0223-recoverable-vm-allocation.md) — stable VM creation identity,
   queryable outcomes, node boot fencing and irreversible allocation closure.
1. [ADR-0222](0222-paused-inputs-after-stop.md) — historical deployed input pause (replaced by deployed ADR-0229),
   independent fresh input and explicit queue/individual continuation.
1. [ADR-0221](0221-pi-tool-cancellation.md) — Pi-style operation cancellation,
   bounded result settlement and durable abnormal-retirement intent.
1. [ADR-0220](0220-agent-stop-is-not-process-control.md) — removal of VM/process
   lifecycle coupling and nullable Kafka metadata recovery; Tool cancellation is
   superseded by ADR-0221.
1. [ADR-0219](0219-ordered-cube-admission.md) — bounded Cube destination progress
   and controller replacement; Run/process stopping is superseded by ADR-0220.
1. [ADR-0218](0218-review-boundary-repairs.md) — approved follow-up input, time,
   cleanup and verification boundary repairs; implemented and deployed.
1. [ADR-0217](0217-declarative-cube-release.md) — one fully rendered Cube Helm
   release and a narrower completion image dependency boundary.
1. [ADR-0216](0216-review-data-path-bounds.md) — approved bounded queue
   presentation, streamed image preparation and review correctness repairs.
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
   native timeout cleanup and controller-owned VM recovery; Agent Stop follows ADR-0220.

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
