# Reversible NVMe power trial — September 18, 2026

Runtime `b57e6ffd`; same PostgreSQL, Worker, Kafka and model configuration as
the [WAL-wait investigation](startup-wal-tail-20260918.md). Host-level trial was
explicitly approved. **Setting the two transition tolerances to zero did not
eliminate storage tails. Original settings have been verified restored.**

## Scope and restoration

AC power was confirmed before every phase. Only the active scheme's primary
and secondary NVMe transition latency tolerances changed: **15/100ms → 0/0ms →
15/100ms**. DC values stayed 50/100ms. The active power scheme, NVMe idle
timeouts, PCIe ASPM, CPU/GPU settings and all PG durability settings stayed intact.

Original values were recorded before writes. A separate, bounded Windows
restoration process protected against WSL exit; the main process also restored
in `finally`. After restoration the entire disk-power settings dump matched
the original exactly. The restoration process was stopped and its absence
independently checked. No permanent host setting or application code was changed.

## A/B/A measurements

Each phase ran 180 prepared `pgbench` transactions at 3/s, one client/thread,
updating sixteen 1KiB rows in an isolated database. Scheduling lag is subtracted
below. Workload parameters were identical; random arrival sequences were not
fixed. Background services remained up, so shared-storage interference was not
eliminated. Percentiles use nearest rank; medians average the two middle values.

| AC tolerance | Median | p95 | p99 | Maximum | >100ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original 15/100ms | 3.739ms | 15.519ms | 101.017ms | 184.801ms | 2/180 |
| Temporary 0/0ms | 3.412ms | 10.231ms | 142.678ms | 155.409ms | 2/180 |
| Restored 15/100ms | 3.624ms | 50.320ms | 249.615ms | 407.540ms | 4/180 |

Each phase then ran 18 real GPT-5.6 Sol Turns, medium reasoning and Standard
service, through the frontend API/SSE client. All completed successfully.
API submission → model upstream dispatch, excluding the first Turn:

| Phase | Median | Maximum |
| --- | ---: | ---: |
| Original | 113.487ms | 215.375ms |
| Temporary | 100.460ms | 160.329ms |
| Restored | 110.315ms | 266.285ms |

These exclude provider generation time and are not browser-paint timings.
The temporary setting had a lower startup median in this small sample, but
the storage-tail objective failed. This does not prove that all storage power
management is irrelevant, nor establish a stable throughput improvement.

## Conclusion and cleanup

Do not adopt zero tolerances as a demonstrated fix or bake them into PiCloud
deployment defaults. The confirmed boundary remains PG waiting for durable WAL
I/O. Next investigation should distinguish WSL/VHD/filesystem behavior from
host storage/driver behavior with matched same-drive probes or storage traces.
No firmware failure, driver defect or specific VHD problem has been established.

540 database transactions and 54 real model Turns completed. Native usage:
**26,770 input, 334,976 cache-read and 432 output tokens**. Three test tenants,
conversations and Workspaces were API-deleted and then purged only after seals
and projection progress were verified. No Cube or development machine was needed.
The isolated database, scripts/logs and private state files were removed; original
user/model data and the original live Session were retained. Shared WAL, Kafka
and formal service logs continue their normal retention policy.
