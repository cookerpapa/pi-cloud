# ADR-0288: Peer Forks and independent conversation deletion

Status: implemented and deployed as `peer-forks-20261030`, schema 205 / Helm 127.
[Verification and delivery](../reports/peer-forks-20261030.md), 2026-10-30.

## Decision

A manual Fork is an independent human conversation. The ordinary sidebar lists
all human conversations at the same level in the existing recency order. Only
native delegated Agents are nested under their owning conversation. The separate
history navigator may continue showing provenance as a branch tree.

Deleting a human conversation deletes that physical Session's delegated views
and native owner after existing quiescence, lease and seal checks. It does not
traverse manual-Fork provenance. An active independent Fork neither prevents
source deletion nor loses its writer, history, images or Workspace binding.
Workspace deletion remains a separate explicit operation.

The existing source Session/Turn/Entry addresses remain provenance even when
the source is deleted. Schema 205 removes the source-Session foreign keys from
`sessions` and `conversation_fork_operations`. The Fork operation's destination
foreign key still owns its receipt, so retrying an accepted Fork can return the
surviving destination after source deletion. Creation still checks and key-locks
the source in its transaction; dropping the provenance FK does not remove that
admission ordering. Surviving Forks are not reparented to a different source.

Shared native/presentation roots from ADR-0287 remain the sole retention owners.
No extra history copy, archive, tombstone Session or reference-count service is
introduced. Existing graph collection, physical cleanup and writer fencing stay
authoritative. Historical source addresses do not authorize runtime access.

## Public presentation

Ordinary conversation summaries no longer expose `parentSessionId`. Conversation
details expose a bounded `forkSource` containing the source Session/Turn/Entry
addresses and its current title, or a null title when the source is unavailable.
The UI offers a source link while it exists and a concise deleted-source label
otherwise. Navigation uses existing APIs, resolves delegated-source read-only
state, and falls back to opening the source when the original point is gone.
History-tree edges and delegated-parent fields keep their existing meaning.
No model-visible Fork notice is added.

## Acceptance and release

Verify source deletion with idle and active Forks, nested Forks, source Agents
with actual children, Forks made from those children, source admission/deletion
races, retry receipts, and retained content/image access followed by collection.
Keep runtime-family deletion protection; remove tests that assert manual-Fork
cascade semantics. Browser acceptance must verify flat human rows, nested real
children, source navigation and deleted-source presentation.

Use a matched schema/API/Web release, preserve existing assets, and exercise
owned live Fork continuation while deleting its source. Update the README's
obsolete prototype-only status to match the deployed shared-history architecture.
