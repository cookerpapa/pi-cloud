# ADR-0286: Validate shared history roots before changing production storage

Status: isolated validation completed, 2026-10-29; production adoption not accepted.
[Results](../reports/shared-history-root-prototype-20261029.md) show metadata-only
subsecond Forks, but read/write p95 is not consistently within 10% and the prototype
rejects legal out-of-order native Entry commits. ADR-0284/0285 remain production
authority. Full integration gates below are still open.

## Decision and scope

The owner approved a small working prototype that measures Fork, ordinary append,
pagination, native context preparation and interference from collection. A fast
Fork alone does not authorize a production migration. The initial performance
guardrail is at most 10% p95 regression for ordinary append/read under comparable
conditions; noise, cold reads, SQL, bytes and sample counts must be reported.

The prototype uses an isolated real PostgreSQL database and synthetic content.
It has no production configuration, API registration, migration or Kafka writer.
Source-only experiment changes do not require replacing the serving runtime.

Represent a view as an immutable ordered directory of retained history prefixes
plus its own append stream. Original records and fixed presentation metadata are
stored once. Fork freezes a prefix and creates an empty independent stream;
it neither returns old bodies to Node nor creates one reference per old record.
An immutable balanced directory bounds nested-Fork traversal. Reads resolve the
view before reading a bounded page, and invoke the pinned Pi Harness's public
context API through a read-only fixture adapter.

The prototype deliberately does not claim a full Pi Storage implementation:
mutable document versions, Task/Submission/Inbox state, Kafka recovery, production
image ownership and UI metadata migration remain separate admission gates. A
reference MemoryStorage is allowed only as a test oracle or for the read-only
Harness fixture's empty runtime state, never as another durable authority.

## Build versus adopt

[ADR-0285](0285-batched-native-history-forks.md) records verified versions, licenses
and sources for Git, Temporal, Dolt and PostgreSQL. Further source inspection of
[Temporal's SQL history store](https://github.com/temporalio/temporal/blob/v1.32.1/common/persistence/sql/history_store.go)
confirms that Fork inserts branch metadata and deletion operates on retained
history ranges. [Git's references](https://git-scm.com/book/en/v2/Git-Branching-Branches-in-a-Nutshell)
reuse immutable history; [GitLab's object pools](https://docs.gitlab.com/development/git_object_deduplication/)
also illustrate the collection obligations of shared storage.

Adopt PG's transactions, row locks, foreign keys and indexed range reads. Embedding
Git would add a second PG/filesystem commit boundary; Temporal would overlap Pi's
workflow authority; Dolt would replace the database behind existing PG admission
and lease semantics. None is a drop-in implementation of Pi's Storage port. The
bounded directory experiment is justified to measure that adapter gap, not to
build a general database, scheduler, CRDT or agent graph. No production package
imports this experiment. A failed validation is evidence against adoption.

## Required behavior

- Fork installs its retained references in the same transaction as the new view;
  a successful retry returns the same view. An incomplete transaction exposes no
  new view. Source deletion cannot invalidate an acknowledged child.
- Append checks the view generation and commit identity. A pruned or deleted old
  view cannot append through a stale handle. This is an experiment boundary, not
  a replacement for production leases or Kafka fencing.
- A prefix must include both the record cutoff and captured publication bounds.
  The experiment must state any ID-order assumptions rather than silently claim
  full native conformance.
- Collection follows actual root/node references, retains in-flight read pins,
  and removes only unreferenced suffix records/assets. A live prefix cannot keep
  an otherwise unreachable suffix indefinitely. No hand-maintained ref counter.
- Content is checked on write and read. Fork checks directory integrity and
  boundaries; it is not a full-history integrity scan. A corruption test must
  make that changed failure timing explicit.
- Restart/reopen and native context derivation must preserve compaction bounds,
  retained recent entries, ContextEdits and tool-result ordering. No earlier
  compaction can be replaced by one beyond the fork point.

## Measurements and gates

1. Compare flat versus directory-enabled append on identical synthetic records,
   transaction sizes, integrity checks and indexes. Alternate order and report
   warm/cold results; do not compare a toy append with production's entire state
   machine and call it a production speedup.
2. Measure 10 MiB, 100 MiB and 1 GiB histories and 1,000 successive Forks. Record
   Fork SQL/bytes/inserted directory rows, body counts, p50/p95, read depth and
   first context load. Body volume must not be shifted to a later read or job.
3. Exercise native context through public APIs, rollback, concurrent Fork/delete,
   concurrent append/Fork, collection interference, stale cursors/handles,
   retained images and last-reference collection. Reopen through a new PG pool.
4. Separately prove full native Storage conformance, document `asOf`/`current`/
   `initial`, source-independent mutable baselines, original commit fingerprints,
   live replay protection, full presentation and real S3 ownership before any
   production cutover. The proposed snapshot-plus-local-suffix integrity format
   is not silently substituted for the deployed contiguous-journal contract.

The target is subsecond Fork admission for the large fixture with small inherited
state; this is not an SLA for arbitrary state size, contention or LLM latency.
Search/export and actual data deletion remain proportional to work performed.

Only after the gates pass should a matched schema/read/write/rebuild migration be
implemented. Preserve conversations, image bytes, accounts/configuration and
Workspaces; retire the old import paths after verified conversion, with no permanent
dual writer or compatibility fallback.
