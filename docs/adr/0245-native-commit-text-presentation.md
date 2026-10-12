# ADR-0245: Derive assistant text display from its native commit

Status: accepted for implementation, 2026-10-12. The owner approved proceeding
after discussing the public Storage.commit boundary. Implementation and matched
release are in progress; no deployed completion is claimed here.

## Behavior

Retain Pi's complete native Storage batch as the source of assistant text.
Remove the additional Kafka copy created solely for browser display. A native
publication carries bounded PiCloud display descriptions alongside its unchanged
native writes. Descriptions identify the destination message, phase and the text
already present in that same publication. Projector materializes the ordinary
PiCloud display event and sends it through the existing live view/SSE path.

For example, conceptually:

```text
One Kafka publication
  native writes: append "The issue is fixed" to the assistant text
  display description: show that native text in message A

Projector
  -> project native state/history under the existing transaction
  -> construct the browser event from the referenced text
```

This removes an extra *cloud display copy*. It does not strip Pi's own final
Assistant Entry because earlier native live deltas contain similar text.
Native publications, fingerprints and image encoding remain lossless.

Scope is assistant text, including commentary and final answers. It does not
merge all control, Tool, human-input or hosted-activity events. Existing small
events may continue to use their current path when they do not duplicate this
text. There is no second text publication mode after cutover.

## Current evidence

`DurableRunEvents.#text` currently turns committed Pi events into independent
`assistant.text.delta` publications containing the text again. The native view
listener runs after Storage adoption. A `message_end` or related native Entry
also drives the later `nativeSequence` display-coverage update.

The native publication path already supports atomic auxiliary information:
`PostgresDurableSessionHost` prepares a batch, `DurableSessionPublisher` packages
it, and the existing writer publishes one `durable_commit`. Tool dispatch uses
`taskId` to read arguments from the native intent in that very batch rather than
copy them into a second command body. This is the relevant existing pattern.

Pi's public event watcher is post-commit and can replace overflowed batches with
a snapshot. Waiting for that callback to complete the very Storage commit it
observes would deadlock. The new text preparation must therefore use the trusted
runner's prepared immutable native writes/current values, not wait for its own
post-adoption notification or re-enter Storage from its commit line.

## Ownership and wire representation

1. The trusted Worker interprets Pi documents/messages and decides which text is
   visible. It prepares a PiCloud-owned description before Kafka publication.
   Thinking blocks, partial Tool calls, provider-private fields and arbitrary
   document strings must not become text display merely because they are strings.
2. The description and source batch share one Kafka record and acknowledgement.
   A source selector addresses a literal in that record or the current native
   document produced by projecting that very commit, with a validated string
   range. Chord supports truncation and array moves that contain no new text
   literal; use the existing native live materialization for those changes.
   It may not request a separate Kafka fetch, PG query, object-store object or
   temporary result cache.
3. Projector resolves a generic PiCloud selector and builds the existing public
   display event. It does not import/run the Pi Harness or recreate Pi event-loop
   semantics. The browser never reads native document paths or raw Pi events.
4. Display preparation is speculative until ACK. Definite publication rejection
   must not advance its comparison state; uncertain ACK retains the existing
   poisoned-owner/ordered-closure behavior. The native batch remains unchanged.

The precise selector type must be exercised against real base, set and append
writes before freezing the protocol. Empty text/phase-only changes must not force
another full-text copy. If a new native write shape cannot be described safely,
fail preparation explicitly; do not silently re-enable standalone copied text.

## Ordering, identity and coverage

Native commit sequence, display sequence and Kafka offset keep their distinct
existing meanings. No second sequence allocator or durable authority is added.

Co-committing text means ordinary display events and native publications must
share the physical owner's publication ordering. In particular, allocating a
text event number before asynchronous image preparation must not let a later
ordinary event with a larger number enter Kafka first. Move/consolidate existing
stamping into the owner publication path where needed; remove the superseded
allocator rather than keep two counters synchronized.

Descriptions retain message/block identity, append-versus-replace behavior,
commentary/final phase and logical Session/Run provenance. All target Lanes must
belong to the same authorized physical writer. Parent and child Conversations
cannot inherit the publication anchor's display destination by accident.

