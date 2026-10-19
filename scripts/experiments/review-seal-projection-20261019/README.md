# Kafka seal → PG projection characterizations

Reviewed baseline: `1d84ea59b49a517d41705fb5e4b15192c7d44382`.
These tests characterize the current runtime, including confirmed defects. They
are review evidence, not claims that the defects are repaired. No production
service, Kafka producer, VM, model or external endpoint is touched.

Run from the repository root with pinned dependencies and Docker available:

```sh
env -u PI_CLOUD_POSTGRES_INTEGRATION_URL -u PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL node scripts/run-with-test-postgres.mjs -- npx vitest run scripts/experiments/review-seal-projection-20261019/projection.test.ts --maxWorkers=1
node --import tsx scripts/experiments/review-seal-projection-20261019/checkpoint-cost.mjs /tmp/pi-cloud-seal-checkpoint-cost.json
```

The first command uses the maintained disposable official-PG helper. The cost
probe always starts its own disposable PG container, ignoring caller integration
URLs. Containers and fixture databases are removed after completion.

- Rollback after the real checkpoint/closure SQL leaves old authority and the
  replay reference intact. The unchanged seal then succeeds on retry.
- Actual PG COMMIT followed by a substituted lost return preserves the checkpoint
  and old-writer release. Duplicate seals still retain the old 1 MiB live cache;
  ordinary read-only replay exposes that same cached instance. Reset clears it.
- A controlled pause immediately before COMMIT lets another real Worker claim
  query observe the boundary: it cannot claim before COMMIT, can claim afterward,
  and an old duplicate seal cannot clear the new epoch-2 grant.
- SQL compilation tracing counts the actual recovery projection statements,
  including the repeated Run read but excluding driver BEGIN/COMMIT and triggers.
- Pool checkout is held with a controlled promise. The SQL-local 60 ms budget
  cannot start while a connection is unavailable; work is still pending at
  250 ms and completes after the fixture releases the connection. Source defines
  production's separate 2-second lock/10-second statement budgets and lack of
  an outer checkout bound. This is not a production-duration measurement.
- The query-cost probe bulk loads consistent no-op commit headers, then uses
  the real native projection for one new live document and one pending change.
  `EXPLAIN ANALYZE` captures the actual checkpoint-proof query. Historical no-op
  headers isolate query growth; they are not a representative Agent workload.
  The reported matched header rows exclude other tenants' filtered rows. Timing
  is local/warm evidence, not a fleet-capacity or timeout claim.

See the [review](../../../docs/reports/seal-projection-review-20261019.md) and
[measurements](../../../docs/reports/seal-projection-review-20261019.json).
