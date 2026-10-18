# Session publication/completion baseline probes

These are review characterizations at `6b7bc02b`, not passing repair regressions.
They reproduce normal completion losing its presentation after an uncertain PG
COMMIT return, a proved no-send rejection interrupting the native Host, and
three reads of the same locked Run at completion.

From the repository root:

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run scripts/experiments/session-publication-completion-20261018/review.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```

The existing helper provisions a disposable official PostgreSQL container when
no integration endpoint is supplied. Do not point integration variables at a
production database. The uncertain return is injected after a real transaction
commit; it is not an actual network disruption. No model or Cube is invoked.
The probes stay outside maintained package tests and should be replaced by
desired-behavior regression tests when the findings are repaired.

See the [review](../../../docs/reports/session-publication-completion-review-20261018.md)
and its [measurements](../../../docs/reports/session-publication-completion-review-20261018.json).
