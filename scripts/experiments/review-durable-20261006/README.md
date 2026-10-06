# 2026-10-06 review reproductions

Characterization of `aace21a8`, pinned Pi Durable 1.0.0 and the current cloud
adapters. See the [whole-repository report](../../../docs/reports/repository-review-20261006.md).
These are review fixtures, not a second runtime or proposed storage protocol.

From the repository root after `npm ci`:

```sh
node --import tsx scripts/experiments/review-durable-20261006/runtime-probes.mjs
node --import tsx scripts/experiments/review-durable-20261006/storage-probes.mjs
node --import tsx scripts/experiments/review-durable-20261006/volume-lock-probe.mjs
node scripts/experiments/review-durable-20261006/guest-bundle-probe.mjs
node scripts/experiments/review-durable-20261006/transport-check.mjs
```

The storage/lock fixtures use disposable PostgreSQL; the transport fixture adds
three disposable RF3 Kafka brokers. Docker is required for these fixtures.
Runtime probes use the actual native Harness with a controlled model port.
The lock test terminates only its own test PG backend and changes a temporary file.
Bundle probes use esbuild `write:false`; the private-helper comparison is diagnostic
only and is not a supported production import. No probe here reads production
credentials, calls a paid model, or modifies a deployed service.

Runtime/storage/lock output describes **current defects and measurements**;
successful script completion does not claim those defects are fixed. The
transport command runs the existing integration assertions, with an explicit
exit status and isolated cleanup; one stale Subagent fixture fails at this
revision (Q06-01). Timing values are illustrative, not fleet SLOs.
