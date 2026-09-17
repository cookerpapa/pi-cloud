# Lease/commit tail investigation — September 17, 2026

Diagnosis, not a latency fix. Application baseline `31cdad6e`; Worker `289a13d8`
adds successful lease subphase metrics only. PG/Kafka, pool limits, transaction
boundaries, locks, `fsync=on` and `synchronous_commit=on` remain unchanged.
PostgreSQL is **17.6**, on this single WSL host's Docker Volume.

## Method

Two cohorts of 20 real GPT-5.6 Sol/medium/Standard requests: twelve sequential
Turns with two 12-second idle gaps, then two four-Session concurrent waves.
The second cohort used the new phase metrics. Metrics came from isolated
successful-claim windows; model time is separate. No Cube was activated.

A separate read-only connection sampled `pg_stat_activity` roughly every
12–13ms, retaining operation class/hash, wait state and blocking PIDs, never
SQL parameters or messages. Its mean query round trip was about 2.2ms; sampling
has overhead and cannot resolve every short operation. Host cgroup CPU and I/O
pressure counters were sampled separately. No global PG timing/logging setting
was changed, and no database/service restart was required for the sampler.

## What was observed

**Intermittent WAL synchronization can delay another transaction.** In cohort 1,
a Control Plane COMMIT was still active 73.5ms after query start. Six observations
across 62.4ms reported `IO/WalSync`. A Worker update of `run_attempts` identified
that backend as its blocker; the update remained active for at least 90.8ms,
including a later `WalWrite` observation. This occurred after sampling/model work,
not in that request's startup interval. It proves a commit/lock propagation path,
not the cause of the earlier uninstrumented 176ms lease acquisition.

**Some apparent lock-call latency is on the Worker side.** Two second-cohort
lease acquisitions took 46.4/46.8ms. Their Session/family-lock call intervals were
30.3/34.5ms. During those intervals PG had already returned the SELECT and was
`idle in transaction / ClientRead`, awaiting the next client command, with no
reported database lock wait. In the same request windows the Worker's event-loop
maximum-delay metric was 32.9/43.5ms. This points to client/event-loop scheduling,
not a 30ms PG row-lock wait. It does **not** identify a particular synchronous
function, GC or JIT pause; that needs a targeted CPU/GC profile.

Second-cohort serial acquisitions, milliseconds (12 samples, including startup):

| Phase | Median | Range |
| --- | ---: | ---: |
| Entire acquisition | 15.2 | 12.7–46.8 |
| Pool acquisition + BEGIN | 0.62 | 0.41–2.15 |
| Attempt/owner reads | 2.79 | 2.01–5.17 |
| Worker capacity-row lock call | 0.71 | 0.44–2.50 |
| Lease/state writes | 4.91 | 3.87–11.78 |
| Commit/client handoff | 3.20 | 2.70–6.34 |

These are nested stage observations, not extra SQL calls. In particular, the
shared Worker capacity-row lock hypothesis did not produce a long wait in these
serial samples. PG showed no CPU-quota throttling in the measured startup
windows. One concurrent window had about 3ms of Worker cgroup throttling, not
enough to explain the historical hundred-millisecond outliers by itself.

## Independent commit check

Two sequential probes performed 1,000 and 5,000 transactions, each updating only
the timestamp of an archived, owned test Project, with 10ms pauses. No application
lock or active Session shared that row. Median COMMIT was about 2.9ms, p99 about
5.5–5.7ms, maximum 10.2ms. Thus the storage path is not continuously slow. This
small-row test neither reproduces the complete application write workload nor
excludes intermittent host/filesystem/WAL contention. It does not prove which
physical storage layer caused the observed `WalSync` delay.

Wait-event interpretations follow the [PostgreSQL 17 monitoring contract](https://www.postgresql.org/docs/17/monitoring-stats.html).
Do not disable durability or remove ownership locks on this evidence. Continue
with Worker CPU/GC profiling and capture the exact original-scale lease/commit
outliers using the retained [phase metrics](../OBSERVABILITY.md). The original
176ms acquisition and 237ms claim-finish samples remain individually unattributed.

## Verification and cleanup

The instrumentation adds no SQL, credential/tenant labels or persistent state.
Four focused family-lease/Worker-runtime tests passed, including exclusion of
failed grants from successful observations; runtime-core and Worker type checks,
documentation and observability checks passed. No claim of a new full-suite run.

Forty paid assistant responses reported 37,658 input, 224,128 cache-read and 266
output tokens. An initial helper omitted a required SSE status callback; that
setup Run was cancelled, later sealed as `assignment_lost`, and excluded from
latency/response results. No product recovery workaround was added.

All three fixture tenants, nineteen conversation views, three Workspaces and
forty-one Run records were removed after API cleanup, storage-purge confirmation
and verification that PG/Kafka delivery passed their seals. The original live
Session/accounts remain. Observer connections, private traces and probe scripts
were removed; shared Kafka and formal service logs keep ordinary retention.
