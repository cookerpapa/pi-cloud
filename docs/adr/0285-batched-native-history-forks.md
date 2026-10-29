# ADR-0285: Batch reference imports for independent history

Status: accepted for implementation, 2026-10-29. Builds on ADR-0284; not yet deployed.

The owner requested faster large-history Forks and a survey of mature open-source
approaches. Existing native ownership, document policies, reference collection and
matched publication remain the acceptance boundary.

## Evidence and adoption decision

| Implementation | Verified source and license | Relevant mechanism and fit |
| --- | --- | --- |
| Git v2.56.0, GPL-2.0 | [References](https://git-scm.com/book/en/v2/Git-Internals-Git-References), [transactional ref updates](https://git-scm.com/docs/git-update-ref), [GC concurrency](https://git-scm.com/docs/git-gc), [license](https://github.com/git/git/blob/v2.56.0/COPYING) | A branch names existing immutable history. Concurrent collection must respect references still being installed. Adopt reference sharing; a Git object store would add a separate durability boundary to PG/Kafka. |
| Temporal server v1.32.1, MIT | [SQL history store](https://github.com/temporalio/temporal/blob/v1.32.1/common/persistence/sql/history_store.go#L248), [history manager](https://github.com/temporalio/temporal/blob/v1.32.1/common/persistence/history_manager.go#L36), [license](https://github.com/temporalio/temporal/blob/v1.32.1/LICENSE), [releases](https://github.com/temporalio/temporal/releases) | A history branch records ancestor ranges; the SQL fork inserts branch metadata. Deletion computes retained ranges. This is a storage comparison: Temporal does not become an active PiCloud scheduler. Its event batches and workflow history are not Pi Storage records. |
| Dolt v2.3.3, Apache-2.0 | [storage and sharing](https://www.dolthub.com/blog/2026-10-08-how-dolt-remotes-work/), [tradeoffs](https://www.dolthub.com/blog/2025-09-10-challenges-with-prolly-trees-and-columnar-storage/), [release](https://github.com/dolthub/dolt/releases/tag/v2.3.3), [license](https://github.com/dolthub/dolt/blob/v2.3.3/LICENSE) | Content-addressed trees share unchanged chunks; updates rewrite affected paths. Adopting its database would replace PG storage/transactions and require a broader migration. Its release also records an index-write/GC correction: shared storage still needs verified failure behavior. |
| PostgreSQL 17, already deployed | [INSERT from a query](https://www.postgresql.org/docs/17/sql-insert.html), [SHA-256](https://www.postgresql.org/docs/17/functions-binarystring.html), [FKs](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK) | Adopt set-based SQL, existing transactions and foreign keys. The adapter can retain per-Session records without sending unchanged bodies through the Control Plane. |

These systems support sharing already committed data through references. PiCloud
keeps its current flat references rather than introducing a new tree/storage
service. That preserves independent Session sequence numbers and current native
read/rebuild behavior. Forks remain linear in reference count and DB checksum work.

## Reproduced baseline

The isolated service fixture at `0edbf8b5` with phase observation uses
1,074,614,914 bytes, 17,664 Tool iterations and 35,329 Entry bodies. First Fork:
193.0 s / 83,431 SQL calls, ~1.108 GB parameters and ~1.123 GB returned rows.
Its native/display/image phases are 60.5 / 79.6 / 52.9 s. Nested Fork: 123.3 s,
including 55.2 s of image-metadata paging despite having no images. These byte
counts describe application parameters/result encoding, not TCP packet captures.

The first set-based version eliminated ordinary body round trips, but spent too
much time manipulating wide checksum intermediates. Narrow reference CTEs and a
small materialized hash result avoid repeatedly handling the large preimages.
The final fixture measures 61.7 s / 2,001 SQL calls for the first Fork and
50.1 s / 1,181 calls for a nested Fork. First-Fork parameter/result encoding falls
to 11.2 / 30.2 MB. Its phases are 53.0 / 8.5 / 0.05 s; DB checksum work is now the
largest cost. These are local measurements, not latency guarantees. The generator,
size and shape match the baseline; generated paragraph bytes are random per run.
Private reports are under
`deploy/production/runtime/work-evidence/fork-performance-20261029/`.

## Implementation

1. Measure native import, display metadata and image retention separately, with
   SQL counts and application/database bytes. Compare the same synthetic workload.
2. Import existing Entry references in bounded SQL batches. Keep the canonical
   body IDs, native IDs, ancestry, ID watermark and cloud provenance; remove
   execution ownership exactly as the current independent import does. Reuse
   disposable index fields with the same identity transformation.
3. Compute the existing synthetic commit and retained-history fingerprints in
   PG, over exactly the same JSON bytes as the JS implementation. Native replay
   fingerprints keep their meaning. Ordinary Worker commits keep their current
   path. Do not change checksum formats or discard integrity validation.
4. Entry payloads stay in PG during reference copying. Image-bearing bodies may
   be selected for the existing reference validator; payload TEXT is never cast
   to JSONB, preserving NUL/lone-surrogate semantics. Install image ownership in
   the same transaction. Mutable native documents continue through the existing
   public Storage path and preserve `asOf`/`current` policies.
5. Batch up to 128 frozen display descriptors and references rather than issuing
   two SQL statements per record. Existing frozen metadata remains directly
   shareable. Select possible image metadata before paging; image-free histories
   no longer page through every descriptor solely to retain images.
6. Keep source KEY SHARE, target quiescence, fresh contiguous commits, FK-backed
   collection, idempotent admission and complete transaction rollback. An
   incomplete destination cannot become visible or acquire a writer.

## Acceptance

- Byte-equivalent hashes and rebuild indexes for Unicode, escapes, image
  references, ContextEdits, document ancestry and stripped/retained task identity.
- No steady-state commit SQL regression and no large body payload returned to
  the application for ordinary Entry-only reference copies.
- Existing concurrent Fork/prune/GC, rollback, queued-input, child-family and
  native Harness restore tests pass.
- The same 1 GiB fixture measures phase/SQL/byte reductions, plus actual API/Web
  navigation and independent source pruning. Report the achieved speed and
  remaining linear costs; do not call the result constant-time.
- A matched release and owned Luna/Cube/history/image/restore acceptance preserve
  existing conversations, configuration and Workspace assets.

The SQL import is private to this storage adapter and accepts only retained
server-selected records. Public APIs, active Kafka writes, tooling authority and
Pi core remain unchanged. Export and rollback retain ADR-0284's matched contract.
