# Peer Fork navigation and independent deletion

Implementation: [ADR-0288](../adr/0288-peer-forks-and-independent-deletion.md),
schema 205. Source and browser checks pass; matched publication and live checks
are pending.

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
