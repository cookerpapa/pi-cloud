# Streaming durability and crash matrix

PiCloud separates incomplete presentation fragments from canonical conversation
state:

- `K` — Kafka acknowledged an AcceptedFact with `acks=all`;
- `V` — a browser observed that Fact through Gateway SSE;
- `P` — the canonical projector committed a complete Pi mutation in PostgreSQL;
- `T` — PostgreSQL settled the business Run and requested a seal through its Outbox;
- `C` — the canonical consumer projected that seal, preserved the interrupted prefix
  and atomically committed the public terminal and closed RunAttempt;
- `S` — Gateway sent a replacement snapshot containing PostgreSQL canonical
  messages plus the current incomplete Kafka tail.

The maintained invariants are:

```text
V implies K
T(success) implies P
next Run claim implies C(previous requested seals)
record after an execution's first seal cannot change Pi context or live output
the next model Step waits for its required P projection barrier
an arbitrary Tool effect implies P(complete model output) and P(validated Tool intent)
S contains no browser-supplied cursor
arbitrary Tool effects are never inferred from K, V or an interrupted text prefix
```

Kafka is a bounded recovery log, not the lifetime transcript. AcceptedFacts are
keyed by opaque Session ID, so one Session remains in one Kafka partition.
PostgreSQL stores complete Pi-native semantic state once. Gateway replicas consume
only subscribed Kafka partitions into rebuildable memory.

A lease check cannot be atomic with Kafka append. Closure therefore happens in
the log itself: the first execution seal divides accepted old records from late
records that cannot affect canonical or live state. The seal is published by the
trusted terminal Outbox even when its Worker is dead. It names an exact Attempt,
not every future Run or every Lane. Both paths use the durable first-seal position on
restart; valid pre-seal records remain valid even when PG is ahead of a live reader; no lease-expiry inference or browser acknowledgement is required.

The first Assistant text delta is published immediately; adjacent deltas in
the same content block coalesce for up to 25ms. Semantic boundaries flush that
buffer. Kafka's producer additionally batches network records without changing
Fact identity. Every published fragment requires Kafka `acks=all`
before Gateway can expose it. The browser progressively reveals an already
durable fragment for visual smoothness; that presentation does not create a
second server-side event stream. Streamed Tool arguments remain private to Pi;
one argument-free preparation Fact makes that interval visible and is replaced
by the complete Tool start boundary. It is live-only and is not copied into the
settled PostgreSQL transcript.

At the end of a model sampling step, the complete Assistant Entry, usage Record
and reviewed `model.sampling.completed` event are one AcceptedFact. After Pi
validates the selected Tool and its arguments, the `tool_started` intent Record
and reviewed `tool.started` event are a second AcceptedFact. Each Fact gets one
Kafka `acks=all` receipt and one idempotent PostgreSQL Session projection; only
then may the Tool execute. These two barriers cannot be collapsed because an
execution intent does not exist until Pi validation succeeds. Independent
message, usage, lifecycle-event and intent barriers are deliberately avoided.
The successful projection receipt commits with its Session mutation. Workers
publish first, then read receipts when the shared LISTEN connection reports a
committed mutation ID. A shared one-second fallback reads all pending IDs if
notifications are lost; neither a notification nor a transport ACK substitutes
for the committed receipt. Queue admission and receipt notifications reuse one
dedicated PostgreSQL connection per Worker.

## Cursor-free browser handoff

The browser opens one SSE request without `Last-Event-ID` or a query watermark.
Opening an existing conversation does not first download the same REST history.
Changing language or tree focus leaves this subscription intact.
Gateway retains the target partition and waits for its bounded replay, then
subscribes to live wakes and reads canonical history and its boundary under one
repeatable-read transaction, then takes an immutable live-tail snapshot. It
retries if terminal eviction overtook that database snapshot. No database
transaction remains open during network writes. Its first frame replaces the browser view:

```text
event: session.snapshot
data: PostgreSQL conversation + materialized incomplete live events
```

Subsequent frames carry new accepted events. On refresh or disconnect the browser
opens the same endpoint and replaces its view from another snapshot. Recovered
text is rendered immediately; only later deltas use progressive reveal.

The settlement transaction requests an execution seal through the terminal Outbox.
The canonical consumer commits interrupted text, the exact terminal sequence and
Attempt closure before Gateway publishes that terminal event to
already-open subscribers, then advances the canonical boundary and removes the
covered tail by pointer replacement. Existing responses retain their immutable
snapshot references; slow clients have bounded queues and reconnect instead of
pinning shared memory.
Heartbeats reuse the outstanding event read, so idle periods do not create
another reader or force a reconnect. Consumers run partitions concurrently with
bounded pending work; handlers and offset commits remain ordered within each
partition. The live-tail ordered path appends directly and uses a sequence index
for duplicate/conflict lookup; out-of-order arrivals use ordered insertion.

## Failure matrix

| Crash boundary | Visible result | Recovery rule |
| --- | --- | --- |
| before `K` | Fact was never shown | producer may retry the same stable Fact ID |
| after `K`, before `V` | Fact may be unseen | Gateway consumer resumes from Kafka; reconnect receives a replacement snapshot |
| after `V`, before complete `P` | visible prefix remains in Kafka | interruption projection records the bounded prefix and abort fact in Pi context |
| after complete model `P`, before intent `P` | complete Tool call is canonical but no effect was admitted | recover as interrupted without marking that Tool effect `UNKNOWN` |
| after intent `P`, before a durable Tool result | the specific Tool may have started | recover that Tool as `UNKNOWN`; later Tool calls in the same Assistant message remain unstarted |
| complete `P`, before `T` | complete Pi message exists, Run is not terminal | stable mutation ID makes projection redelivery idempotent; terminal settlement retries under current authority |
| after `T`, before seal append/projection | next Run remains queued | Outbox retries the stable seal; no context handoff until `C` |
| old record before seal | it belongs to the closing execution | apply it before `C` |
| old record after seal | it may remain in bounded Kafka history | neither PG lane nor SSE accepts it |
| seal commit succeeded, ACK lost | closed execution stays closed | duplicate seal is a no-op |
| `C` completed, queued successor starts | predecessor context includes its preserved prefix | old records cannot subsequently rewrite it |
| canonical projector loss | volatile prefix is lost, canonical entries are not | seek to the minimum durable partition checkpoint/unsealed start; rebuild open prefixes and deduplicate already projected outcomes |
| Gateway loss | no canonical loss | replacement Gateway rebuilds its soft tail from Kafka and PostgreSQL |
| browser loss | no server-side acknowledgement is needed | reconnect receives `S`; no browser cursor survives |
| Worker loss during arbitrary Tool work | outcome may be unknown | revoke authority, record `UNKNOWN`, never auto-run the Tool again |
| Cube loss | process/memory state is gone | persistent Workspace Volume keeps files; the next model sees a minimal reset fact |

Kafka retention must exceed maximum Turn time plus settlement/recovery grace.
RunAttempt rows retain first/seal/projected Kafka coordinates; partition checkpoints
advance with semantic/seal transactions, never token fragments; none enter
the browser API. If an unsealed Run is older than the configured retention window
or replay is missing its recorded first offset, recovery stops for operator action.
Finite retention is not a promise of recovery after an unlimited outage.
