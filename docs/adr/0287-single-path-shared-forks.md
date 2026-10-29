# ADR-0287: Single-path Forks with explicit runtime identity

Status: accepted for implementation, 2026-10-29. Implementation and rollout are
in progress; ADR-0284/0285 remain the deployed storage representation until the
matched transition is verified.

## Product boundary

The owner chose a single executable path. A manual Fork retains the selected
Agent's visible history through the chosen point, including required native
ancestor context and child results already delivered to that path. It does not
retain sibling/descendant transcripts merely because they share a physical
Session, and does not copy their Tasks, queues, live runtime identities or grants.
A selected child becomes an independent product conversation. New delegation
uses newly created children in the new physical Session family.

Original Agents keep running in the original Session. Their later messages and
results do not flow into the Fork. Deleting the original may remove side histories
that were never part of the selected path. Main-path messages, returned results
and their retained images remain independently owned. Workspace bytes are not
copied or rolled back by Fork.

## Model-visible identity

Persist a small, immutable Fork provenance snapshot in the destination's native
Session metadata in the same cold transaction that creates it. This is code-owned
data, not a user prompt or executable child state. Session metadata is not imported
by manual Fork. A subsequent manual Fork receives a fresh value. Cold pruning of
the same physical family preserves this metadata. Newly created native children
can see the family's historical boundary without being described as root Agents.

The trusted Runner renders a public Pi system section from that snapshot. The
section identifies the current conversation, the forked family and source boundary, and explains that
old subagent IDs are historical and were not imported as runtimes. It does not
promise a separate historical-child query capability. Pi compares sections and
persists `pi.system` through the existing Storage/Kafka/Projector path before model
sampling; unchanged text is not repeatedly appended. Native compaction may rebuild
the system baseline. These entries are not normal chat bubbles. No Pi core patch
or separate notification transport is introduced.

## Storage correction and migration

ADR-0286's read-only experiment proved that sharing immutable references can avoid
body-volume-dependent Fork work. It did not prove full native Storage semantics.
Normal Session commits serialize callback, ID allocation and Storage settlement;
the artificially reversed cross-commit experiment is not an observed production
Agent-loop failure. The official Storage suite nevertheless requires correctly
indexing a batch presented out of ID order. Preserve native IDs, publication
positions and document-version semantics without inventing a second writer or
equating ID allocation order with durable publication in every Storage call.

Continue the implementation as complete vertical slices:

1. Codify single-path inheritance, old-agent lookup behavior and native Fork
   context rendering, including second Fork, compaction and cold reopen.
2. Replace the body-volume-dependent import with an explicit shared history base
   plus local commits. Keep original Kafka commit fingerprints, fencing and current
   Inbox/Submission/pi.live policies. Full official Storage conformance, document
   `asOf`/`current`/`initial`, child-family behavior and cold rebuild are gates.
3. Use a common retained-history view for native context and product pagination,
   navigation, usage/search/export. Snapshot references must not depend on a live
   source product Session. Preserve only the selected path, not the whole physical
   log prefix. Images remain in existing S3 storage with actual retention edges.
4. Verify concurrent Fork/prune/delete/collection and ordered recovery. A source
   retirement cannot delete referenced history or let old Kafka replay revive it.
   Replace obsolete copying paths after validated conversion, without permanent
   dual writes or compatibility fallbacks.

Git/Temporal/Dolt/PG adoption evidence remains in ADR-0285/0286. Use PG transactions,
indexes and reference constraints rather than adding an event store or scheduler.

## Acceptance

Correctness and ownership are hard gates. Performance combines body/row/SQL counts,
absolute latency, throughput and WAL. The earlier 10% threshold remains a warning
for ordinary write/load regressions, not proof that an extra few milliseconds of
read latency is unacceptable. Report the complete API and cold-first-request
results separately from directory-only timings. Target subsecond 1 GiB Fork
admission with small inherited state; measure nested history and normal load.

Preserve existing conversations, images, accounts/configuration and Workspaces.
Use the maintained matched release, original-asset verification and owned Luna,
Cube/browser and native recovery acceptance once the complete slice passes. Push
each completed commit as already authorized. No rollout of an incomplete storage
prototype is authorized by this ADR.
