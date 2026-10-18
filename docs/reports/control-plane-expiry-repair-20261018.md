# Control Plane expiry repair and release

Date: 2026-10-18. Baseline: `b9338bc8`.
Decision: [ADR-0259](../adr/0259-control-plane-expiry-progress.md).
Serving release remains `session-lease-079dbddc` while verification is in progress.

## Source changes

- Independent Session expiry, management and remote retirement loops; short
  maintenance uses a three-connection direct-PG pool with five-second acquisition
  and checkout budgets, reusing ADR-0258's eviction adapter.
- SQL-bounded rotating Session candidates, no Worker-first window or waiting-seal
  starvation. NOWAIT rolls back a busy candidate before the next one. Lock order,
  fresh PG-time checks and exact ownership remain authoritative.
- Failed Workers with live management connections enter existing retirement under
  exact Boot identity. Fencing and idempotent admission commit together. Schema
  190 adds `worker_failed` reasons and partial indexes for active scan identities.
- Removed all-healthy-family idle cleanup; normal `work_finished` writes closure
  and release atomically, while ordered seal projection does the same for forced
  closure. Transaction-local facts replace duplicate Run/Session/lease reads.

## Verification in progress

The first targeted run passes 61 tests in ten files. Initial typechecks found
tests using the removed expiry API and an inferred array in the new fixture;
both were corrected. Subsequent strict Control Plane typecheck passes.

Actual client SQL counts for one expiry among 1, 8 and 64 Sessions are identical:
11 business statements / 13 including BEGIN and COMMIT, with one physical Session
lock read. An empty Session sweep has one query. Connection and failed-Worker
maintenance each add their own query; the independent idle retirement poll adds
one query plus BEGIN/COMMIT. These are round-trip counts, not fleet throughput.
The old combined scan cost 28/56 total for 1/8 Sessions. Whole idle maintenance
now has one additional business query to discover failed Workers.

A second targeted run passes 76 tests across three files, including commit-return
loss for both admission types, stalled maintenance query eviction, pagination,
concurrent admission and restart. Duplicate maintenance-loop fixtures were then
consolidated before the final full-suite run. Full source/fault/transport gates,
scanned matched release and live acceptance are pending. No production fault or deployment is
claimed by this intermediate source record.
