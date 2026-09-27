# ADR-0197: Indexed native Session log and bounded current state

## Status

Accepted, 2026-09-27. The owner approved option B after the
[isolated PostgreSQL comparison](../reports/native-log-layout-study-20260927.md).
This replaces ADR-0147's Entry/Record/COW query-table layout, retaining its
self-contained immutable semantic log and all execution authority boundaries.

## Decision

- `pi_session_log` stores each complete native Entry/Record body once. Stored
  generated metadata and scoped B-tree indexes support identity, parent, type,
  Lane, operation and Turn queries. The Session-local sequence and append ID
  keep their existing ordering/idempotency meanings. Pi's public SessionStorage
  port and exact Entry/Record content remain the contract.
- Remove `pi_session_entries`, `pi_session_records`, `pi_session_entry_refs`
  and `pi_session_visible_entries`. Update every reader/writer; retain no
  compatibility views, alternate reader or dual write. Branch reads walk only
  metadata by exact parent ID and fetch selected bodies afterwards. Ordered
  paging must limit metadata before unnecessary body extraction.
- Session names, Lane heads and labels remain transactional current state.
  `pi_session_open_operations` stores only `(tenant, Session, Lane, start seq)`
  for unfinished native operations. An insert-statement trigger applies starts
  and finishes atomically with the log, including batches containing both.
  Reads join these bounded references to the original start body. Multiple
  unfinished starts remain representable so Pi's corruption check still works.
  This is neither a Tool execution ledger nor authority to replay effects.
- Immutable `payload.turnId` records the original binding. A separate ordinary
  `turn_id` column is initialized from that binding on INSERT and retains the
  existing `turns` FK with `ON DELETE SET NULL`. It represents a live control-row
  association; rebuilding current state never restores a deleted association
  or rewrites the immutable log. Identity/parent/type fields are generated from
  the payload and cannot drift independently.
- Human Fork already copies complete Entry facts into its destination log.
  Query that independent copy directly, including nested Forks; remove physical
  source-Entry dependencies. Native source deletion does not invalidate a Fork.
  Product subtree deletion, archive/prune rules and quiescence requirements are
  retained. Product Forks preserve origin Turn bindings while canonical Turn
  output still filters by the Turn's execution Session. SDK Forks keep their
  existing null Turn binding.
- The image-retention trigger stays on the log. Fork and Compaction copies
  retain their own attachment references. Session deletion releases only that
  Session's references; GC cannot remove objects retained by another Fork.
- Rebuild validates the immutable log and reconstructs only current state;
  it never copies Entry/Record bodies or executes model/Tool work. Active writer
  fencing, Kafka ACK, Projector progress/seals and replay suppression are retained.

## Adoption and cutover

Use existing PostgreSQL 17 generated columns, indexes, foreign keys and
transactional triggers behind the PiCloud storage adapter. The research note
records official documentation, custom/generic query plans, storage/WAL/read
measurements and alternatives. No new broker, event store or workflow engine
is needed. Thin Entry/Record tables add another body lookup and maintenance path
without a demonstrated advantage for the selected workload.

One forward migration derives indexes from existing self-contained logs, carries
forward live Turn associations (including nulls after deletion), seeds current
open operations, then drops the retired tables/view. It does not retain an
old-schema runtime path or discard canonical history. Stop old application writers
before applying it; application images and schema cut over together. Rollback
requires the prior database snapshot and matching application revision, not an
attempt to reconstruct the removed layout while applications are running.

## Acceptance and limits

Require the official Pi backend conformance suite, real-PG append locking and
idempotency/fencing checks, bounded prepared query plans, current-state rebuild,
Turn/Fork isolation, source deletion, transactional rollback and attachment
retention/GC tests. Repeat native Tool/compaction/Subagent product acceptance on
the matched deployment with GPT-6 Luna.

Full statistics/export and uncompressed or oldest-first ancestry remain
proportional to the requested history. The new open-operation state removes
the measured lifetime anti-join from cold recovery. The study's space/WAL
savings are synthetic observations, not a production throughput or HA promise.
