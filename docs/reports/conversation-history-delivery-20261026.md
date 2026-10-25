# Long conversation presentation delivery

Status: deployed as `history-window-19c24570`, application revision
`19c24570afe93048dff777ee0b6df59c7076b36a`, schema 200 / Helm revision 107.
The owner approved [ADR-0278](../adr/0278-windowed-conversation-presentation.md).

## Behavior

Opening a conversation now reads a window of native positions, including inside
one long Run. Queries select positions and byte lengths before fetching bodies;
Tool arguments resolve by native Task identity even across a page boundary.
There is no additional transcript table, history writer or execution scheduler.
Migration 200 backfills disposable navigation/Tool indexes without changing native
bodies or their fingerprints. Arbitrary native JSON is never cast to PG jsonb.

The browser retains four historical pages and a separate bounded live tail.
Virtual rows are message blocks rather than whole Runs. Prepending, eviction,
refresh and late image sizing retain the reading anchor. Tool disclosures survive
virtual unmounts while their page remains resident. Large code has virtual lines
instead of whole-output syntax highlighting. New live output leaves historical
readers in place, with a way to return to the latest view.

Tree navigation and search seek directly to a neighborhood. Search scans bounded
canonical pages and can be cancelled; it does not introduce a full-text index.
Markdown export streams completed canonical history through the server and the
browser download path, without a browser-wide transcript array or Blob. The
existing database adapter cancels disposable reads, using a separate four-slot
read pool; authority writes and queue observations retain their own connections.
The obsolete Turn-only pagination/whole-browser export paths are removed. Snapshot
payload version 3 carries the new history boundary, not a client SSE resume cursor.

## Verification

- All workspace tests: 2,170 passed. Separately, the real PG/Kafka transport suite
  passes all nine cases; gated skips in the ordinary suite are not counted as
  transport coverage.
- All 375 fault cases pass. Install/runtime policy, Cube admission/allocation,
  Helm, observability, image closure, acceptance-helper and dependency checks pass.
- All workspace types, the Web build and the complete existing browser
  presentation suite pass. The latter includes commands, drafts, Stop/queue
  behavior, images, preview links, child navigation and reconnect rendering.
- New PG tests cover within-Run forward/backward/direct seeks, byte bounds,
  cross-Session rejection, repeated provider Tool IDs, large Unicode inputs,
  bounded navigation, all-page export and native-body-preserving index backfill.
- The composed API/browser driver exercises actual PG native projection, actual
  HTTP/SSE and the real Web components, with generated history and live events.
  It does not simulate a model, Kafka writer or guest and is not evidence of their
  execution semantics. Real execution acceptance follows matched deployment.

The production-artifact 1 GiB composed run passes:

| Measurement | Observed on this single WSL host |
| --- | --- |
| Native test data | 1,073,973,615 serialized bytes; 49,845 records in one Run |
| Latest read | 8 SQL statements; 2,525,817 body bytes fetched; 119 ms |
| Direct Entry read | 10 SQL statements; 2,599,232 body bytes fetched; 86 ms |
| Browser residency after 24 page reads | 4 pages; 15 mounted blocks; GC heap 15.7–15.8 MiB |
| Full streamed Markdown export | 1,059,591,654 bytes; all 16,528 text markers and Tool results |
| Abandoned blocked query | Released in about 0.96 seconds, before the SQL deadline |
| Reading stability | Refresh, Tool virtual unmount/remount, delayed image growth and 600 subsequent outputs pass |

These are local measurements with generated compressible content, not production
fleet capacity, physical disk size or latency guarantees. The browser still loads
one native message within existing transport limits; a single arbitrary Markdown
block is not claimed to have constant rendering cost. Far-away text search may
require many short page reads. Ordinary opening/scrolling does not scan all text.

Small composed checks caught and corrected refresh-at-page-end clamping and
late-image scroll drift. An earlier 1 GiB development-server page did not finish
mounting; it is retained as a failed diagnostic. The maintained driver builds and
copies the actual production Web artifact into its own temporary preview server.
An early production run also exposed a CDP test trying to serialize a DOM object;
the boolean assertion and action settling were corrected, and the full run above
passed. No failed sample is counted as accepted evidence.

## Publication and preservation

This changed a shared public schema, dependency and PG indexes, so it used the
maintained matched release procedure. All 12 matched artifacts passed the current
scan/provenance gate. The first preparation verification correctly rejected a
dirty checkout when the concurrent fault runner wrote its generated reports.
Those reports were retained privately, the committed source restored, and
unchanged artifact preflight passed. No gate was bypassed or image rebuilt after
scanning. The fault reports are restored in this documentation follow-up.

Native writers drained before migration. The original allocation was closed and
confirmed absent on its recorded node before clearing its live handle; public
machine Release was not used. The same logical development machine and Workspace
recovered on allocation generation 13. All three original applications on ports
3000, 4188 and 8080 were restarted and served identical HTML bodies.

Real GPT-6 Luna/Cube/browser acceptance passes: guest browser interaction/canvas,
screenshot vision, `show_image` visible outside collapsed activity, identical
live/cold image identity after source deletion, and named Preview links that open
the actual application. Native-input acceptance also passes consumption/editing,
Stop and returned inputs, Worker SIGKILL recovery, streaming Stop, and simultaneous
Worker/Control Plane SIGKILL with same-Run recovery and retained native partial
output. Stream text still does not create PG streaming bodies. Both owned test
tenants and their physical Workspace resources are cleaned up.

Final preservation checks pass across 15 account/configuration/native tables
with no leftover fixture rows, the 5,700-file Workspace inventory (excluding the
stated mutable runtime files), all 27
configuration hashes, the game's five-table logical snapshot and all 37
referenced image hashes. Migration-owned derived index fields are excluded from
immutable-row comparison and separately covered by backfill tests/preflight.
Runtime logs/PIDs and SQLite WAL/SHM are explicitly mutable. Final reconciliation
finds 28/28 Pods ready, no active Runs, Session writers, Tool bindings or elastic
VMs, and the retained dedicated machine and its three original applications ready.

The server history-search scan is intentionally bounded and cancellable, without
a separate full-text index. Explicit Fork/prune mutations retain their existing
native verification/copy semantics; this read optimization does not claim
constant-time branch creation. Reload an existing browser tab to load the paired
snapshot-version-3 client. No browser update notification or old-protocol fallback
was introduced.

Private evidence is under
`deploy/production/runtime/release-evidence/history-window-20261026/`; generated
histories, credentials and user files are not committed.
