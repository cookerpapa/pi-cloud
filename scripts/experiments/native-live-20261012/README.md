# Native live-state storage measurement

This compares the schema-185 adapter with ADR-0244 using identical native JSON
delta writes in disposable PostgreSQL containers. It does not contact a provider,
run a Tool or alter production. The source-only baseline intentionally excludes
old tests: copying them below the repository lets root Vitest filters discover
duplicate test paths.

From the repository root:

```sh
mkdir -p .cache/adr0244-baseline
git archive 72cbe218 packages/pi-session-postgres/src packages/pi-session-postgres/package.json | tar -x -C .cache/adr0244-baseline
node --expose-gc --import tsx scripts/experiments/native-live-20261012/measure.mjs baseline /tmp/native-live-baseline.json
node --expose-gc --import tsx scripts/experiments/native-live-20261012/measure.mjs current /tmp/native-live-current.json
```

Run the variants sequentially. Both use the current empty-database migrations;
the baseline adapter still journals live changes. The probe covers 1,001 updates,
retained body/checkpoint sizes, counted SQL (excluding driver BEGIN/COMMIT),
cluster WAL, sampled heap, duplicate replay, a simulated handoff checkpoint and
normal completion. The JSON reports contain synthetic data sizes and checks;
the final response itself is not written to the report.

Timing and sampled heap are single-process observations affected by host load
and garbage collection. They are not production latency, steady-state memory or
end-to-end recovery measurements. See the
[implementation report](../../../docs/reports/native-live-state-20261012.md)
for measured results and the actual live acceptance status.
