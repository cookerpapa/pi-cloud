# ADR-0257: Browser observation generations and bounded pending delivery

Status: proposed, 2026-10-18. The owner requested a repair plan for the
[Projector/browser review](../reports/projector-browser-review-20261018.md).
Implementation and deployment have not started. This proposal refines the
review's initial resync-first suggestion after checking the recovery transaction.

## Scope and existing mechanisms

Keep the assigned Session Projector, PG canonical history, Kafka native progress,
the existing SSE connection and replacement-snapshot recovery. This slice repairs
PBR-01/02/03 and PBR-O1. It adds no database table, durable heartbeat, queue service,
execution authority or Pi Harness patch.

PG already increments `pi_sessions.lease_epoch` when issuing the next Session
lease; the lease's `fencing_token` is that epoch. It is present in the trusted
Worker activity scope and Projector execution scope. Reuse that number for
observation identity instead of creating a second counter or querying PG per frame.
Existing SSE/backpressure and pinned incremental JSON framing remain sufficient;
this is a bounded change to their adapters, not a new streaming protocol stack.

## B1: Carry the existing execution generation through disposable observations

Add a required `generation` field to PiCloud's public `run.activity`, `run.path`
and `run.execution` schemas. Projector derives it from the already-admitted
`scope.fencingToken`. The Worker-to-Control-Plane scope already carries that value.
This public field identifies observations; it does not grant execution permission
or renew a lease. It stays outside native history, Kafka display sequence and PG.

For each active Turn, both the open SSE view and browser observation store apply
the following rule after their existing scope/freshness/eligibility checks:

| Incoming observation | Handling |
| --- | --- |
| Same generation | Apply existing per-type revision/time checks. |
| Higher generation | Clear all old activity/path/execution state and revision baselines, then accept the new observation. |
| Lower generation | Discard it even if its revision or timestamp is larger. |
| Terminal Turn | Never reopen it through an observation. |

Reset the complete observation bundle together, including retained Tool-activity
age, so a new path confirmation cannot coexist with an old VM confirmation.
Apply the same rule to queued/coalesced observations; an older generation must
not overwrite a pending newer one. Root and child Conversations reuse the same
physical writer generation while keeping their own Turn/state views.

Projector reassignment already resyncs subscriptions. Any other nonterminal
eviction of same-writer observation state that resets its local execution counter
(TTL/capacity cleanup) must also invalidate the affected SSE observation view
through the existing resync path. It must not invent a higher lease generation.
Test that cache lifetime separately from actual Worker replacement.

### Why not force a whole transcript refresh at every writer seal?

The recoverable seal transaction sets the Run back to `queued`, clears its lease
and reopens readiness. The current conversation reader excludes queued rows.
Immediate resync at that point would couple a status fix to the transient history
view and continuation timing. A generation on the existing observation frames
fixes both filtering layers while the transcript stream stays open. Overflow,
ownership changes and ordinary network disconnects continue to use snapshots.

This is a matched public observation-schema change: update producer, SSE parser,
browser store, fixtures and documentation together. Do not add an optional-field
fallback or an old-frame decoder. PG schema, Kafka topic/native wire and guest
protocol remain unchanged. Open browser pages reload at matched deployment.

## B2: Account for slow-reader bytes in the existing subscription

Keep the 1,024-event count guard and add a proposed initial **16 MiB encoded-byte
budget per subscription's pending formal events**. This is a disposable backlog
budget, not an output/file-size or Session-count quota. It is not a total-process
heap bound: event bodies may be shared, and each socket/snapshot has separate
in-flight memory. Validate the value with the mixed-size slow-reader fixture.

Measure an immutable event once when broadcasting, using the existing bounded
JSON encoder or equivalent bounded byte counting; do not create one full extra
serialized copy per subscriber. Keep the estimate with the pending wake and
release it on dequeue, resync, overflow and close. With no subscribers, perform
no measurement. Any cached estimate must not retain already-released events.

When either pending budget would be exceeded, clear disposable pending data and
use the existing resync marker/connection close. Kafka projection, PG history and
other subscribers continue independently. The browser reconnects and receives
the canonical-plus-live replacement snapshot. Preserve the 30-second blocked
write deadline and existing client reconnect backoff.

Keep complete values atomic. The item currently being sent follows the existing
bounded framing/socket path; the budget concerns additional queued events. A
large snapshot is not rejected because its total size exceeds the pending-event
budget. Verify that a single oversized pending event is recoverable through the
snapshot path instead of causing a deterministic reject/reconnect loop. Limits
on actual retained text and native execution facts remain their existing concerns.

## B3: Compact same-message commentary and remove obsolete guidance

Permit adjacent commentary appends to merge when they have the same explicit,
nonempty message ID, phase and Turn/Session, with consecutive sequence positions.
Retain the replacement, settlement/rename, different-message and phase-change
boundaries. Distinct commentary events without message identity remain distinct.
Do not change native batches or the original events delivered to live subscribers.

Remove the obsolete 25 ms public-text coalescing claim from ARCHITECTURE and
STREAM_DURABILITY. Document native partial-write coalescing, recovery-only span
compaction and browser animation as separate mechanisms. Update CONFIGURATION
for the pending-byte guard and the public observation contract for `generation`.
The historical complete-commentary ADR remains historical evidence.

## Implementation sequence and acceptance

1. **B1 / PBR-01:** implement required observation generation from admitted scope,
   server/browser/coalescing comparison and nonterminal cache-lifetime handling.
   Tests retain one open connection across old revision 100 → new-generation
   revision 1, reject late old frames, clear old VM/path evidence, cover children,
   reconnect/reset and ensure terminal state wins. No per-frame SQL is added.
2. **B2 / PBR-02:** add byte accounting and centralize pending-queue cleanup.
   Test exact limit/overflow, periodic socket drains below the timeout, one large
   event, snapshots above the budget, released counters, a healthy second reader
   and unchanged recovered content. Check counting cost with varied payloads.
3. **B3 / PBR-O1/03:** compact commentary by identity; test phase/replacement/
   canonical-rename/coverage boundaries and live-versus-refresh equality. Rewrite
   maintained guidance. Replace defect characterizations with maintained
   desired-behavior regressions; retain the review's evidence in Git.
4. **B4 / delivery:** required source/fault/transport and real-browser gates,
   then the maintained scanned, drained matched deployment. Extend the existing
   owned native-input/recovery fixture to keep an SSE/browser observation open
   through Worker-only replacement while Control Plane remains alive. Check
   new-generation activity and execution evidence without manual refresh.
   Retain relevant Luna/Cube/child/image/Stop/reconnect acceptance and normal
   physical fixture cleanup; preserve accounts, model/provider configuration
   and credentials.

The new regression must exercise the whole observation chain, not merely a
standalone numeric comparison. The slow-reader test must exercise the subscription
and send loop, not only a byte counter. Review results are not rollout evidence;
record implemented source, actual artifacts and live acceptance separately.
