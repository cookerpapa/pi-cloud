# ADR-0127: Authority Gate and Accepted Fact Bus

## Status

Accepted on 2026-08-26. This refines ADR-0126 by separating authorization from
the downstream broker and projections. ADR-0126's short per-Grant channel
ownership remains current; its JetStream-coupled event-writer composition does
not.

## Context

PiCloud had two trusted Worker ingress paths. Browser events crossed an
EventWriterChannel whose service combined writer authority, sequence checks,
duplicate handling, JetStream publication and watermark recovery. Complete Pi
Session mutations crossed a second HTTP endpoint that combined PostgreSQL
authority, mutation batching, JetStream publication and result handling.

Both paths correctly ensured that downstream consumers saw only facts accepted
under a current ExecutionGrant, but the acceptance boundary was not a single
replaceable component. A Worker and two ingress implementations knew which
JetStream Stream served each fact. Changing the broker or the acceptance
protocol therefore required changes on both sides of the Authority boundary.

## Decision

One active Run owns one service-authenticated `FactChannel`. It carries both
browser-facing Agent events and complete Pi Session mutations. The channel is
opened under the same short PostgreSQL writer lease introduced by ADR-0126.

The pipeline has four independent roles:

```text
CandidateFact
→ ExecutionGrantAuthorityGate
→ AcceptedFact
→ AcceptedFactBus
→ independent projectors
```

The Authority Gate answers only whether the current writer may represent the
canonical Tenant, Session, Run and Turn. It binds those canonical fields from
the PostgreSQL Grant row and removes the opaque ExecutionGrant from its output.
It does not query or control a broker, assign broker cursors, sequence facts,
deduplicate facts, replay history or wait for a downstream projection.

The `AcceptedFactBus` port owns durable append and returns a broker-neutral
receipt. Its current JetStream adapter maps Agent-event and Pi-Session-mutation
facts to their maintained Session-keyed Streams. Stable Fact IDs, physical log
ordering, duplicate suppression, retention and replay are bus/downstream
concerns. Consumers never call the Authority Gate or receive a bearer Grant.

Agent events have one additional downstream progress projection. It records
the highest R=3-acknowledged logical event sequence in PostgreSQL in set-wise
renewal checkpoints and flushes on normal FactChannel close. Terminal event
allocation needs that durable boundary after a Worker crash, but the progress
store cannot authorize, reject, order or deduplicate a CandidateFact. Terminal
allocation takes the maximum of Attempt and channel progress.

The Ingest Orchestrator composes the two ports:

```text
accepted = authorityGate.accept(channel, candidate)
receipt = acceptedFactBus.append(accepted)
```

An accepted Agent event is acknowledged after its R=3 durable append and may
then reach SSE. An accepted Pi Session mutation is acknowledged after its R=3
append; the Pi runtime separately waits for the PostgreSQL Projector result
when the next Agent operation causally depends on that mutation. This
projection wait is Agent Session consistency, not Authority Gate behavior.

No new generic Fact-size policy, Fact-ID policy, kind registry, forbidden-field
scanner or defensive JSON layer is introduced in this cutover. Existing wire
parsing needed to transport the two maintained fact variants remains; semantic
defense policy requires separate product evidence.

## Failure semantics

- stale Grant at channel open: no CandidateFact reaches the Gate output;
- writer expires or is replaced: the channel closes and later candidates are
  not accepted;
- broker unavailable after authorization: no durable receipt is returned and
  the same stable Fact identity may be retried;
- broker acknowledges but the Worker loses the receipt: the bus handles the
  duplicate identity; downstream projectors remain idempotent;
- SSE or Session projector fails: accepted facts remain replayable without
  rechecking an expired Grant;
- PostgreSQL Session projection lags: the Pi runtime waits on its mutation
  result/barrier, while unrelated live facts continue independently.

## Consequences

The Worker has one FactChannel instead of separate Event and Session-mutation
ingress clients. The Gate depends on PostgreSQL Authority only. JetStream is
selected behind the `AcceptedFactBus` adapter and can be compared or replaced
without changing Gate semantics.

Two physical JetStream Streams may remain because live replay and Pi mutation
projection have different consumers. That is an adapter decision hidden from
the Worker and Gate, not two acceptance boundaries.
