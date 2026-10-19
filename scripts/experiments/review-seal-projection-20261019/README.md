# Kafka seal → PG projection review archive and query measurement

The original characterizations remain in review commit `450a1efd` and the
[review](../../../docs/reports/seal-projection-review-20261019.md). ADR-0261 replaces
defect assertions with maintained [closure regressions](../../../packages/control-plane/test/session-seal-projection.test.ts),
native Storage contracts and startup pool cleanup. No production service, Kafka
producer, VM, model or external endpoint is touched by these checks.

Run from the repository root with pinned dependencies and Docker available:

```sh
env -u PI_CLOUD_POSTGRES_INTEGRATION_URL -u PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL node scripts/run-with-test-postgres.mjs -- npx vitest run packages/control-plane/test/session-seal-projection.test.ts packages/control-plane/test/main-acquisition.test.ts packages/pi-session-postgres/test/durable-storage-conformance.test.ts --maxWorkers=1
node --import tsx scripts/experiments/review-seal-projection-20261019/checkpoint-cost.mjs /tmp/pi-cloud-seal-checkpoint-cost.json
```

The first command uses the maintained disposable official-PG helper. The cost
probe always starts its own disposable PG container, ignoring caller integration
URLs. Containers and fixture databases are removed after completion.

- Rollback after the real checkpoint/closure SQL leaves old authority and the
  replay reference intact. The unchanged seal then succeeds on retry.
- Actual PG COMMIT followed by a substituted lost return preserves the checkpoint
  and old-writer release. Repeated closure also retires the old live view, while
  an old seal and delayed callback preserve a newer view's pending changes.
- A controlled pause immediately before COMMIT lets another real Worker claim
  query observe the boundary: it cannot claim before COMMIT, can claim afterward,
  and an old duplicate seal cannot clear the new epoch-2 grant.
- SQL compilation tracing counts the actual recovery projection statements,
  including the repeated Run read but excluding driver BEGIN/COMMIT and triggers.
- Pool checkout is held with a controlled promise. The bounded pool must release
  capacity without waiting for the old caller; actual locked cold-read/closure
  queries expire without releasing old authority. Startup checks enforce the
  production 30-second acquisition/checkout budget, alongside existing
  2-second lock/10-second statement budgets.
- The query-cost probe bulk loads consistent no-op commit headers, then uses
  the real native projection for one new live document and one pending change.
  `EXPLAIN ANALYZE` captures the actual checkpoint-proof query. Historical no-op
  headers isolate query growth; they are not a representative Agent workload.
  The repaired query must examine one matching header at every tested historical
  size. Timing is local/warm evidence, not a fleet-capacity or timeout claim.

Original [measurements](../../../docs/reports/seal-projection-review-20261019.json)
remain unchanged; current measurements are recorded separately in delivery evidence.
