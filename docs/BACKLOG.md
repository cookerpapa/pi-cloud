# Maintained backlog

This backlog applies only to the current PostgreSQL + Kafka + Pi SDK + Cube
Volume architecture. Historical experiments remain in Git history.

## Reliability

- [x] ADR-0157: route Agent Tool commands through the Fact Gate/Kafka; remove
      execution POST, retain read-only result waits and no-replay operation semantics.
- [ ] Implement an approved Cube-native scoped launch-generation contract before
      claiming physical execution fencing; [research and policy tradeoffs](reports/cube-execution-generation-study.md)
      are complete, implementation is not part of the Kafka transport upgrade.
- [x] ADR-0156: close at the Kafka seal and announce the terminal on its durable
      commit notification, without Gateway per-seal SELECT/polling. Preserve
      bounded successor buffering, duplicate delivery and restart recovery.
- [x] ADR-0155: classify live records by the actual seal position, isolate paused
      partitions, restore from durable recovery floors and invalidate idle OPEN caches.
- [x] Batch native append SQL without a timer; preserve concurrent Lane ID uniqueness
      and rejected-operation outcomes beyond short receipt retention.
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
- [x] ADR-0153.4: compact idempotency receipts and bounded latest-state/branch reads.
- [x] ADR-0153.5–6: optional canonical projection role and on-demand Tool dependencies.
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

- [x] Replace per-free-Slot scans with one concurrent claim probe per queue kind;
      wake immediately after a successful claim and preserve Child capacity.
- [ ] Measure AcceptedFact producer p50/p95/p99 with 1/16/64/128 active Sessions.
- [ ] Measure Gateway live-tail bytes per active Turn and 2,000/10,000 SSE
      connections.
- [ ] Measure canonical projector lag and PostgreSQL WAL for complete Pi entries.
- [ ] Validate KEDA Worker scaling and Kafka partition count against the target
      enterprise workload.

## Operations

- [ ] Run the one-host installer on a clean machine.
- [ ] Add deployment-specific Kafka TLS/SASL/ACL examples.
- [ ] Validate backup/restore and retention changes with active Runs.
- [ ] Replace placeholder Alertmanager delivery with the operator's on-call system.
- [ ] Run live GitHub App installation/private-clone/Issue-to-Run acceptance on
      a public HTTPS deployment; deterministic tests use a fake GitHub API and
      local credentialed Git fixture.
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

- [x] Bind every delegated execution scope to a unique lane in its root Pi
      Session while retaining independent Run, event and ExecutionLease identity.
- [x] Keep every active Lane of one physical Pi Session on one Worker, while
      preserving cold-Session reassignment after authority expiry.
- [ ] Measure shared Pi Session sequence-row contention at the maximum supported
      concurrent Child count before raising the default tree concurrency.
- [x] Remove persona/role profiles from the cloud contract and keep one neutral
      upstream-compatible Child selector.
- [x] Keep context inheritance, Workspace placement and local Tool grants
      explicit and independent.
- [x] Bind elastic and owned-machine Tools on the first actual local operation;
      observe physical continuity at the next clean model boundary.
- [ ] Repeat shared-Workspace Subagent acceptance on a multi-node Cube cluster.
