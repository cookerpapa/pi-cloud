# Peer Fork navigation and independent deletion

Implementation: [ADR-0288](../adr/0288-peer-forks-and-independent-deletion.md),
schema 205. Matched `peer-forks-20261030` is deployed from `5981c10c`, application
Helm revision 127. Source, browser and real Luna/Cube checks pass.

Manual Forks are ordinary conversation-list peers in the existing recency order.
Real delegated Agents remain nested. The title has a small source link, including
read-only navigation to delegated sources. An unavailable source is labelled as
deleted; a removed source point falls back to the source's current conversation.
The separate history-tree view keeps provenance edges.

Deletion selects only the chosen physical Session family and retains all existing
activity, lease and seal checks. It no longer traverses manual-Fork provenance.
The source Session FKs are removed from the provenance fields and Fork receipts;
the destination still owns the receipt. Source admission retains its explicit
key lock. No source tombstone, extra log copy, or model-visible notice is added.
An accepted Fork can be replayed idempotently after source deletion.

Ordinary summaries no longer return `parentSessionId`. Details expose
`forkSource: { sessionId, turnId, entryId, title }`, with null `title` for an
unavailable source. This requires the matched API/Web cutover. Existing open
browser tabs need a reload; no compatibility response or refresh-notification
feature is introduced.

## Source verification

- 66 PostgreSQL/native storage checks pass across migration, admission/deletion
  races, active/nested Fork retention, real child ownership, retry receipts,
  source retirement, retained images and final graph collection.
- 220 Web tests and 164 protocol tests pass. Full workspace typecheck and build pass.
- Dedicated browser cases pass for ordinary and delegated sources, equal-level
  human rows, nested children, source-point fallback, independent deletion,
  deleted-source presentation and desktop/mobile width.
- Full browser presentation acceptance passes. An earlier run stopped during
  fixture initialization; the test server now matches the fixture pathname even
  when navigation/reload includes query parameters. The subsequent complete run
  passes; this is a test-entry correction, not a product retry workaround.

The real Fork acceptance driver is extended to delete its source while the Fork
executes a Cube Tool, then verify the remembered context and images, compaction,
source-link fallback, flat sidebar and deleted-source label. Cleanup explicitly
removes every independent fixture conversation before deleting its Workspace.

Private source evidence:
`deploy/production/runtime/work-evidence/peer-forks-20261030/`.

## Matched delivery

All 12 matched image gates pass. The original allocation was closed and confirmed
physically absent before replacement; the same development machine/Workspace
recovered as generation 30. All 29 runtime Pods are Ready. Fourteen protected
database tables/views, 68 image contents, 5,859 Workspace files and 27 private
configuration/credential hashes match the captured values. No business-data reset
was performed.

Real GPT-6 Luna created an independent Fork while the source ran, retained C when
the source was pruned to B, and navigated the peer sidebar/source link in the real
browser. While the Fork executed another Cube Tool, the source was deleted. The
Fork completed normally, recalled C and served its retained image. Compaction and
cold continuation still recalled C; the browser showed the deleted-source label.
The default Fork identity notice remains absent and backend provenance is retained.
The owned fixture's Runs, compute, Workspace and tenant were cleaned successfully.

Private release evidence:
`deploy/production/runtime/release-evidence/peer-forks-20261030/live-fork/report.json`
and the adjacent `maintenance/` preservation/image/state reports. Existing browser
tabs should reload for the paired API/Web contract.
