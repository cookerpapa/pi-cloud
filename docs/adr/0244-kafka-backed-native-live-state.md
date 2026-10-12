# ADR-0244: Keep native live progress in Kafka

Status: accepted and implemented in source, 2026-10-12, under schema 186.
[Verification and release status](../reports/native-live-state-20261012.md).
The owner approved the plan after discussing Pi 1.0 streaming persistence.
The matched release is pending. The deployed schema 185 behavior remains ADR-0243: native
`pi.live` changes still reach the PG journal and document revisions.

## Behavior and scope

Restore the pre-migration storage split while preserving Pi Durable semantics:
normal in-flight text lives durably in Kafka; completed or interrupted messages
live in PG. Pi still owns generation, abort settlement and continuation. The
cloud Storage adapter preserves Pi's complete current state and atomic commits.

Apply this retention policy to the complete conversation-scoped, current-only
`pi.live` document. Never strip its message fields, remove writes from a native
publication, or replace Pi recovery with concatenated browser text. Provider
text/thinking and all accompanying native fields remain intact in Kafka.
Incomplete Tool calls remain excluded at the Models port under ADR-0230.

| Data | Kafka | PostgreSQL |
| --- | --- | --- |
| Accepted native batches, including live deltas | Complete original batch | Existing small sequence/ID/fingerprint headers |
| In-flight `pi.live` body changes | Retained while needed for recovery | No per-change body or periodic 64-delta snapshot |
| Native settled live state | Complete original commit | One current checkpoint, replacing its predecessor |
| Live state needed for writer replacement | Original accepted commits | One exact handoff checkpoint before replacement is admitted |
| Completed/interrupted Assistant Entries and Tool Results | Existing native commit | Existing canonical history |
| Inbox/input/Submission values, Task checkpoints, other documents | Existing native commit | Existing policies, including ADR-0243 |

This slice removes PG streaming payload writes and their retained versions. It
does not promise zero SQL during generation: existing commit headers, integrity
metadata and authority checks remain. It introduces no new queue, service,
consumer group, execution lease, native sequence allocator or per-Step receipt.

Keep the current PiCloud display events/SSE protocol in this slice. They remain
derived presentation, not a recovery authority for native state. The existing
second Kafka representation of display text is not eliminated by this proposal;
merging that transport needs a separate trusted-runner/display-coverage change.

## Native and existing implementation evidence

Pinned Pi Durable 1.0.0 (`a13d35a`, MIT) defines `pi.live` with `history: latest`
and `fork: initial`. It checkpoints when there is no active generation and no
running Tool slot. Native partial commits are throttled, and leaf-wise updates
produce append operations instead of repeatedly assigning the whole message.
SQLite deletes superseded current-only revisions at a new base; JSONL reclaims
the document sidecar after committing its replacement base. Neither requires
permanent storage of all partial versions. See upstream
[LiveDoc](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/live.ts),
[generation](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/generation.ts),
[SQLite](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/storage/sqlite/storage.ts)
and [JSONL](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/storage/jsonl/storage.ts).

Current PiCloud code exposes necessary changes beyond omitting PG bodies:

- `PublishedDurableStorage.#flush()` discards its acknowledged overlay once PG
  reaches the commit sequence. This would lose live reads if PG lacks the body.
- Native projection returns early for an already-stored batch. A restarted
  Projector must still rebuild volatile live state from those Kafka records.
- Replay/retention currently uses PG partition progress and unsealed Run floors.
  A physical Session can publish different Conversations through one Run anchor;
  closing that anchor does not prove sibling live state is checkpointed.
- The ordinary projection boundary rejects closed Run/old-writer scopes. A
  protected recovery suffix can contain already-accepted writes from such an
  anchor; read-only reconstruction must distinguish them from a new mutation.

## Storage representation and read contract

Reuse `pi_durable_current` for each live document's last complete PG checkpoint.
Preserve document ID, scope, version, creation/retirement metadata, native source
sequence/ordinal, delta count and cloud provenance. Keep bodies as TEXT to retain
NUL and lone-surrogate behavior. A synthesized handoff checkpoint is a storage
representation of accepted writes; it does not allocate a native commit, reset
Pi's delta counter, append an Assistant Entry or invoke the Harness.

Add a bounded nullable replay reference to that existing row: Kafka topic,
partition, first required offset and its native sequence. Add a partial index
over outstanding topic/partition/offset references. No extra payload table is
needed. The reference means that the checkpoint is incomplete without that Kafka
suffix; it is not a lease or scheduling identity.

Install the reference on the first change not included in the PG checkpoint,
inside the existing native projection transaction. Subsequent deltas keep the
same reference. Clear it only in the same transaction that installs a complete
replacement checkpoint or completes a valid native retirement. Native history,
image retention, current input values and the existing commit header remain
transactionally consistent with these changes. A mixed batch must never lose
Entries, Task intents, Inbox edits or Tool dispatch because it also contains a
live delta.

