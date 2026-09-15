# Maintained backlog

This backlog applies only to the current PostgreSQL + Kafka + Pi SDK + Cube
Volume architecture. Historical experiments remain in Git history.

## Reliability

- [x] ADR-0170: use locked PostgreSQL decision time for execution leases,
      conservative monotonic observations and non-overlapping Broker renewal.
      Real lock-wait/skew regressions and paid multi-round/family recovery pass.

- [x] ADR-0169: recover quarantined Sessions after confirmed Agent exit and seal;
      remove unsafe GitHub App onboarding while preserving environment Git
      credentials. Local boundary tests pass; deployed acceptance remains part
      of the current audit gate.

- [x] ADR-0168: remove Workspace settlement/object dependencies and raw Tool
      archives; keep direct Volume/full-VM storage, activation validation and
      live file access. [Implementation and paid acceptance](reports/direct-workspace-storage-20260914.md).

- [ ] Complete the renewed September 15 repository audit and system validation:
      hash/range-based code coverage, real combinations, browser paint latency,
      scoped cleanup and resume update only after completion.
      [Current work record](reports/repository-audit-20260915.md).
      Concurrent tenant admission and cancellation/Workspace-rebind replay now
      have real-PG regressions; the Subagent startup mailbox race is fixed and
      passed paid repetition. A lock-delayed renewal revived an expired lease
      in a controlled real-PG test (TIME-01); the owner approved ADR-0170 and its
      implementation/acceptance passed at `9f62b365`. Other audit and cleanup gates remain open.
      Web product/admin origins now come from deployment configuration rather
      than fixed ports; actual Caddy/Chrome custom-port navigation, Helm routes
      and existing browser interaction checks pass locally.
      Deployed Web repetition passes 93 controls and measures first text paint;
      LOCK-01 has a real lock-loss/Volume-overwrite reproduction. The owner
      approved removing Subagent copies rather than extending the copy protocol
      (ADR-0171); cutover acceptance remains open.

- [x] Separate conversation reads from command/resource writes and physical
      Sandbox admission from Broker lifecycle. Close admission before shutdown;
      retain adopted capacity accounting. Add Projector handoff contracts and
      remove obsolete operational guidance.
      [Consolidation evidence](reports/architecture-consolidation-20260910.md).

- [ ] Explain the original isolated duplicate SSE opening. A focused real-browser
      investigation found 197 ordinary single-request openings and separately
      reproduced the intentional input/snapshot invalidation path, not the
      historical cause. [Evidence](reports/stream-reopen-investigation-20260909.md).

- [x] Review follow-up: make execution openings idempotent across lost PG replies;
      exercise delegated detail reads; replace stale fault targets and verify
      them in CI; bound live snapshots with message-level recovery and SSE framing.
      [Acceptance](reports/review-repair-acceptance-20260909.md).

- [x] ADR-0164: remove per-record signature/key work from private Worker publication;
      keep exact scope, ordered opening/seals and Tool no-replay boundaries.
      [Acceptance](reports/unsigned-publication-acceptance.md).

- [x] ADR-0158: bound Producer queues, Broker execution/HTTP delivery and abandoned
      readers; align configuration and measure publication versus PG receipt wait.
      [Acceptance](reports/bounded-transport-acceptance.md).

- [x] Retire Broker raw responses on native Kafka Tool Result, preserving
      scope/call correlation, no-replay metadata and a bounded retry cache.
      [Acceptance](reports/tool-result-retirement-acceptance.md).

- [x] ADR-0157/0163: route Agent Tool commands through the execution log/Projector; remove
      execution POST, retain read-only result waits and no-replay operation semantics.
- [ ] Implement an approved Cube-native scoped launch-generation contract before
      claiming physical execution fencing; [research and policy tradeoffs](reports/cube-execution-generation-study.md)
      are complete, implementation is not part of the Kafka transport upgrade.
- [x] ADR-0163: close at the Kafka seal, commit the terminal/prefix and update
      the same Projector's live view; remove the second commit notification.
- [x] Classify live records by the actual seal position, isolate paused
      partitions, restore from durable recovery floors and invalidate idle OPEN caches.
- [x] Project prepared native append batches without a timer; preserve Lane ID
      uniqueness and stable append deduplication without a receipt ledger.
- [x] Decouple verified warm Tool execution from per-operation Cube inspection;
      retain private ingress identity and lifecycle checks.
      [ADR-0155 acceptance](reports/isolated-handoffs-acceptance.md).
