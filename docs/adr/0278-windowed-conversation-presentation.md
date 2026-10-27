# ADR-0278: Windowed conversation presentation

Status: deployed as `history-window-19c24570`, schema 200, 2026-10-26. The owner approved bounded
history reads, a bounded browser working set, virtual rendering and direct
navigation for very long conversations, including one long-running Run.

## Authority and read boundaries

Native history/current state remains in the existing PostgreSQL stores; Kafka
and the single Session Projector retain their current roles. Add derived indexes
on existing tables, not another transcript copy, cache service or history writer.
Do not modify Pi scheduling, compaction, model context or execution admission.

History uses opaque, tenant-checked positions within a visible Turn's native
sequence/ordinal range. An initial-input/control-action position precedes its
native records. Pages work within a Run and across the existing branch lineage.
Reads select a bounded number of positions and byte lengths before fetching
bodies. The existing native execution-fact boundary bounds individual records;
related Tool intent/assistant reads count towards the page budget. Parameters and
results pair through native task identity, never provider call ID alone.

Initial/reconnect SSE snapshots use the same recent window. They retain the
existing canonical-through/display coverage proof. Browsing cursors do not
become Last-Event-ID, Kafka offsets, authorization, leases or execution commands.
Older-page reads cannot reset live coverage. UI eviction never deletes history.

Original human-input presentation is read only for selected consumed inputs.
Native JSON text retains its escaped NUL/surrogate contract; never cast arbitrary
native payloads to PostgreSQL jsonb. Any bounded metadata extraction must validate
the selected input identity and be covered by lossless/adversarial-string tests.

## Browser

Keep a bounded recent live view and a bounded browsing window. Use stable item
identities and dynamic measurement, rendering visible rows plus overscan. A Run
is not one virtual row. Details and images mount on demand; exceptionally large
text/code blocks use bounded presentation chunks rather than a giant DOM subtree.
Evicted page bodies and parser/measurement state must be released.

The October 27 [layout repair](../reports/conversation-layout-repair-20261027.md)
keeps measurements for retained row identities while evicting removed keys. The
pinned adapter owns live coordinates and the size container; React must not also
write those coordinates. A stable footer needs explicit live-tail following when
new rows are inserted before it. Bookmark offsets apply after the target mounts,
and prefetch distance must not become a blank viewport in the transcript. These
refinements preserve the existing read/storage boundaries and dependency pin.

Reaching the latest canonical page's bottom automatically returns to the live
suffix, including after an empty forward page confirms the tail. Reaching a
window edge with unread canonical pages still loads those pages first. Historical
reading does not follow live output. Newly streamed items continue the snapshot's
last presentation page so adjacent Tools group consistently before/after reload;
actual page boundaries and the 12-Tool group bound remain intact.

Consecutive retry notices share one row with all source cursors retained. Their
counter updates without appending another row. If prepending merges an older
retry into the group, restore reading by its retained cursor only when its exact
row key no longer exists; text fragments sharing a cursor still prefer their
own key. The toolbar controls only the default expansion of Tool groups. It
stays browser-local, applies to future groups and preserves the reading anchor,
individual Tool details/text choices and existing image presentation. It must
not add details wrappers or force full text expansion within individual Tools.

Prepending/eviction/resize preserve a message anchor and its viewport offset.
Only readers at the latest edge follow streaming output. History readers retain
their location and can return to the latest view. Direct navigation fetches the
target neighborhood, not all intervening pages. Normal scrolling operates on
the current window; do not construct an unbounded CSS-height container.

Navigation is bounded and paged too. Session-local search reads visible canonical
content in cancellable bounded batches; full-text search is not delegated to
browser Ctrl+F. Export streams completed canonical history through the server and
browser download path, without a client-side whole-conversation array/Blob.

History reads use a small disposable read pool with a per-query deadline and
request cancellation, separate from authority writes and queue observations.
Reuse the existing PostgreSQL adapter's cancellation behavior; do not make
ordinary mutation connections obey browser abort signals. An export holds a
connection only for one page, never while waiting for a slow download client.

## Adopt before build

Use pinned TanStack React Virtual (MIT) behind a PiCloud component. Its documented
chat/end anchoring, dynamic measurement and visible-range APIs fit existing React
presentation without adopting another chat state authority. Retain the existing
PostgreSQL cursor/index facilities and HTTP/SSE paths. A UI framework with its own
conversation store, a new broker or a full transcript mirror is unnecessary.

Primary evidence: [chat guide](https://tanstack.com/virtual/latest/docs/chat),
[package source](https://github.com/TanStack/virtual/tree/main/packages/react-virtual),
[license](https://github.com/TanStack/virtual/blob/main/LICENSE), and
[browser height limits](https://www.ag-grid.com/javascript-data-grid/massive-row-count/).

## Acceptance

Prove scoped forward/backward/around reads and correct Tool pairing at page
boundaries; one very large Run must never require a lifetime transcript read.
Measure SQL/body transfer, browser residency and mounted rows against at least
1 GiB of synthetic history. Test sustained browsing, direct jumps, pruning/forks,
streaming/reconnect/Stop, input drafts, delayed image sizing and cancelled requests.
Search/export must not reintroduce unbounded browser state. Run the complete
browser/API composition and PG/Kafka Projector contracts before matched publication, then owned real
Luna/Cube acceptance and asset/physical-resource reconciliation.
