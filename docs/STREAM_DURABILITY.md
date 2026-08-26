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
S contains no browser-supplied cursor
arbitrary Tool effects are never inferred from K, V or an interrupted text prefix
```

Kafka is a bounded recovery log, not the lifetime transcript. AcceptedFacts are
keyed by opaque Session ID, so one Session remains in one Kafka partition.
PostgreSQL stores complete Pi-native semantic state once. Gateway replicas consume
Kafka into rebuildable memory containing incomplete active Turns only.

## Cursor-free browser handoff

The browser opens one SSE request without `Last-Event-ID` or a query watermark.
Gateway subscribes the connection and takes an immutable Session-tail snapshot
before performing network writes. Its first frame replaces the browser view:

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

## Failure matrix

| Crash boundary | Visible result | Recovery rule |
| --- | --- | --- |
| before `K` | Fact was never shown | producer may retry the same stable Fact ID |
| after `K`, before `V` | Fact may be unseen | Gateway consumer resumes from Kafka; reconnect receives a replacement snapshot |
| after `V`, before complete `P` | visible prefix remains in Kafka | interruption projection records the bounded prefix and abort fact in Pi context |
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