Canonical coverage is established with the native Entry and its display
descriptions, not by assuming a later duplicate text callback will arrive.
Retain the existing watermark meaning for history/SSE merging. Any affected Run
updates follow the existing Run-before-lease-before-native lock order; never
acquire additional sibling Run locks after taking the shared lease lock.

Preserve overflow snapshots, empty/final-only answers, native retry, Stop,
interrupted partials and restored history. A recovered partial must not become
a second displayed answer, nor share an identity with a new model request just
because a provider timestamp was reused or a response ID was absent.

## Recovery and storage

References must be local to the complete Kafka publication and its native
projection at the same sequence. This deliberately
avoids retaining a separate queue of text references or every intermediate
materialized document merely to resolve later display messages.

Replay can reconstruct display from the native replay already required by
ADR-0244, without a Worker or another database round trip to fetch the text.
Covered canonical display is skipped before resolving older live references;
completed text refers directly to its Entry in the same record. Existing ownership,
canonical-coverage and dispatch boundaries still govern whether to expose it.
Replaying display never reissues a committed Tool command.

ADR-0244's PG/current-checkpoint and Kafka recovery-floor policies remain. Do
not restore PG streaming-body history or periodic full live checkpoints. Keep
ordinary native headers and required canonical Entry/Tool history.

## Reuse and alternatives

Reuse Pi's public Storage port, the existing prepared-publication/ACK boundary,
Kafka replication/order, the current single Projector, and the same-record Tool
intent reference pattern. The prior
[storage survey](../reports/append-only-storage-review-20261011.md) and ADR-0244
establish the retained infrastructure and its recovery boundaries. This change
is a bounded adapter to that stack, not a new event store or scheduler.

- Keeping copied display text and relying on compression retains the second
  semantic publication and its post-ACK gap; compression does not remove them.
- Publishing a later reference-only event saves some bytes but adds dependency
  retention, lookup and missing-reference behavior. Do not choose that layout.
- Running Pi event derivation in Projector moves the native runtime boundary into
  Control Plane. Keep Pi interpretation at the trusted Worker instead.
- A separate text blob store/cache would add another availability and cleanup
  dependency for data already durably present in the native commit.

## Implementation sequence and acceptance

1. Capture representative native base/delta/final batches and existing frontend
   output. Prove text selectors recover identical visible strings without
   modifying the native batch or copying its text into a second payload.
2. Add the trusted Worker preparation adapter with commit/rollback tests and
   consolidate publication ordering. Resolve descriptions in the existing
   Projector and retain the existing SSE text event. Add an optional settled
   message identity so completion moves an active text item to its canonical
   identity; a recovered native task can then begin a new response without
   reusing the previous visible bubble. This is a documented matched protocol change.
3. Remove the old assistant-text publication callback and unused text caches.
   Preserve required non-text events and explicitly verify canonical coverage.
4. Exercise actual Kafka replay, ownership changes and browser behavior, then
   perform the maintained matched rollout after the relevant checks pass.

Required checks:

- Compare same-workload Kafka record count and serialized bytes before/after.
  Confirm an unchanged native batch and no extra copied display text; do not
  claim that Pi itself never repeats text in its own native records.
- Append, replace, phase-only updates, Unicode, multiple text blocks, final-only
  output and absent/reused provider IDs/timestamps preserve displayed text.
- Concurrent ordinary events and delayed attachment preparation do not invert
  display sequence. Interleaved parent/child commits retain proper destinations.
- Rejected publication, lost ACK, Worker/Projector restart and Kafka duplicate
  replay preserve identities and text; no unsupported selector is ignored.
- Refresh/history merging, watcher overflow, Stop and interrupted output have
  neither duplicate text nor missing text. Completed history remains canonical.
- Native live-body PG rows and periodic snapshots remain zero during generation;
  image references and Tool dispatch/reply/cancellation behavior are unchanged.
- Real GPT-6 Luna streaming, browser reload, same-Run recovery, images and
  multi-Conversation acceptance pass, with owned fixture cleanup confirmed.

Use a matched private-wire cutover. Drain/fence writers and remove obsolete
development records only under the maintained lifecycle safeguards. Do not keep
a legacy reader, feature toggle or second copied-text publisher for compatibility.
