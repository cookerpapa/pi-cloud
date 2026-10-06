# 2026-10-06 review reproductions

The original review characterizes `aace21a8` and pinned Pi Durable 1.0.0.
These commands now measure the repaired adapters; baseline output is archived
in the report and review commit `48cd4366`. See the [whole-repository report](../../../docs/reports/repository-review-20261006.md).
These are review fixtures, not a second runtime or proposed storage protocol.

From the repository root after `npm ci`:

```sh
node --import tsx scripts/experiments/review-durable-20261006/runtime-probes.mjs
node --import tsx scripts/experiments/review-durable-20261006/storage-probes.mjs
node scripts/experiments/review-durable-20261006/guest-bundle-probe.mjs
npm run test:transport
```

The storage fixture uses disposable PostgreSQL; the transport fixture adds
three disposable RF3 Kafka brokers. Docker is required for these fixtures.
Runtime probes use the actual native Harness with a controlled model port.
The original PG-lock-loss reproducer is archived at review commit `48cd4366`;
the obsolete PG lock implementation is removed under ADR-0231. Current filesystem
lock failure tests live in `packages/sandbox-control/test/filesystem-workspace-volume-gateway-lock.test.ts`.
Bundle probes use esbuild `write:false` and report the actual current dependency
closure. The original private-helper comparison is archived at `48cd4366`. No probe here reads production
credentials, calls a paid model, or modifies a deployed service.

Runtime/storage output supplies characterization measurements, not a replacement
for automated regression assertions. The transport command runs the maintained
integration assertions, including the migrated native Subagent fixture. Timing
values are illustrative, not fleet SLOs.
