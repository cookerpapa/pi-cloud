# Maintained backlog

This backlog applies only to the current PostgreSQL + Kafka + Pi SDK + Cube
Volume architecture. Historical experiments remain in Git history.

## Reliability

- [x] Keep non-JSON HTTP 5xx from Worker ingress retryable, so temporary Pod
      unavailability does not permanently block retirement. Malformed HTTP 200
      remains a protocol error; gateway/Worker regression tests pass.

- [x] Carry shared Kafka Producer capacity into typed Worker configuration and
      both deployment modes; keep retention on the safe Projector reaper only.
      Before/after config contracts and real R=3 overload/retention checks pass.

- [x] Align platform Helm Service names, Kafka/Volume egress and bootstrap Secret
      permissions. Render contracts and owned K3s before/after probes pass; this
      is not certification of a full multi-node deployment.

- [x] Make distributed preflight cluster-read-only and derive Secret/PVC checks
      from rendered workloads. Custom-key/disabled-component regressions and
      actual K3s missing-key/unchanged-namespace checks pass. Remove retired
      Helm schema fields and unsupported deployment claims.

- [x] Match Compose Worker UID/GID to initialized boot storage and mounted
      Secrets. Non-default UID before/after container probes and installer
      regression pass; remove the unused provider-egress network definition.

- [x] Reject stale conversation-list refreshes after deletion, distinguish
      identity-service failure from logout, and preserve pending-input and
      read-only Child view boundaries. Real Chrome regression coverage passes.

- [x] Preserve the Web Terminal close handshake on queue overload instead of
      terminating its socket before the Close frame arrives. Cover byte and
      frame bounds plus queued-input cancellation with real WebSocket tests.

- [x] Bind navigation entries to their recorded Turn, read tree heads/history in
      one snapshot, and preserve those bindings through human Fork/rebuild.
      Seven real-PG regressions also cover missing-Workspace Fork responses.
      Final deployed repetition remains part of the repository audit gate.

- [x] ADR-0172: plugin-owned atomic Volume identity and non-overwriting guest
      seeding. Native concurrent/SIGKILL tests, matching rollout, paid warm/cold
      coding and three live twenty-request creation waves pass at `18e96210`.

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
      (ADR-0171); shared-Volume compute cutover and live acceptance now pass.
      Cancelled guest uploads now retire their temporary input before dispatch,
      with real Cube adapter proof; readiness errors retain their cause. Remaining
      Worker bookkeeping retirement now passes (below); final combination gates
      are still open.
      Delayed cancellation no longer blocks unrelated family admission in local
      regressions; shutdown still joins it. Query profiling identified substantial
      claim-planning time; no unvalidated planner/driver change has been deployed.
      CI also exposed an unhandled idle PG pool error. Child-process/real-PG
      fault proof passes after installing pg's standard error listener, with no
      query retry; deployed paid stream survival, product-surface repetition and
      CI now pass. Wider repository coverage and combination gates remain open.
      Docker context filtering now excludes private runtime/cache files while a
      real scratch-build CI probe preserves every local COPY input. Chrome
      acceptance also rejects calls after debugger disconnection instead of hanging;
      actual browser disconnect and presentation regressions pass.
      Removed the uncalled Bash test-command classifier and its self-only tests;
      current Subagent ADRs now describe shared-Volume compute and one family lease.
      Claim profiling confirms repeated plan generation is a major cost. Bounded
      pg-native prepared SELECTs now reuse plans without changing SQL/authority,
      parameter serialization or retry behavior. Real-PG binding/cache-bound,
      rollback, idle loss and saturated-pool cancellation tests pass. Per-client
      statement namespaces also cover the multiplexed test backend. Full CI and
      paid coding/provider/multi-tenant repetition pass at `211767bd`; live queue
      latency and a separate cold Kafka opening delay remain under investigation.
      Successful claims now expose sequential stage timing, without additional
      SQL or high-cardinality labels, to separate connection/transaction waits
      from selection, ownership and lifecycle work before further optimization.
      Completed Worker bookkeeping now has PG-confirmed retirement, off the
      Run/Step path. Local GC, failed-check/newer-owner races, full CI and deployed
      paid multi-round/replay checks pass at `32e40930`; unknown controls are kept.
      Startup failure now rejects queued Steer/child-input waiters instead of
      stranding them. Removed unused synchronous Step capture and old settlement
      extension code; tests exercise the actual production controllers.
      Remote Tools now expose native Agent tools/hooks directly, without a fake
      Extension API, handler registry or unused CLI Bash hook. Hosted Search
      replay preserves the order of adjacent trailing search items.

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
- [x] Reconcile concurrent Steer delivery replies against the committed control
      row; never report a late failure over success or fabricate a delivery
      timestamp after losing the terminal update. Unknown replies remain unknown.
