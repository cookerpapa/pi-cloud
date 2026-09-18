# Startup tail attribution — September 18, 2026

Follow-up: [the approved NVMe power trial completed without eliminating tails](nvme-power-trial-20260918.md).

Baseline: `83a7c4cd` / deployed runtime `ff51e21d`. Local changes and final runtime:
`b57e6ffd`. PostgreSQL 17.6, one four-family Worker, unchanged PG/Kafka/Cube topology.

**New startup stalls are now directly correlated with PostgreSQL WAL sync waits.
This is stronger evidence than the earlier uncorrelated COMMIT histogram. The
storage/power-management cause below that wait is not yet proven or fixed.**

## Direct evidence

The new content-free slow-COMMIT diagnostic captured a real coding Run whose
API-to-model dispatch took **306.4ms**. Its Worker COMMIT took **183.4ms**, with
only **0.34ms event-loop active time** and 183.07ms idle time. That establishes
external waiting, not a busy Worker callback, for this call.

A following 72-Turn GPT conversation used a separate, read-only PG wait sampler
and host cgroup counters. The first roughly thirty Turns had server sampling;
GC/event-loop observation covered the whole cohort without wrapping SQL calls.
Two exact backend/time matches were captured:

| UTC completion | Client COMMIT | PG evidence | Context |
| --- | ---: | --- | --- |
| 02:02:28.554 | 156.9ms | 12 consecutive `WalSync` observations spanning 138ms | startup 363.3ms |
| 02:02:42.308 | 190.9ms | 16 consecutive `WalSync` observations spanning 179ms | after model dispatch |

In both windows, CP/Worker/PG CPU-throttling counters did not increase. Worker
GC records did not overlap them, and its event-loop gap observer recorded no
gap above 12ms in the cohort. PG remained responsive to the separate sampler.
`WalSync` identifies waiting for WAL to reach durable storage, rather than an
ownership check or a row-lock wait. [PG wait-event definitions](https://www.postgresql.org/docs/17/monitoring-stats.html).

The original historical 327.5ms sample was not traced retrospectively. These
new matches establish the same class of problem, not its exact historical cause.

## Storage-only reproduction

PG data/WAL are on the WSL ext4 virtual disk, backed by a consumer NVMe device.
No active PiCloud Run was present during these isolated probes.

The official `pg_test_fsync`, using its own temporary file on the same filesystem,
reported one 8KiB write + fdatasync at **2.865ms**, versus open_datasync 2.730ms.
For two writes: fdatasync **2.992ms**, open_datasync **5.576ms**. There is no
measured justification to replace the current method. The tool reports averages,
not tail bounds. [Official benchmark contract](https://www.postgresql.org/docs/17/pgtestfsync.html).

An isolated database used `pgbench`, one client/thread, prepared SQL, updating
sixteen 1KiB rows per transaction:

| Pattern | Transactions | Median | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Continuous | 5,000 | 3.027ms | 4.568ms | 6.091ms | 47.913ms |
| Paced at 3/s | 180 | 3.457ms | 18.667ms | 128.971ms | 175.609ms |

All transactions succeeded. Paced values subtract pgbench scheduling lag;
the three >100ms cases had only about 0.1ms lag. Mean statement COMMIT time
was 2.839ms continuous versus 7.155ms paced. This reproduces the intermittent
problem on a request path **bypassing Pi, Kafka, a browser and Agent scheduling**.
Other services remained running in the background; shared-storage contention
was not eliminated. This is not a PostgreSQL capacity limit: continuous
throughput here was deliberately one-client.

## Other measured costs and local changes

Two earlier instrumented 24-Turn cohorts also found:

- A 39.4ms query interval overlapping **35.7ms major GC**, while PG was already
  idle. This is a separate cause, not an explanation of the WAL waits above.
- Fresh claim planning around **14–28ms**, with below 1.2ms execution in an
  empty-queue EXPLAIN probe. Surviving clients showed five custom plans followed
  by reused generic plans. Named plans work, but new connections still plan;
  an existing client's replanning cause was not independently established.
- Some 16–27ms update waits were `transactionid` locks outside first dispatch.
  Do not count these as startup WAL evidence.

Removed the redundant pre-writer owner/conflict reads: writer selection already
checks lease/peer ownership and lifetime under the same physical-Session lock.
No lease, cancellation, capacity or seal condition was removed. The SQL-count
regression requires one owner lookup in that claim path.

`database.slow_commit` now records only acknowledged calls >=100ms: timestamp,
backend PID, elapsed client time and event-loop active/idle time. It performs no
additional SQL and logs no query/arguments/credentials. A diagnostic sink failure
cannot change the committed outcome. This made the real 183ms wait observable
without an Inspector query hook.

Uninstrumented 24-Turn GPT comparisons (first Turn excluded) were **100.4 →
109.3ms median**, **184.4 → 176.8ms maximum** API-to-model dispatch. This does
**not** establish an end-to-end speedup from removing two reads. The 72-Turn
observed follow-up cohort had median 108.5ms and maximum 363.3ms. Provider time
is excluded; these are API/SSE measurements, not browser paint.

## Verification and cleanup

36 targeted tests passed against real PG, covering queue/owner elections,
atomic admission/rollback, expiry/cancellation/seals, parent/child native recovery,
connection loss and slow-COMMIT logging. The extended log-sink-failure regression
also passed. Database/runtime-core/control-plane typechecks, image builds,
formatting and documentation checks passed. This was a targeted continuation,
not another claim that the entire repository audit was repeated.

173 real Runs produced 180 native assistant responses: **106,791 input,
1,163,904 cache-read, 2,654 output tokens**. Includes two write/bash coding Turns
verified through PASS files, a workflow parent plus two delegated Lanes, and
the diagnostic/uninstrumented/endurance chat cohorts. The workflow parent ended
normally; child result content was not independently asserted in this continuation.

Six test tenants/credentials, eight conversation views, six Workspaces and the
coding Cube were removed after API deletion, Volume purge, projected seals and
scoped PG cleanup. The isolated benchmark database, probe files, test PG,
Inspector hooks and private traces were removed. Original account/model settings
and the original live Session remain. Shared service logs/WAL/Kafka retain their
normal retention; they were not truncated. No fsync, synchronous_commit, barrier,
WAL sync method or host power setting was changed.

## Follow-up experiment — subsequently approved and tested

Read-only inspection found the current Windows balanced storage policy uses
200/2000ms NVMe idle timeouts and 15/100ms primary/secondary transition tolerances
on AC power; PCIe ASPM is at maximum savings. The continuous/paced difference
makes idle power transitions worth testing, but does not prove causation.
Microsoft's performance-policy reference uses zero AC transition tolerances.
[StorNVMe power-management contract](https://learn.microsoft.com/en-us/windows-hardware/design/component-guidelines/power-management-for-storage-hardware-devices-nvme).

Proposed trial: record the current scheme and values, temporarily set only the
two AC NVMe transition tolerances to zero, repeat the paced/GPT comparison, then
restore the exact original values. Host-level approval was subsequently granted;
the linked A/B/A report records the outcome and
verified restoration. Do not bake workstation-specific power settings
into PiCloud defaults or disable write durability to hide the wait.
