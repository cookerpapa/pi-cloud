# Shared history root prototype, 2026-10-29

The isolated prototype validates that history-directory Fork can avoid work
proportional to old body bytes. It is **not ready for production migration**:
the 10% read/write p95 guardrail is not consistently met, and its Entry ordering
restriction is narrower than the native Storage contract. Production remains on
ADR-0285 / schema 203. No production database, model request or VM was used.

[ADR-0286](../adr/0286-shared-history-root-prototype.md) records the scope and
adoption decision. [Runnable experiment](../../scripts/experiments/shared-history-roots/README.md).

## Implemented experiment

Real PostgreSQL stores immutable Entry/presentation bodies, append-stream prefix
metadata, a persistent AVL directory, independent view roots, request identities
and read pins. Fork creates a prefix reference and an empty stream. Ordinary
append does not rebuild the tree. Collection checks actual root/node references
and trims only unreferenced suffixes; image bytes are a PG stand-in used solely
to test reachability, not an alternative attachment service.

A read-only fixture invokes the pinned Pi Harness's public context method. Its
empty runtime metadata uses native MemoryStorage; it rejects mutations and does
not implement durable Tasks, Submissions or documents. This is not the upstream
Storage conformance suite or a simulated successful cloud rollout.

Fourteen scoped checks pass: native Fork document-write shape, the native ID-order
counterexample, independent prefix/image retention, source-tail collection, read
pins, request replay, ambiguous commit replies, rollback/cancellation, concurrent
Fork/delete/append, stale handles/cursors, body/directory/cursor-boundary integrity,
balanced nested pagination, native compaction/context-edit/Tool-result derivation
and reopen through a new PG pool. Some checks intentionally prove limitations.

## Large histories

Timings use the final measured read resolver, with a later cursor-boundary integrity
check covered by the scoped tests. That check does not run on the first-page,
first-context or Fork timing paths below. Data is synthetic and compressible;
sizes are logical JSON body bytes, not physical disk occupancy. Timings exclude
SQL trace encoding. PG and OS caches are not forcibly flushed.

| Logical history | Directory Fork p50 | Directory Fork p95 | SQL calls in separate trace | Old body rows returned | New directory nodes / new Entry rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 MiB | 10.8 ms | 14.3 ms | 10 | 0 | 1 / 0 |
| 100 MiB | 10.2 ms | 11.6 ms | 10 | 0 | 1 / 0 |
| 1 GiB | 10.1 ms | 12.0 ms | 10 | 0 | 1 / 0 |

Each size has 30 timed Fork samples. The traced operation sends/returns only
roughly 1–2 KB of metadata. These figures cover directory admission, **not the
complete PiCloud API, native mutable-state setup or model latency**; they must not
be advertised as a measured replacement for the deployed 61.7-second API/service
fixture.

A fresh native reader on each Fork reads 28 body rows / about 30 KB, independent
of total history size: the latest visible summary and its active suffix. It does
not load the old body volume later. The trace uses 15 SQL calls after metadata
read consolidation, down from 21 in the initial prototype.

After 1,000 successive Forks, the directory height is 11. The final 50 Forks have
p95 31.1 ms, compared with 23.9 ms for the first 50. Every ID
remains accessible through keyset pagination; the directory does not recursively
look up 1,000 product Session parents. The experiment can collect the 7,969
superseded directory nodes while retaining the reachable records.

## Costs elsewhere

The flat and shared modes use identical synthetic bodies, IDs, transaction sizes,
tables/indexes and body/metadata integrity checks. Mode order alternates; ordinary
operations have 120 samples after 20 warmups. Context has 30 samples after 10
warmups. These are comparisons within the experiment, not a benchmark of the
complete production Projector.

| Text per Entry | Operation | Flat p95 | Shared p95 | Change |
| --- | --- | ---: | ---: | ---: |
| 768 bytes | Append | 8.22 ms | 9.05 ms | +10.16% |
| 768 bytes | Latest page | 7.19 ms | 8.05 ms | +11.95% |
| 768 bytes | Native context | 21.96 ms | 21.30 ms | −3.0% |
| 30 KiB | Append | 10.07 ms | 10.38 ms | +3.05% |
| 30 KiB | Latest page | 9.95 ms | 10.89 ms | +9.49% |
| 30 KiB | Native context | 22.06 ms | 21.06 ms | −4.52% |

The earlier complete run stayed inside 10% for these ordinary operations; the
small development run had a much larger outlier. This variability is retained in
the evidence. A 10.16% result is not rounded into a pass or evidence of a precisely
known permanent regression. The guardrail has **not been demonstrated reliably**.

Inherited reads are also compared. For one-stream snapshots, the direct-index
control is a mutation-disabled view over the identical rows while the source is
stationary. For the small 1,000-Fork fixture, a flat read control is materialized
once outside all Fork/read timings; its setup cost is reported separately.

The deep-Fork latest-page p95 is 13.07 ms versus 9.90 ms for the direct index:
**+3.17 ms / +32.0%**. Combining view/stream/root metadata reads improved the
earlier 16.06 ms versus 11.26 ms result, but did not reach the 10% goal. The final
1 GiB inherited first-page comparison also has an 18.0% p95 regression. No claim
of free shared reads is warranted.

An aggressive collector running every 10 ms with 64-record batches increases
append p95 from 9.08 to 10.60 ms (+16.8%) and page p95 from 7.65 to 9.37 ms
(+22.5%). All 4,096 garbage records are removed and live records remain valid.
This stress rate is much higher than deployed maintenance; it demonstrates that
collection pacing matters rather than predicting production overhead.

## Write amplification

An independent probe alternates 200 measured two-Entry commits per mode after 40
warmups. It samples PG WAL positions around each append; timing instrumentation
does not include these extra observations. Background PG activity can add noise.

| Text per Entry | Shared / flat WAL bytes | Shared / flat heap tuple bytes |
| --- | ---: | ---: |
| 768 bytes | 1.094 | 1.073 |
| 30 KiB | 1.045 | 1.066 |

Directory prefix metadata has a real write/storage cost. Tuple sizes use
`pg_column_size(row)` and exclude indexes and separate TOAST storage; the logical
body byte totals and record counts match between modes. This is not a claim that
total production storage grows by those exact percentages.

## Why production adoption remains gated

1. Native MemoryStorage allows candidate Entry IDs to be reserved and committed
   out of order. The prototype rejects that case. A full adapter must preserve
   the native ID/commit-boundary semantics instead of assuming ID order is always
   publication order. The read-only context tests do not waive this requirement.
2. Inherited reads and GC interference still exceed the initial performance
   guardrail. The next resolver should reduce the remaining directory round trips
   and proof/row materialization, with paired cold/warm read measurements.
3. Mutable document baselines, Tasks/Inbox/Submission ownership, multi-Conversation
   family recovery, Kafka replay integrity, full presentation and real S3 deletion
   have not been integrated. Native Fork emits document-copy references without
   copying Entries, which supports the direction, but does not prove those cloud
   contracts automatically.

The next vertical slice should settle snapshot visibility for legal native
write ordering and verify the complete Storage port before a schema migration.
No production switch, compatibility fallback, second writer or background full
history copy is introduced by this experiment.

Private raw reports, including initial failures and both complete benchmark runs:
`deploy/production/runtime/work-evidence/shared-history-roots-20261029/`.
