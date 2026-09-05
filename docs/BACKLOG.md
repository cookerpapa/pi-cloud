# Maintained backlog

This backlog applies only to the current PostgreSQL + Kafka + Pi SDK + Cube
Volume architecture. Historical experiments remain in Git history.

## Reliability

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
- [ ] Kill the canonical projector after PostgreSQL commit but before Kafka
      offset commit; verify idempotent redelivery.
- [x] Kill/restart a Gateway after visible partial output; verify a new browser
      request receives PostgreSQL canonical messages plus the rebuilt Kafka tail.
- [ ] Validate PostgreSQL/PgBouncer failover and Cube compute-node drain on a
      physical multi-node deployment.

## Capacity

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
- [x] Activate elastic Cube only on the first actual local Tool operation,
      while prebinding owned machines to preserve physical-continuity semantics.
- [ ] Repeat shared-Workspace Subagent acceptance on a multi-node Cube cluster.