Keep original full-batch fingerprints and retained-history counts/digests.
Extend the existing current-value integrity manifest to cover the expected live
state. While its replay reference is present, the PG checkpoint can be older
than that expected current value. After handoff/quiescence, its native position
and checksum must match. A missing body/reference is not an empty live document.
Document version changes and retirement/recreation must retain native semantics.

The Worker retains one materialized current live value per active Conversation,
separate from its ordinary acknowledged-but-not-yet-projected delta buffer.
It can discard covered deltas after folding them, but a generic PG-progress
flush must not discard the only current value. Reads after commit, explicit
flush, cache pressure and subsequent native transactions must see that value.
Settled document bodies can return to ordinary indexed PG reads once projected.

A cold Worker opens only after the existing ordered closure and full handoff
checkpoint. Cold reads must reject an outstanding replay reference rather than
silently return an older PG baseline. Administrative rebuild/export/fork retain
quiescence checks and also require complete live checkpoints. `fork: initial`
continues to produce fresh live state in the destination.

## Projector and replay

Within the existing partition owner, fold complete live documents using the
same native JSON delta semantics as the storage adapter. Run no Pi Harness,
model request, Tool or native recovery handler in the Control Plane. This is a
storage materialization view, not another Agent runtime.

Prepare a candidate memory value, validate/store the existing PG transaction,
and adopt the candidate only after success while ownership is still valid.
Transaction rollback must leave memory and replay references at the old point.
Displaced owners and replayed older checkpoints must not overwrite a newer
checkpoint or clear a newer replay reference.

On owner restart or rebalance, load the checkpoint metadata and include all
outstanding live references in the existing partition replay floor. Rebuild
memory from the checkpoint plus ordered native records, even when their PG
headers already exist. Validate replay fingerprints, skip document changes
already covered by the checkpoint, and never apply a delta twice. Do not treat
the Kafka group offset or PG header sequence as proof that memory is ready.

For an already-projected record from a closed anchor, validate its immutable
batch fingerprint and recorded acceptance/cutoff evidence before folding the
protected live suffix. Ordinary closed-scope rejection must not silently skip
that recovery input. This grants no new append/effect authority: records beyond
the cutoff, mismatched bytes and unaccepted old-writer data remain rejected.

Projection replay preserves the existing monotonic dispatch boundary. Rebuilding
a document never reissues committed shell work or claims a missing Tool reply
was successful. The newly assigned Projector must finish replay before serving
its live view or authorizing the next writer's cold open.

## Completion, Stop and writer handoff

At a native settled boundary, persist the latest small live state in
`pi_durable_current`, together with the batch's canonical Entries and other
writes. Remove superseded live payloads rather than leave them in the PG journal
or the generic 64-delta checkpoint index. A base still containing active
generation state is not permission to start periodic streaming snapshots.

Normal Stop runs Pi's existing abort transaction. Pi converts committed partials
to its native interrupted outcome and withdraws pending inputs; the cloud keeps
the same queue-return and Tool-cancellation behavior. Late Tool replies cannot
replace the native abort. The Projector never fabricates an interrupted Entry.

For abnormal physical-writer closure, first reconstruct all affected live
documents through the ordered seal position. Store their exact latest values
in the same guarded PG transaction as the closure that permits replacement.
Use the existing Run -> Session lease -> native Session lock order, without
acquiring sibling Run locks after the lease lock. A confirmed rollback preserves
the replay references. If COMMIT acknowledgement is uncertain, reconcile PG:
either the old references remain or the complete checkpoint and closure committed
together. No caller treats the lost acknowledgement as proof of either outcome;
replacement and reclamation require the durable completion evidence.

Checkpoint the physical Session's affected Conversations, not just the Run used
as a publication anchor. A normal individual Run seal must not clear a sibling's
live replay reference. Graceful final-owner release must also leave complete
PG state. The new Worker resumes via Pi's public Storage/Harness APIs and the
existing PG-issued lease; no new attempt or custom continuation scheduler exists.

## Retention and failure boundaries

Extend the existing replay-start and safe-delete calculations with the minimum
outstanding live replay reference, alongside unprojected progress and unsealed
Run floors. Capture broker bounds before the PG snapshot as today. Keep broker
automatic time/size expiration disabled and keep the existing retention grace.
Kafka consumption alone is not permission to delete recovery data.

Kafka's [topic retention configuration](https://kafka.apache.org/41/configuration/topic-configs/)
separates time/size deletion from compaction. Compaction of the current Session-keyed
topic would not preserve this native delta history. Retain the existing explicit
safe-prefix deletion through Kafka's own API; do not introduce a second compacted
topic, cache service or per-Conversation consumer.

