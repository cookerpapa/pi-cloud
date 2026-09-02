# Maintained backlog

This backlog applies only to the current PostgreSQL + Kafka + Pi SDK + Cube
Volume architecture. Historical experiments remain in Git history.

## Reliability

- [ ] Kill one Kafka broker during concurrent Agent streams and verify
      `acks=all`, consumer recovery and snapshot replacement.
- [ ] Kill the canonical projector after PostgreSQL commit but before Kafka
      offset commit; verify idempotent redelivery.
- [ ] Kill/restart a Gateway after visible partial output; verify a new browser
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
