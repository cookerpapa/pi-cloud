# Native-host storage comparison — September 18, 2026

Runtime `b57e6ffd`, repository `34f04f63`. This follows the
[PG WAL investigation](startup-wal-tail-20260918.md) and the unsuccessful
[NVMe tolerance trial](nvme-power-trial-20260918.md).

**The storage tail also reproduces outside WSL and PiCloud.** On the physical
SSD hosting the WSL VHD (G:), Windows-native synchronous writes occasionally took
over 100ms. A second physical SSD (C:) did not exhibit that tail in these samples.
This narrows the investigation; it does not establish a failing drive or prove
that Lenovo power management caused the delay.

## Method

Each probe created its own temporary 16MiB file, initialized and flushed it,
then performed 180 sequential-position 8KiB overwrites with synchronous flush.
A fixed xorshift seed of 37261 generated exponentially distributed idle gaps
with a mean target of 3 operations/second, capped at 5 seconds. This is an
idle-sensitive latency test, not a saturation-throughput test.

Windows used .NET `FileStream` with a one-byte buffer, `Write` and `Flush(true)`;
WSL used Node file writes and `FileHandle.sync()`. Times use monotonic clocks
and cover write plus flush, excluding the scheduled idle gap. Native Windows
and POSIX APIs are not identical to each other or to PostgreSQL `fdatasync`.
The probes establish an independent reproduction, not exact attribution of any
one previously observed PostgreSQL transaction.

Services remained running. No Run, tenant, Workspace, development machine or
model request was created by these probes. No durability setting was changed.

## Results

Each row contains 180 operations. Percentiles use nearest rank; medians average
the two middle values.

| Path | Median | p95 | p99 | Maximum | >100ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native Windows G: | 2.595ms | 45.454ms | 178.460ms | 221.522ms | 3 |
| WSL ext4 on G: | 6.448ms | 76.234ms | 177.999ms | 210.565ms | 9 |
| Native Windows C: | 3.738ms | 10.206ms | 10.471ms | 10.977ms | 0 |
| Native Windows G:, repeat | 2.516ms | 12.871ms | 135.223ms | 266.903ms | 3 |
| WSL ext4 on G:, repeat | 6.335ms | 16.436ms | 270.372ms | 349.966ms | 7 |

A separate Windows process then tested both disks in each of 180 pairs,
alternating which disk went first. This reduces order/time-window differences
between native-host samples:

| Paired native path | Median | p95 | p99 | Maximum | >100ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| C: | 3.992ms | 10.213ms | 10.307ms | 10.547ms | 0 |
| G: | 2.484ms | 11.912ms | 153.585ms | 208.530ms | 5 |

G: has a faster median but less consistent tails in these tests. The two disks
have different hardware and background workloads: G: also serves PiCloud,
Kafka, Cube and WSL. The comparison does not isolate device firmware, driver,
power-state transitions or competing I/O. Moving production storage or changing
the application architecture is not justified by this comparison alone.

## Power-mode boundary and cleanup

AC power and the existing OEM Balanced Windows plan were confirmed. A Windows
plan name does **not** establish the Lenovo Fn+Q hardware mode. Reading the
hardware mode through the Lenovo WMI interface required elevation. The approved
UAC launch returned “operation canceled by the user”; the elevated A/B/A trial
never started, its state file and isolated database were absent, and the active
Windows plan remained unchanged. No hardware-mode result is claimed.

All 1,260 write/flush operations completed; the actual probe files and their
newly created empty directories were removed by the probe cleanup. Private
measurement files and the unexecuted reversible mode-trial scripts remain in
ignored `.cache/` pending the operator's decision on retrying UAC. They are not
deployment defaults or supported application features. Original accounts,
conversations, model credentials and shared service logs were not modified.
