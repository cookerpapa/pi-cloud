# Session seal publication review characterizations

Baseline: `596f9b9245e392c56a1038b9b94e6180cc47bedc`.
Started October 18; [review completed October 19](../../../docs/reports/seal-publication-review-20261019.md).
These tests assert current behavior, including review findings; they do not
implement repairs. Replace defect assertions with maintained regressions when
the corresponding repair is approved.

The PG tests use the existing disposable official PostgreSQL helper and migrated
private fixtures. The HTTP test uses loopback servers. Reader tests substitute
all native callbacks; no native crash or broker fault is exercised.

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run scripts/experiments/review-seal-publication-20261018/probes.postgres.test.ts scripts/experiments/review-seal-publication-20261018/reader-lifetime.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
node node_modules/typescript/bin/tsc -p scripts/experiments/review-seal-publication-20261018/tsconfig.json
```

The lock test measures at least 1,250 ms of pending close. Its blocker has a
ten-second test watchdog and is released in `finally`. The SQL test marks the
fixture's earlier control references published before tracing the one seal;
it substitutes Kafka, not PG. Its six-statement count excludes binding propagation,
initial seal admission, fixture setup and background polling/cleanup.

The safe reader tests verify callback/retirement order only. They do not establish
real Kafka commit success, lost history or a native runtime failure.

To run the existing same-Session publication contract with independent RF3 Kafka
and PG containers, using the repository's pinned fixture helpers:

```sh
node scripts/experiments/review-seal-publication-20261018/run-integration.mjs
```

That runner ignores supplied integration endpoints when allocating its fixtures,
uses loopback ports, and cleans its own containers/network. It runs one existing
integration case, not the whole transport suite. No model or Cube is involved.
