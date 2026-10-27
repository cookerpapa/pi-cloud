# Retry notices and global Tool disclosure

Status: source accepted; Web-only publication pending.

Consecutive increasing retry attempts render one row showing the latest attempt.
The first item's presentation key stays stable during live updates; native events
and history are retained. A reset attempt counter or intervening content starts a
separate notice. Historical reconstruction uses the same grouping, including page
boundaries. All source cursors remain navigable. Reading anchors prefer the exact
virtual row before falling back to a cursor retained by a merged retry group.
The concise attempt label is the same for live and historical presentation.

A single conversation-toolbar button expands/collapses Tool input and text results.
Until used, the existing previews/disclosure defaults remain. Explicit global mode
applies to newly displayed Tools and later history pages without loading all history.
Individual disclosures can override it; the next global toggle clears those local
overrides. The mode belongs to the current browser conversation view, not PG or
execution configuration. Generated/retained image previews remain visible outside
the Tool details. Large text retains its bounded rendering.

Validation covers retry attempts 2 → 3 → 4 updating the same DOM row, reconstruction
from a historical snapshot, counter resets, retained group cursors, one-button
disclosure through the actual ChatApp, individual overrides and a later live Tool
result. All 22 geometry scenarios pass, including global expansion while reading.
The 8 MiB real PG/API/SSE/browser composition passes bookmark, paging, image resize
and live-output reading-position checks. No model request or retry behavior changes.

The reviewed pure presentation helpers are added explicitly to ADR-0267's Web
scope. The existing matched-release script is classified as operator code so its
prior deployment-helper change does not force a backend rollout for this UI slice.
Public API, dependencies, provider and runtime source remain outside Web scope.

Private evidence:
`deploy/production/runtime/release-evidence/retry-tool-display-20261027/`.
