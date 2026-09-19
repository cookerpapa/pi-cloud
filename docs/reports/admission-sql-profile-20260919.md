# Admission SQL profile — September 19, 2026

Historical baseline. Its identified duplication is addressed by
[ready-Run admission](ready-admission-20260919.md); current counts are 8 + 16.

Diagnosis only: production code, configuration and user data were unchanged.
Source `6a887ef2`, deployed runtime/image `4c7ff326` (later changes are tests/docs).

## What the production timings mean

The [last paid Luna cohort](first-record-admission-20260919.md) measured API
acceptance at 18.56 ms median and Worker admission at 37.64 ms median. Those are
not two individual INSERT timings, nor an exact additive decomposition of one
request: API response delivery can overlap Worker wake-up. The latter span includes
selection, ownership, lease/publication registration, running state and COMMIT.
For the same 12 production samples, admission's finish/commit median was 3.02 ms.
It is incorrect to label the entire roughly 60 ms as disk flush time.

## Method

Ran the current `ControlPlaneStore.acceptTurn`, `RunExecutor.dispatchNext` and
`AgentRunExecutionBackend.admit` against an owned, isolated PostgreSQL 17.6 with
the current migrations. Only model execution after admission was replaced by an
immediate result; synthetic seals allowed subsequent same-Session claims. No
provider, Kafka, Cube or production database mutation was used in this diagnostic.

The client used the production Worker image, 2 CPU/2 GiB; test PG had 4 CPU/768 MiB
on the same WSL host/Docker bridge. Both durability settings stayed on. The existing
database adapter and bounded prepared-statement behavior were unchanged.

Three 20-round cohorts used automatic / forced-generic / automatic plans, with
fresh client pools, five warm-ups and 1.5-second idle gaps. A fourth 20-round
automatic cohort added private-PG per-statement duration logging. Client query
timers, `pg_stat_statements` planning/execution counters and extended-protocol
parse/bind/execute duration logs were correlated. No bound values were logged.
All fixture resources and raw diagnostic files were removed after analysis.

## Results

Every ordinary elastic admission made **10 SQL round trips for input acceptance
and 31 for Worker admission**, including BEGIN/COMMIT. This is two commits, not
41 fsync calls; HTTP authentication/response handling is outside the store probe.

| Warm 15 rounds per cohort, median | Auto 1 | Forced generic | Auto 2 |
| --- | ---: | ---: | ---: |
| Store input transaction | 10.10 ms | 10.74 ms | 9.95 ms |
| Worker admission | 25.82 ms | 26.73 ms | 23.24 ms |

Forced generic plans did not show a stable improvement. Warm cached SELECT/WITH
planning was already small. Repeated `SELECT 1` through the same adapter measured
0.23–0.36 ms median across the three client processes. That is a full client/server
exchange, not pure network latency. Many sequential exchanges accumulate even
when all services are on one machine.

The following is one actual warm pair from the logged cohort, not a sum of
independently calculated percentiles:

| Non-overlapping elapsed components | Input acceptance | Worker admission |
| --- | ---: | ---: |
| PG parse/bind/execute, excluding COMMIT | 2.57 ms | 8.34 ms |
| PG server COMMIT | 2.90 ms | 4.38 ms |
| Client query time outside server duration | 2.94 ms | 10.57 ms |
| Application/pool work between queries | 1.48 ms | 4.04 ms |
| Total | 9.89 ms | 27.34 ms |

The client/server difference includes transport, scheduling, result decoding and
Node callbacks; it is not all packet travel. Server duration logging includes
the actual COMMIT path; `pg_stat_statements` utility timing alone did not measure
that path (its COMMIT entry was about 0.001 ms). Do not interpret the difference
as Node delay. See [PG statement statistics](https://www.postgresql.org/docs/17/pgstatstatements.html)
and [duration logging](https://www.postgresql.org/docs/17/runtime-config-logging.html).

One logged claim took 165.79 ms, including **142.53 ms inside server COMMIT** and
142.91 ms awaiting that COMMIT at the client. This localizes the outlier to server
commit processing, not client delivery alone. This probe did not sample its exact
wait event, so it does not independently attribute that interval to a disk/driver.
Earlier [WalSync evidence](startup-wal-tail-20260918.md) is separate evidence.

## Remaining simplification opportunity

Atomic admission removed separate transaction boundaries, but retained modules
that used to defend their own entry independently. In the same transaction:

- physical Session ownership is locked/read twice;
- writer selection checks owner compatibility, then lease acquisition checks it
  again under the same physical-Session lock;
- publication registration re-locks the newly created Attempt and lease and
  queries their joined authority view;
- running-state setup reads/locks lifecycle rows, then the transition helper
  reads Run/Attempt again;
- freshly inserted claimed Run/Attempt rows are subsequently updated to running
  before that transaction has become visible to any other connection.

These are candidates for a single transaction-local admission implementation,
not permission to delete every check. Keep lock ordering, fresh post-lock database
time, capacity/cancellation checks, row versions and exact lost-COMMIT confirmation.
Reuse already-locked/current rows only within that transaction, and combine writes
without modifying the same row twice in one data-modifying CTE. No authority
cache, new service, weaker fsync setting or new recovery semantics is needed.

The isolated client excludes production HTTP, queue wake-up and competing Worker
work; its 23–27 ms admission is not an exact breakdown of the production 38 ms.
This identifies avoidable fixed work, not a promised latency reduction. Any
implementation should receive a new matched real-model and fault comparison.