- [x] Close each retired execution in Kafka order before a successor reads context;
      reject late old records in canonical and SSE paths. Preserve visible prefixes
      across consumer/Worker replacement (ADR-0154).
- [x] Allocate terminal sequence from the accepted stream at its seal, not lagging
      lease progress. Keep delivered Steer distinct from native consumption.
      [Real API/Worker and Cube/browser evidence](reports/execution-stream-seal-acceptance.md).
- [x] ADR-0153.1–2: drain Fact publications before close; bounded transaction-free
      terminal Outbox publication, idempotent retries and consumer failure signals.
- [x] ADR-0153.3: co-commit sampling start and Tool completion with native records.
- [x] Bound latest-state/branch reads; ADR-0161 removes the old receipt mechanism.
- [x] On-demand Tool dependencies; the former standalone canonical role was
      superseded by the unified Session Projector in ADR-0163.
- [x] ADR-0153.7–8: direct Volume/full-VM browsing and one reviewed model catalog.
- [x] Separate persistent machine, Tool and Preview failure boundaries
      (ADR-0151), preserve recovery capsules and first errors, and verify Guest
      execution on adoption; exercise real Cube/service restart acceptance.
- [x] Delegate root-owned Guest file deletion to Cube's existing Controller
      Volume hook; retain generation-bound authority until bytes and metadata
      are removed, including partial failure and lost ACK recovery (ADR-0152).
- [x] Display write/edit generation activity and recover it after browser
      refresh; preserve call/result pairing by publishing World State changes
      only at clean model boundaries and keeping elastic allocation identity stable.
- [x] Replace path-token/buffered Preview with authenticated root-origin HTTP,
      SSE and WebSocket streaming; validate Vite dynamic CSS and HMR.
- [x] Retry premature Responses disconnections without replaying completed Tools,
      retain visible prefixes, reset retry numbering per sampling Step, remove
      the CONNECT tunnel wall-clock expiry and record safe stream-end evidence.
- [x] Remove redundant message handoffs (ADR-0149): SSE heartbeat/snapshot,
      atomic projection receipts, context reads, Tool/Cube RPC, partition
      consumers and browser subscriptions; validate live coding afterward.

- [x] Exercise an offline rebuild of Entry/Lane/Record/label projections from a
      self-contained `pi_session_log` after deliberately removing the derived
      rows.
- [ ] Kill one Kafka broker during concurrent Agent streams and verify
      `acks=all`, consumer recovery and snapshot replacement.
- [x] Restart the canonical consumer around an unsealed prefix and after seal;
      replay idempotently without rewinding canonical state or losing visible text.
      Group offsets are monitoring progress, not a durable prefix checkpoint.
- [x] Kill/restart a Gateway after visible partial output; verify a new browser
      request receives PostgreSQL canonical messages plus the rebuilt Kafka tail.
- [ ] Validate PostgreSQL/PgBouncer failover and Cube compute-node drain on a
      physical multi-node deployment.

## Capacity

- [x] ADR-0167: replace fixed parent/child slots with physical-Session families;
      align PG/local admission, heartbeat and KEDA; fair, abortable model permits
      including Compaction; paid multi-family and recursive acceptance.
      [Acceptance](reports/session-family-acceptance.md).
- [x] ADR-0163: direct Worker append, cached publication scope and one
      Projector group for PG/live/Tool projections; validate cross-replica SSE,
      live Projector/Worker failure and publication throughput.
      [Acceptance](reports/unified-projector-acceptance.md).
- [x] For Kafka-native production cutover, unify active append, Child Lane
      creation and seal-time repair ordering; provide bounded seed/recovery,
      align physical-Session Kafka keys and protect retention against projection lag.
- [x] Replace the old PG-receipt read cache with the acknowledged native Session
      writer. Preserve Compaction, interruption, branch isolation and cold restore.
- [x] Remove per-Step PG waits; preserve Kafka intent before Tool effects, exact
      native projection and seal-gated recovery (ADR-0161).
- [x] Immutable Broker boot routes and owner-direct results; ADR-0163 moved
      Kafka consumption into the Session Projector while retaining positioned
      command delivery. [Earlier routing acceptance](reports/tool-command-sharding.md).

- [x] Replace per-free-Slot scans and separate root/child queues with one claim
      probe per Worker; wake immediately and admit descendants within owned families.
