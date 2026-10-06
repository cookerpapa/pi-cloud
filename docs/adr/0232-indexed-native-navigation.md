# ADR-0232: Indexed native navigation and bounded history copying

Status: implemented, verified and deployed, 2026-10-06.
[Source verification](../reports/review-repair-20261006.md) and
[matched release](../reports/review-release-20261006.md).
The owner approved R06-04 and the associated native projection/query improvements.

## Decision

Keep native bodies only in `pi_durable_log`. Extend the existing disposable record
index with a `navigation` classification: user, final assistant, or none. Derive
it from the first user/assistant model message, matching the existing tree mapper.
Tool proposals/results, system records and compaction bodies are not copied into
a second query table. No model, Harness or untrusted code runs during projection.

The same thin index records each document's `currentOnly` policy. Derive revision
version/count inside a batched PostgreSQL INSERT instead of fetching a definition
and previous revision for every delta. Materialize a bounded tail only when a
64-delta checkpoint is due. Retain exact commit/sequence and duplicate-conflict
checks; metadata flags are rebuildable, never another write authority.

Navigation reads filter through this partial index before fetching bodies. Query
the necessary records in bounded pages and enforce the existing tree response
budget before retaining them. Preserve current API/branch selection semantics;
this is not a new Session quota or a change to native context selection.

Prune validates its anchor through navigation records. A human Fork validates
there too, then streams the full native prefix only through the chosen anchor.
Copy in bounded native commit batches inside the existing quiescent PG transaction.
Preserve native numeric IDs, head markers, document fork policies, Turn origins and
image retention. Failure rolls back the whole administrative transaction.

PostgreSQL remains the sole query materialization. Use its existing expression/
partial indexes and cursor ranges; another cache, search engine or event store
would duplicate authority without fixing the overbroad selection.

## Migration and verification

Schema 181 backfills the derived navigation classification and document current-only
policy in bounded pages, parsing native
JSON text in JavaScript so valid native NUL/unpaired-surrogate strings need not
be coerced to PostgreSQL JSONB. Native bodies remain byte-for-byte unchanged.
A constraint refuses entries from an outdated projector that cannot write the
new index field; it must stall safely rather than create invisible history.
Drain and deploy matching Control Plane/migration artifacts. Index rebuild uses
the same classifier as live projection; do not add an old-query fallback.

Verify actual query payloads on Tool-heavy histories, active/failed/branched
Turns, inherited anchors, native NUL strings, rebuild/backfill, and independent
Fork copies spanning multiple batches, documents and attachments.
