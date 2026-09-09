# Trusted private publication acceptance

2026-09-09; implementation `0dd25fe3`, ADR-0164. No schema/topic reset.

## Change and correctness

Removed Ed25519 key generation, signing, signature fields, verification and
public-key caches. Workers still open under PG Lease/fence authority and publish
directly to Kafka. Projector checks frozen scope, opening order and positioned
seals. No replacement credential, per-record PG query or compatibility mode.

- Full single-process Vitest run: **734 passed, 3 skipped**, 129 passing files.
- All workspace typechecks, formatting, documentation and runtime-time-budget
  checks passed.
- Native-host integration asserts records have no signature and openings have
  no public key. It rejects wrong fences/partitions and data before opening;
  rebuilding the boundary cache does not prevent valid replay.
- Parent/Child Lanes run with projection paused; a replacement Host cold-restores
  Compaction and the interrupted visible prefix. A correctly attributed late
  native record remains ineffective after its seal.
- Sixteen seal tests and twelve Tool executor tests cover atomic rollback,
  duplicate delivery, successor ordering, UNKNOWN and no shell replay.

These are deterministic runtime/network/PG-emulation tests plus real Kafka load.
Paid Provider/Cube acceptance was **not rerun** for this signing-only change.

## Isolated publication measurement

[Current report](kafka-accepted-fact-load-latest.json): one Node 24.18 producer
process, four producer lanes, 256-byte text fragments, 32 Kafka partitions,
three brokers, RF3/acks-all. Reported host: 32 logical CPUs, 19.53 GiB RAM.
No model, PG projection, Projector verification, Cube or browser is timed.

The earlier [signed baseline](https://github.com/cookerpapa/pi-cloud/blob/24ab9dc2/docs/reports/kafka-accepted-fact-load-latest.json)
uses the same workload configuration. Measurements were separate runs, not an
interleaved controlled A/B trial; host background load can differ.

| Case | Earlier signed | Current unsigned |
| --- | ---: | ---: |
| Single Session ACK p50 / p95 | 4.164 / 4.776 ms | 3.856 / 4.599 ms |
| 256 logical Sessions, sustained records/s | 10,877.28 | 24,496.85 |
| 512 logical Sessions, sustained records/s | 12,791.11 | 29,791.90 |
| 1,024 logical Sessions, sustained records/s | 12,815.57 | 32,730.94 |
| 1,024 logical Sessions ACK p50 / p95 | 63.897 / 127.779 ms | 27.760 / 52.879 ms |

Each sustained case appended 262,144 records. This is synthetic publication
capacity, not 1,024 measured live Agent Loops or an end-to-end TTFT improvement.

## Deployment and cleanup

Confirmed zero active leases, unpublished seals and unsealed publications before
replacement. Built and restarted both Workers and Control Plane/Projector; all
three passed health checks, and the public Web endpoint returned HTTP 200.
Kafka, PostgreSQL, Tool Broker, Cube and Workspace Volumes were not recreated.
The independent benchmark Topic was deleted and its absence verified.
No test user, conversation, Workspace or development machine was created;
the original **35 users and 52 Sessions** remain. Only aggregate reports are kept.
