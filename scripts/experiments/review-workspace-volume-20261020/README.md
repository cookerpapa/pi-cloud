# Workspace/Volume review characterizations

Baseline: PiCloud `f9ca385e`, deployed `model-runtime-058925bb`, schema 192.
These are review probes, not fixes. Passing assertions reproduce the documented
baseline defects and controls; replace them with desired-behavior regressions when
the repairs land. No model calls, live VMs or production credentials are needed.

From the repository root with installed dependencies and Docker:

```sh
npx tsc -p scripts/experiments/review-workspace-volume-20261020/tsconfig.json
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run scripts/experiments/review-workspace-volume-20261020/lifecycle.test.ts --maxWorkers=1 --testTimeout=60000
node scripts/experiments/review-workspace-volume-20261020/native-check.mjs
npm run cubesandbox:allocation-check
```

The PG wrapper owns a disposable loopback database container; set an integration
URL only for an already isolated test database. Tests use real current migrations,
public native-record projections and production lifecycle methods. Physical
provider effects are counters, never actual sandbox destruction. One terminal
case uses a fixture-only shortened warm TTL and controlled clock.

The native driver requires the upstream Cube checkout at `~/CubeSandbox`, or
`PI_CLOUD_CUBESANDBOX_REPOSITORY`. It archives the exact commit in
`deploy/cubesandbox/runtime-build.json`, verifies/applies every patch in a fresh
temporary directory, adds `reference_review_test.go` and runs the pinned Go image.
Only temporary source/plugin fixtures are mounted; no host home, Docker socket,
production Volume or reference DB is exposed to the test container. It removes
the temporary checkout after completion.

See [findings and evidence limits](../../../docs/reports/workspace-volume-lifecycle-review-20261020.md).
