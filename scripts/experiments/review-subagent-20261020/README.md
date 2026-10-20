# Subagent review characterizations

Baseline production code: `6a9f5c9a` / `model-runtime-058925bb`, schema 192.
The original baseline probes remain in Git at `cf12b444`. They have been
converted into maintained supervision, idempotency and memory-lifetime
regressions. They make no live model calls, VM changes or production mutations.

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run packages/control-plane/test/subagent-supervision.postgres.test.ts --maxWorkers=1 --testTimeout=15000 --hookTimeout=60000
node node_modules/vitest/vitest.mjs run packages/supervisor-host/test/workflow-retention.test.ts --maxWorkers=1
```

The PG wrapper owns an isolated temporary database. Public native task records
stand in for Harness execution. The supervision regression verifies quiescence,
persisted change notifications and reawakening after a reply. The retention probe
substitutes workflow preparation/control transport, disposes every Tool and
observes result reachability with WeakRefs while the Run's bindings and closed
callbacks remain retained. It is not an OOM test.

See [findings and evidence boundaries](../../../docs/reports/subagent-lifecycle-review-20261020.md).