| Failure or boundary | Required result |
| --- | --- |
| Worker loses Kafka ACK | Existing uncertain-owner closure; recover accepted writes without guessing whether they committed |
| PG projection fails | No adoption of candidate Projector memory; accepted Kafka data remains recoverable |
| Projector restarts after storing headers | Replay rebuilds live values despite PG duplicate detection |
| Worker and Projector both die | Replay baseline plus protected suffix, checkpoint at closure, then native Worker recovery |
| Child/anchor Run ends while a sibling streams | Its end cannot release the sibling's required prefix |
| Failure before handoff checkpoint commits | Old recovery references remain; replacement is not admitted |
| Failure after handoff commits | Duplicate seal/checkpoint is idempotent; cold PG state is sufficient |
| Required Kafka range is missing or bytes differ | Fail closed with a precise recovery error; never resume with an empty/older state |

A long generation can retain a shared partition prefix. This is an explicit
disk/replay tradeoff of keeping active progress in Kafka. Track the oldest
required reference, retained bytes, replay time and memory, using the existing
observability path. Memory pressure must not silently evict unrecoverable current
state or turn into periodic PG text dumps. Retain current backpressure/failure
semantics and measure any proposed additional bound before introducing it.

Retain image references from complete accepted native commits, regardless of
whether the corresponding live payload is materialized in PG. Checkpoint/seal
transactions must preserve those references. Clearing a replay reference alone
does not authorize deleting an image attachment.

## Adopt before build and alternatives

Reuse Pi's Storage contract and Chord delta implementation, Kafka replication
and deletion APIs, PostgreSQL transactions, and the current single Projector.
The [pinned storage survey](../reports/append-only-storage-review-20261011.md)
already compares native Pi, Maka, Marten, Pekko and Temporal. Keep their state
versus history distinction; adding a second event store or workflow owner would
duplicate existing execution and retention authorities rather than fill this gap.

The cheaper alternative is native-style temporary PG deltas with reclamation
at the next base. It solves long-term bloat but still writes streaming payloads
to PG. Overwriting one full PG live value on every partial also retains ongoing
WAL/TOAST work. This proposal accepts bounded adapter/replay changes to preserve
the owner's Kafka-only normal streaming policy. Copying SQLite files to Workers
would add a second recovery head and is not selected.

## Implementation sequence and acceptance

1. Record approval and add a focused failure fixture before changing retention.
   Reproduce present PG live-body growth and forced-overlay-flush behavior.
2. Generalize the existing current-state helper with an explicit `pi.live`
   policy; add replay references/checkpoint integrity, Worker current reads,
   Projector folding and replay. Preserve complete native publication bytes.
3. Connect checkpoint completion to writer handoff, replay/retention floors,
   quiescent rebuild/export and conservative attachment retention. Keep the
   change behind the matched schema/application cutover, not a runtime fallback.
4. Run native contract, real PG/Kafka, fault and live Luna acceptance below.
   Update architecture/AGENTS/reading guidance to implemented behavior only
   after the source and release status justify it.
5. Perform the maintained matched deployment after implementation approval and
   passing checks. This proposal itself changes no runtime or deployment.

Acceptance must demonstrate:

- Thousands of controlled native partial changes produce no PG live-delta body
  rows or 64-delta payload snapshots during generation. Current reads stay exact
  before/after buffer flush. Normal completion leaves the canonical answer and
  the latest small live checkpoint, not intermediate versions.
- Native contract checks preserve sequence, version, delta counter, identity,
  retirement/recreation, JSON edge cases, and read-after-write behavior. A cold
  adapter cannot pretend an incomplete baseline satisfies the current read.
- Mixed Entry/Task/Inbox/live commits remain atomic at the public Storage port;
  projection rollback changes neither memory nor durable replay references.
- Duplicate and conflicting replay, ACK loss, seal races, owner displacement,
  both-process crashes, and crashes on both sides of checkpoint commit preserve
  exact recovered content and do not allocate a second native sequence.
- Parent/child Conversations interleave writes under one physical writer.
  Closing/changing the publication anchor, promoting inputs or completing one
  Run never permits the retention reaper to delete another's required suffix.
- Stop preserves its native partial outcome, pending input text/images and
  returned-input identity. An interrupted unsafe Tool is not replayed; late
  replies cannot overwrite the native outcome.
- Index rebuild and PG/attachment recovery work after safe Kafka cleanup at
  quiescence. Missing/changed checkpoints, manifests or required Kafka ranges
  fail explicitly. Replaying for display/state reconstruction dispatches no Tool.
- Compare PG body rows/bytes, actual SQL count, WAL volume, memory and recovery
  time against the same synthetic baseline. Report remaining header writes and
  Kafka display duplication; do not claim zero SQL or an unmeasured speedup.
- Finish repository/transport/fault gates and real GPT-6 Luna text, Stop,
  Worker/Control Plane restart, multi-Conversation and image acceptance. Clean
  owned fixtures with the existing writer/physical-resource safeguards.

## Matched development cutover

Schema 186 supplies the checkpoint replay references and partial indexes. Drain writers, finish
old-format projection/seals and verify resource cleanup before removing obsolete
development data or ownership. Preserve accounts, model/provider configuration
and credentials. Remove superseded live-persistence code rather than retaining
a selectable old backend. Any rollback is a drained matched release; do not
claim the old application can read new current-only live storage unchanged.