- [ ] Measure AcceptedFact producer p50/p95/p99 with 1/16/64/128 active Sessions.
- [ ] Measure Gateway live-tail bytes per active Turn and 2,000/10,000 SSE
      connections.
- [ ] Measure canonical projector lag and PostgreSQL WAL for complete Pi entries.
- [ ] Validate KEDA Worker scaling and Kafka partition count against the target
      enterprise workload.

## Operations

- [ ] Reconcile Cube Volume node refcounts after host/guest loss: the approved
      reset found three references with no remaining instance or mount.
- [ ] Resolve Cube template/artifact cleanup addresses from stable node identity;
      obsolete Pod-IP locators blocked deletion until offline correction.
- [ ] Choose an explicit local Cube MySQL binlog retention policy. The current
      30-day default accumulated about 113 GiB; cleanup did not change that policy.
      [Reset findings and verification](reports/environment-reset-20260910.md).

- [ ] Run the one-host installer on a clean machine.
- [ ] Add deployment-specific Kafka TLS/SASL/ACL examples.
- [ ] Validate backup/restore and retention changes with active Runs.
- [ ] Replace placeholder Alertmanager delivery with the operator's on-call system.
- [ ] Design GitHub user authorization before reintroducing App onboarding
      (ADR-0169); current tests cover already-bound Webhooks and ordinary
      environment-local credentials, not new App installation.
- [ ] Repeat GitLab project-token/private-clone/Issue-to-Run acceptance against
      an external TLS-enabled self-managed instance after the local CE gate.
- [ ] Validate multi-user non-exclusive GitLab Issue claims and
      both elastic and owned-machine Issue execution against that instance.

## Provider capabilities

- [x] Reject undeclared Bash arguments through Pi's native schema validator
      before execution intent; distinguish Tool preparation/waiting from
      execution and replace rejected preparation rows without duplicate UI.
- [x] Separate Provider connection and streaming-idle timeouts so a long active
      response is bounded by its Turn rather than a 120-second wall clock.
- [x] Detach failed or cancelled Runs from user-owned development machines
      without destroying the KVM or emitting a false sandbox-reset fact.
- [x] Show one durable, argument-free Working activity while Pi assembles a
      Tool Call, replacing it with the complete Tool boundary without storing
      streamed JSON fragments.
- [x] Preserve per-call Hosted Web Search identity and portable action details
      across live Kafka/SSE output and canonical Pi Session reload, with one
      stable searching/searched row per Provider item.
- [x] Keep completed Markdown blocks stable while only the in-flight tail is
      reparsed during streaming.
- [x] Align GPT-5.6 Worker context and native Compaction threshold with the
      deployment's 1,000,000/900,000-token Codex baseline.
- [ ] Measure Standard/Fast latency and usage on every enabled GPT model before
      making Fast a deployment default.
- [ ] Replace the PiCloud-owned Hosted Tool content block when pinned Pi exposes
      a first-class, backend-conformant Responses hosted-item contract.
- [ ] Add the user-image attachment path after its Pi-native image input,
      PostgreSQL SessionStorage and cross-Worker recovery contract passes.
- [ ] Enable Provider image generation only after Pi exposes a portable
      generated-image result that survives Session restore and model handoff.

## Subagent execution

- [ ] ADR-0171: shared persistent Volume, optional temporary compute and frozen
      cwd; remove copy APIs, validate worktree creation/merge and scope-specific
      cleanup. [Current work record](reports/subagent-compute-20260915.md).

- [x] ADR-0166: ordered Projector-driven child admission and communication,
      Worker-owned native Lanes, event-driven result delivery, isolated Cube
      workflow scripts; remove CLI emulation and validate the cutover live.
- [x] Bind every delegated execution scope to a unique lane in its root Pi
      Session while retaining independent Run, event and task-reference identity.
- [x] Keep every active Lane of one physical Pi Session on one Worker, while
      preserving cold-Session reassignment after authority expiry.
- [ ] Measure shared Session writer/Projector throughput at the maximum supported
      child count before raising the default tree and model concurrency.
- [x] Remove persona/role profiles from the cloud contract and keep one
      task-based Subagent Tool, with no CLI or fake Session adapter.
- [x] Keep context inheritance, compute placement and local Tool grants
      explicit and independent.
- [x] Bind elastic and owned-machine Tools on the first actual local operation;
      observe physical continuity at the next clean model boundary.
- [ ] Repeat shared-Workspace Subagent acceptance on a multi-node Cube cluster.
