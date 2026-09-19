# Maintained backlog

Only unfinished work for the PostgreSQL + Kafka + Pi SDK + Cube Volume
architecture belongs here. Implemented contracts live in the
[architecture](ARCHITECTURE.md), [current ADRs](adr/README.md) and versioned
acceptance evidence. Superseded plans and completed-task journals remain in Git.

The [September 15–17 audit](reports/repository-audit-20260915.md) is complete:
maintained-file review, paid combination tests, process faults, browser paths,
latency analysis, isolated load gates and scoped cleanup. Its bounded measurements
do not establish enterprise-scale capacity or physical multi-node HA.

## Reliability and capacity

- [ ] Implement ADR-0178: atomic admitted/running state, first-record recovery,
      no standalone opening, updated crash tests, drained rollout and live timing.

- [ ] Discuss drain/completion durability before any further boundary merging.
      [Terminal wake and transaction-local SQL](reports/terminal-wake-acceptance-20260918.md)
      are implemented; shared-row/WAL tails remain. Do not remove the drained
      output proof or weaken seals merely to reduce commit count.

- [ ] Attribute remaining cold-start and Node callback/CPU tails after
      [two-way admission](reports/parallel-claims-20260918.md). Four-concurrent
      startup median improved 213→194ms in the bounded comparison, but cold
      requests can still exceed 400ms. Some query spans include client-side
      delay after PG is already idle; do not label all elapsed time as WAL I/O.

- [ ] Isolate the remaining host-storage tail below the confirmed PG `WalSync`
      wait. The [approved NVMe A/B/A trial](reports/nvme-power-trial-20260918.md)
      did not eliminate >100ms tails, and original host settings were restored.
      [Native-host comparison](reports/native-storage-tail-20260918.md) also
      reproduces the tail on the SSD hosting WSL, while a second SSD did not in
      these samples. Distinguish competing I/O, device/driver and power behavior;
      no specific fault is established. The [Lenovo standard-mode A/B/A trial](reports/legion-performance-trial-20260918.md)
      reduced typical real-GPT startup from 119ms to 63ms, returning to 117ms
      after restoration, but >100ms storage tails survived. Original mode/plan
      are restored; no laptop-specific deployment default is justified. Durability stays on.
- [ ] Keep the [unexplained historical SSE opening](reports/stream-reopen-investigation-20260909.md)
      distinct from intentional stale-snapshot replacement. The final 200 browser
      checks have no unexpected openings; that does not identify the old root cause.
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