- [x] Discard late registration replies for closed Worker sockets; do not evict
      the replacement connection or resurrect entries after shutdown.
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
- [x] Remove redundant message handoffs: SSE heartbeat/snapshot, context reads,
      Tool/Cube RPC and browser subscriptions. Kafka-native append and unified
      projection (ADR-0161/0163) supersede the earlier PG-receipt experiment.

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

- [x] Preserve local Worker running/stopped state through cutover rollback and
      confirm Kubernetes executor shutdown before restoring Compose. Partial
      switch/uninstall failure contracts pass; readiness rejects stale images.

- [x] Detect stale/missing operational sampling per Control Plane replica;
      a healthy sibling must not mask it. Native Prometheus rule regressions
      cover stale, missing, healthy and unreachable targets.

- [x] Bridge Kafka (including advertised broker names) and the Provider Gateway
      into local Kubernetes Workers; preserve configured capacities through
      cutover. Helm and native K3s before/after connection checks pass. Complete
      fresh k3d rollout remains part of the installer acceptance below.

- [x] Support custom Worker Secret key names without changing mounted file paths;
      use `IfNotPresent` for the generic Worker chart while local image import
      explicitly retains `Never`. Custom-key and full-chart render checks pass.

- [ ] Reconcile Cube Volume node refcounts after host/guest loss: the approved
      reset found three references with no remaining instance or mount.
- [ ] Resolve Cube template/artifact cleanup addresses from stable node identity;
      obsolete Pod-IP locators blocked deletion until offline correction.
- [ ] Choose an explicit local Cube MySQL binlog retention policy. The current
      30-day default accumulated about 113 GiB; cleanup did not change that policy.
      [Reset findings and verification](reports/environment-reset-20260910.md).

- [ ] Run the one-host installer on a clean machine.
- [ ] Add deployment-specific Kafka TLS/SASL/ACL examples.
- [ ] Validate deployment-owned, coordinated PG/Kafka/Cube backup and restore.
      The retired one-host archive CLI is removed; PiCloud does not claim an
      automatic whole-system restore path.
- [ ] Replace placeholder Alertmanager delivery with the operator's on-call system.
- [ ] Design GitHub user authorization before reintroducing App onboarding
      (ADR-0169); current tests cover already-bound Webhooks and ordinary
      environment-local credentials, not new App installation.
- [ ] Repeat GitLab project-token/private-clone/Issue-to-Run acceptance against
      an external TLS-enabled self-managed instance after the local CE gate.
- [ ] Validate multi-user non-exclusive GitLab Issue claims and
      both elastic and owned-machine Issue execution against that instance.

## Provider capabilities

- [x] Temporarily hide DeepSeek Flash from conversation/admin model selection:
      V4.1 Flash ignores native search on the current Responses route. Keep Pro,
      existing selections and history; do not switch protocols or add a search tool.

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

- [x] Keep delegated task views read-only: disable human Fork/prune actions for
      both inherited and fresh-context children; preserve ordinary conversation
      actions. Actual Chrome parent/child switching regression passes.

- [x] ADR-0171: shared persistent Volume, optional temporary compute and frozen
      cwd; remove copy APIs, validate worktree creation/merge and scope-specific
      cleanup. [Acceptance](reports/subagent-compute-20260915.md).

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
