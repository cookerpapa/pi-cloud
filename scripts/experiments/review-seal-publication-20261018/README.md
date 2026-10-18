# Session seal publication review archive

The original characterizations and runner remain in review commit `f5bb08ed`.
The [review results](../../../docs/reports/seal-publication-review-20261019.md)
describe that baseline, not the repaired behavior. ADR-0260 replaces defect
assertions with maintained PG/HTTP and controlled-callback regressions:

- [Publication](../../../packages/control-plane/test/seal-publication.postgres.test.ts)
- [Reader lifetime](../../../packages/event-log/test/reader-publication-lifetime.test.ts)

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run packages/control-plane/test/seal-publication.postgres.test.ts packages/event-log/test/reader-publication-lifetime.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
npm run test:transport
```

Tests use disposable PG, loopback HTTP and substituted native callbacks. The
maintained transport gate covers real RF3/PG. No native crash experiment is needed.
