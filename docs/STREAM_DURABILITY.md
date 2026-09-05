# Streaming durability and crash matrix

PiCloud separates incomplete presentation fragments from canonical conversation
state:

- `K` — Kafka acknowledged an AcceptedFact with `acks=all`;
- `V` — a browser observed that Fact through Gateway SSE;
- `P` — the canonical projector committed a complete Pi mutation in PostgreSQL;
- `T` — PostgreSQL committed terminal Run state and its terminal outbox Fact;
- `S` — Gateway sent a replacement snapshot containing PostgreSQL canonical
  messages plus the current incomplete Kafka tail.

The maintained invariants are:

```text
V implies K
T(success) implies P
the next model Step waits for its required P projection barrier
an arbitrary Tool effect implies P(complete model output) and P(validated Tool intent)
S contains no browser-supplied cursor
arbitrary Tool effects are never inferred from K, V or an interrupted text prefix
```

Kafka is a bounded recovery log, not the lifetime transcript. AcceptedFacts are
keyed by opaque Session ID, so one Session remains in one Kafka partition.
PostgreSQL stores complete Pi-native semantic state once. Gateway replicas consume
Kafka into rebuildable memory containing incomplete active Turns only.

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
Gateway subscribes first, reads canonical history and its boundary under one
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

Terminal Facts are created by the PostgreSQL settlement transaction and reach
Kafka through the terminal outbox. Gateway publishes that terminal event to
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
| after `T`, before terminal Kafka append | canonical result is complete | PostgreSQL terminal outbox retries the same terminal Fact |
| canonical projector loss | Kafka group offset does not advance | replacement consumer reapplies idempotently and commits the offset |
| Gateway loss | no canonical loss | replacement Gateway rebuilds its soft tail from Kafka and PostgreSQL |
| browser loss | no server-side acknowledgement is needed | reconnect receives `S`; no browser cursor survives |
| Worker loss during arbitrary Tool work | outcome may be unknown | revoke authority, record `UNKNOWN`, never auto-run the Tool again |
| Cube loss | process/memory state is gone | persistent Workspace Volume keeps files; the next model sees a minimal reset fact |

Kafka retention must exceed maximum Turn time plus settlement/recovery grace.
PostgreSQL Session heads record the terminal Kafka partition/offset for audit and
bounded recovery; those coordinates are internal and never enter the browser API.
