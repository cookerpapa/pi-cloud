# ADR-0243: Native input current state

Status: accepted for implementation, 2026-10-12. The owner approved this slice
after comparing Pi Durable's Inbox contract with the previous full-write journal.

## Decision

Pi Durable 1.0 remains the only input queue owner. `Conversation.submit`,
`Conversation.commit`, native submissions and `pi.inbox` retain their admission,
ordering, editing, consumption and abort semantics. One physical Session writer
publishes complete native batches through the existing ingress and RF3 Kafka.
Only the Kafka acknowledgement admits a batch into Pi's committed memory state.

PostgreSQL stores all native Submission records as current values. It also
stores the conversation-scoped `history: latest` documents `pi.inbox` and
`pi-cloud.human-inputs` as current values. Their bodies are absent from the
long-term native journal and document-revision index. The current value retains
native identity, creation/retirement metadata, format version, delta count and
cloud provenance. Materialization does not reset Pi's logical delta counter.
Native JSON remains TEXT so NUL and lone-surrogate values survive unchanged.

Entries and every other native write retain their existing historical policy.
In particular this slice does not implement the separately discussed streaming
`pi.live` Kafka-only policy, nor reclaim Task checkpoints or rewindable documents.
The common current-state storage is a backend facility, not a second cloud queue,
scheduler, input payload outbox or direct API writer.

The Projector applies current-state replacements, retained journal writes,
indexes, image retention and the batch receipt in one PG transaction. Thus
consumption's Inbox removal, Submission placement and user Entry are atomic.
Stable request and mutation identities continue to settle retries. An individual
cancel clears unused text/upload metadata through the same native transaction;
minimal identity/receipt state survives. Stop-return content and consumed-message
presentation data retain their existing lifetime and repeated-read semantics.
Image references remain conservative at Session scope: this slice never infers
that removing one queued reference permits deleting a shared attachment.

## Recovery and integrity

`pi_durable_current` is durable recovery data, not a disposable projection.
`pi_durable_records` remains a rebuildable index over retained history and current
state. Its body resolver reads exactly one of those authorities for each record.
Rebuild never removes current state and never dispatches Tools. Commit receipts
keep the original batch fingerprint for replay conflict checks, a checksum/count
of retained historical writes, and small checksums identifying current-state
updates. Rebuild validates the retained journal and the latest required current
values; missing state must fail rather than be interpreted as an empty Inbox.

Worker replacement still waits for ordered old-writer closure and PG projection.
It then loads current Inbox/Submission values without replaying old edits.
Kafka retains complete batches until the existing projection/unsealed-prefix
retention boundary permits deletion. This removes permanent PG edit history,
not the bounded recovery journal or PostgreSQL's own WAL/MVCC versions.

Exports and asset recovery must include current state. History-only export
cannot recover unconsumed input. The matched development migration requires an
empty native commit store after writer drain; obsolete development conversation
data may be removed through the existing cleanup boundaries. Accounts, model and
provider configuration, credentials and physical-resource ownership are preserved.
No legacy runtime reader or dual-write compatibility mode is retained.

## Adopt before build

Pinned Pi `a13d35a` defines Inbox as `history: latest, fork: initial`; its SQLite
backend updates Submission rows and reclaims superseded current-only document
bases. The public Storage API requires atomic commits and correct current reads,
not permanent retention of every intermediate value. Maka's `fa26868` uses a
mutable admission table plus immutable execution facts. Reuse Pi's queue and
transactions instead of adopting Maka's separate admission owner. Evidence is in
the [storage review](../reports/append-only-storage-review-20261011.md) and the
official [Inbox](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/inbox.ts)
and [SQLite backend](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/storage/sqlite/storage.ts).

## Acceptance

Run upstream Storage conformance in acknowledged-overlay and cold PG modes.
Exercise repeated input edits, promotion, reorder, cancellation, native consumption,
lost acknowledgements, duplicate/changed replay, projection rollback and Worker
reopen. Verify one logical current body per input document/Submission, no historical
queue bodies/checkpoints, and unchanged final messages. Delete/rebuild indexes and
compare state; inject missing/changed journal/current data and require rejection.
Cover Stop/return, original text, images, fork behavior and asset export/restore.
Complete repository checks and a matched schema/application release with real Luna
native-input, interruption/recovery and browser/attachment acceptance.
