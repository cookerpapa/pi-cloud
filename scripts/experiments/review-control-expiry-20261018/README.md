# Control Plane expiry characterization archive

The review baseline and reproducer remain in commit `b9338bc8`.
ADR-0259 replaces those defect assertions with maintained regressions in
[control-plane-expiry.postgres.test.ts](../../../packages/control-plane/test/control-plane-expiry.postgres.test.ts).
The original [review evidence](../../../docs/reports/control-plane-expiry-review-20261018.json)
remains a baseline, not a claim about repaired behavior.

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run packages/control-plane/test/control-plane-expiry.postgres.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```
