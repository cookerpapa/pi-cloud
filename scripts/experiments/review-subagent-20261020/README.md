# Subagent review characterizations

Baseline production code: `6a9f5c9a` / `model-runtime-058925bb`, schema 192.
Passing assertions reproduce baseline findings; these are not fixed-behavior
regressions. They make no live model calls, VM changes or production mutations.

```sh
npx tsc -p scripts/experiments/review-subagent-20261020/tsconfig.json
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run scripts/experiments/review-subagent-20261020/subagent.test.ts --maxWorkers=1 --testTimeout=15000 --hookTimeout=60000
node --expose-gc --import tsx scripts/experiments/review-subagent-20261020/workflow-retention.mjs
```

The PG wrapper owns an isolated temporary database. Public native task records
stand in for Harness execution; Controller and Dispatcher code is unchanged.
The self-wake experiment deliberately stops forwarding wakes after 20 executions
and does not advance the dispatch interval. Only the first contact creates a
supervisor row. The retention probe substitutes workflow preparation/control
transport, disposes every Tool and observes reachability of results using WeakRefs;
dropping the tool bindings supplies the collection control. It is not an OOM test.

See [findings and evidence boundaries](../../../docs/reports/subagent-lifecycle-review-20261020.md).
