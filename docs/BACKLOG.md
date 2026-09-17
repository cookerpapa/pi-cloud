# Maintained backlog

Only unfinished work for the PostgreSQL + Kafka + Pi SDK + Cube Volume
architecture belongs here. Implemented contracts live in the
[architecture](ARCHITECTURE.md), [current ADRs](adr/README.md) and versioned
acceptance evidence. Superseded plans and completed-task journals remain in Git.

## Current repository audit

- [ ] Finish the [September 15 audit](reports/repository-audit-20260915.md):
      maintained code/document coverage, paid combination tests, browser paths,
      failure/load checks, scoped cleanup, then resume v11 update. Reading coverage
      does not imply every runtime combination has passed.
- [x] Resolve measured eight-Run admission latency: prepared SELECTs and the
      ready predicate remove excess planning; CPU-only 1.5→4→1.5→4 trials identify
      database throttling. Both 4-CPU cohorts keep internal time below provider
      time for all requests; larger capacity remains a separate validation.
- [x] Align the opt-in Cube gate with proxy egress, elastic TTL and native Volume
      lifecycle. Real KVM, cancellation UNKNOWN and controlled deletion failure
      pass; cleanup errors fail the gate rather than becoming accepted evidence.
- [ ] Complete fresh Compaction/provider/Worker/Subagent combinations and
      process failures on the final revision, including owner-routed SSE.
- [ ] Keep the [unexplained historical SSE opening](reports/stream-reopen-investigation-20260909.md)
      distinct from intentional stale-snapshot replacement. The focused browser
      check now fails unexpected connection counts instead of only logging them.

## Reliability and capacity

- [ ] Prove a Cube-native scoped launch-generation contract before claiming
      physical execution fencing. [Research](reports/cube-execution-generation-study.md)
      is complete; ordinary shell effects remain potentially UNKNOWN.
- [ ] Validate PostgreSQL/PgBouncer failover, Cube compute-node drain and shared
      Volume attachment on actual independent machines.
- [ ] Measure producer latency across Session counts, canonical projection
      throughput/WAL and live-tail memory with 2,000/10,000 SSE connections.
- [ ] Validate KEDA and Kafka partition sizing against the intended enterprise
      workload, not only a single-host synthetic producer benchmark.
- [ ] Measure the shared Session writer/Projector at the maximum child count
      before increasing tree or model concurrency defaults.

## Deployment operations

- [ ] Run the one-host installer on a genuinely clean machine; current k3d
      cutover tests do not establish that broader claim.
- [ ] Reconcile Cube Volume node references after host/guest loss and resolve
      template cleanup via stable node identity rather than obsolete Pod IPs.
- [ ] Decide a local Cube MySQL binlog retention policy. Earlier disk cleanup
      did not change its 30-day default. [Evidence](reports/environment-reset-20260910.md).
- [ ] Add deployment-specific Kafka TLS/SASL/ACL examples and wire real on-call
      notification destinations into Alertmanager.
- [ ] Validate deployment-owned coordinated PG/Kafka/Cube backup and restoration.
      The unsupported whole-system archive CLI is removed, not replaced by a
      claimed disaster-recovery product.
- [ ] Repeat GitLab project credentials, private clone, multi-user non-exclusive
      claims and elastic/machine Issue execution against an external TLS instance.
- [ ] Design GitHub user authorization before restoring App onboarding; current
      support is limited to already-bound integrations and environment Git credentials.

## Deliberately deferred capabilities

- [ ] Benchmark Standard/Fast on enabled GPT models before changing the default.
- [ ] Replace PiCloud's hosted-item adapter when pinned Pi has a backend-conformant
      native contract. DeepSeek Flash stays hidden; do not silently switch its
      protocol or add a substitute search tool.
- [ ] Add user-image input and generated-image results only with native storage,
      Compaction and cross-Worker/provider recovery contracts.

These are not authorizations for a new architecture or feature. Changes to
ownership, persistence, execution or recovery semantics require owner discussion.
