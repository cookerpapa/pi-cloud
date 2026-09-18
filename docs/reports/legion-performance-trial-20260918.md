# Lenovo standard-mode trial — September 18, 2026

Runtime `b57e6ffd`, repository `09c6ae81`; same one-host topology as the
[native storage probes](native-storage-tail-20260918.md). **Standard Performance
mode reduced typical PiCloud startup latency in this A/B/A sample, but did not
eliminate synchronous-storage tails. Original mode and plan are restored.**

## Reversible host change

After the operator explicitly approved retrying UAC, elevation succeeded. The
Lenovo WMI interface reported hardware mode **1 (Quiet)** even though Windows
had the OEM Balanced plan active. These are separate observations; reading the
Windows plan alone had not established the actual hardware mode.

The trial used only existing standard settings:

| Phase | Lenovo hardware mode | Windows plan |
| --- | --- | --- |
| Before | Quiet (1) | Existing OEM Balanced |
| Performance | Performance (3) | Existing OEM Performance |
| Restored | Quiet (1) | Original OEM Balanced |

Mode and plan were checked before and after each phase. AC remained connected.
Quiet passed briefly through standard Balanced before Performance. The WMI
mapping follows the pinned [LenovoLegionToolkit implementation](https://github.com/BartoszCichecki/LenovoLegionToolkit/blob/63c173024495bae37283e247f11953a09f79ba11/LenovoLegionToolkit.Lib/Features/PowerModeFeature.cs);
that archived project was read, not installed. Lenovo documents the standard
[Fn+Q operating modes and AC requirement](https://download.lenovo.com/pccbbs/pubs/legion_5_15_7/html_en/EN/performance_mode.html).

A Windows-side 20-minute restoration process protected against WSL loss;
the main elevated process also restored in `finally`. Restoration readback
succeeded, then both processes were independently confirmed absent. No custom
fan curve, overclock, BIOS setting or persistent startup configuration was edited.
The trial switched hardware mode and plan together; it does not isolate their
individual contributions. PG `fsync=on`, `synchronous_commit=on`, and
`wal_sync_method=fdatasync` were unchanged and checked again afterward.

## Real GPT startup

Each phase created an owned test tenant, Workspace and Session, then completed
18 successive GPT-5.6 Sol Turns at medium reasoning, Standard service. All
54 Turns succeeded through the frontend API/SSE client. No Cube was activated.
The comparison below excludes each phase's first Turn, retaining 17 observations.
These are client-receipt measurements, not browser-paint timings.

| Metric | Quiet before | Performance | Quiet restored |
| --- | ---: | ---: | ---: |
| API submission → model upstream dispatch, median | 119.398ms | 63.294ms | 116.636ms |
| Same startup interval, maximum | 180.389ms | 228.254ms | 177.449ms |
| API acceptance response, median | 19.711ms | 12.668ms | 16.958ms |
| Pi first-text event → SSE client receipt, median | 9.345ms | 7.346ms | 9.711ms |
| Total first-text delay excluding provider route, median | 129.971ms | 72.198ms | 126.393ms |
| Provider route → first parsed text, median | 2053.659ms | 2186.889ms | 2233.092ms |

Startup medians fell approximately **47%** relative to the first Quiet cohort
and returned close to baseline after restoration. Remote model latency did not
cause that improvement; it is measured separately. The provider route includes
CLIProxyAPI, and component medians must not be added to reconstruct a percentile.

The excluded first-Turn startups were 565.870/97.289/178.617ms respectively.
Processes were not restarted between phases, so first-Turn initialization,
connection/JIT warmth and background activity are not controlled cold-start
benchmarks. Seventeen retained observations per phase also do not establish
production tail percentiles or long-term capacity.

One Performance Turn still needed 228.254ms to dispatch its model request.
Its API acceptance took 131.896ms. Within that interval, a Control Plane COMMIT
acknowledgement at 03:48:35.992 UTC took 122.889ms, with event-loop idle time
121.727ms and active time 1.166ms. Thus the long wait was not explained by that
Node process spending 123ms doing computation. This trial did not sample PG wait
events for that exact transaction; the earlier [WAL study](startup-wal-tail-20260918.md)
provides independently correlated `WalSync` evidence.

## Independent PostgreSQL and filesystem probes

An isolated database ran 180 prepared transactions at a target 3/s per phase,
one client/thread, updating sixteen 1KiB rows. All three phases used the same
`pgbench` seed 37261. Times below subtract schedule lag. All 540 transactions
succeeded. Percentiles use nearest rank; medians average the middle pair.

| Phase | Median | p95 | p99 | Maximum | >100ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Quiet before | 3.566ms | 13.066ms | 99.208ms | 112.765ms | 1/180 |
| Performance | 3.092ms | 9.041ms | 93.989ms | 100.766ms | 1/180 |
| Quiet restored | 3.782ms | 14.940ms | 174.315ms | 183.021ms | 2/180 |

The Performance and restored phases also repeated the previous deterministic
8KiB write/flush probes on the SSD hosting WSL. Same method, 180 operations per
row, with all background services still running:

| Phase / path | Median | p95 | p99 | Maximum | >100ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Performance / native Windows | 2.450ms | 7.683ms | 182.259ms | 205.346ms | 4 |
| Performance / WSL | 4.888ms | 13.077ms | 141.385ms | 149.774ms | 4 |
| Quiet restored / native Windows | 2.524ms | 45.462ms | 139.062ms | 264.270ms | 5 |
| Quiet restored / WSL | 6.433ms | 77.688ms | 186.795ms | 251.263ms | 9 |

The tail survives even outside PG/WSL in Performance mode. Power settings may
affect its distribution, but mode switching is not a demonstrated root fix.
Remaining candidates include competing G: I/O, storage driver/device behavior
and power transitions not isolated by this experiment. No drive defect is proven.

## Cleanup and conclusion

The three test Sessions and Workspaces were API-deleted. Exact tenant-scoped
rows were purged only after all 54 output seals and projection positions were
confirmed, all execution bindings released, and Workspace storage purge completed.
Original account/resource counts and the original live Session were unchanged.
The isolated database, files used by the 720 raw write/flush operations, temporary scripts,
measurement files and test logs were removed. Shared PG/Kafka/service logs retain
their normal lifecycle. Services remain healthy; no benchmark process remains.

Native model usage was **29,842 input, 331,904 cache-read and 432 output tokens**.
No application code or architecture was changed. Documentation formatting/link
checks passed; this host experiment does not claim a new full application-suite
run. Keep the measured standard-mode benefit separate from the unresolved storage
tail, and do not bake laptop-specific power settings into PiCloud deployment.
