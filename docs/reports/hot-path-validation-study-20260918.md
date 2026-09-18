# Hot-path validation study — September 18, 2026

**The clearest remaining CPU waste is interpreted schema validation, not Kafka
or an authority round trip per delta.** This is a diagnostic study of
`28c6c968`; no production implementation or deployment was changed.

## Findings

The streamed-event path validates the event in its factory, then validates its
envelope in the Pi runner, local execution backend and DirectExecutionLog.
The return ACK is also validated. These are local function calls, not separate
network ACKs. TypeBox `Value.Check` interprets the schema on every call. The
pinned TypeBox 1.1.38 already provides `Compile(schema).Check(value)`, keeping the
same rules without repeating that interpretation.

In a Node 24.18.0 container limited to 2 CPU/512MiB, seven small CPU batches gave
these median batch-average costs for a 256-byte text payload:

| Operation | Current | Compiled same schema |
| --- | ---: | ---: |
| Event check | 249µs | 4.9µs |
| Envelope check | 327µs | 7.7µs |

The composed Worker validation/publication path with an immediate encoding mock
bus cost about 1.16ms/event; it excludes Kafka, PostgreSQL and the model. Compiling
the three schemas once took about 71ms in that process, not per event or Turn.
These measurements are CPU evidence, not end-to-end latency predictions.

Other findings:

- DirectExecutionLog measures serialized bytes; the Kafka producer serializes
  again. One extra serialization costs about 0.002ms for this small record,
  0.073ms for 64KiB and 1.77ms for a synthetic 1MiB payload. This is secondary for
  small deltas. The two capacity checks protect different queues; removing either
  without replacing its coverage could allow memory growth before Kafka admission.
- Native projection and seal projection read/lock the Attempt and writer
  separately even when both IDs name the same row. Reusing that already-locked
  row is a local SQL optimization candidate. Child/peer Attempts still need the
  distinct writer check. No query-count or latency improvement is claimed yet.
- Publication and execution-boundary caches avoid a PG query on each ordinary
  delta. Native history transactions still lock/check closure to coordinate with
  stale consumers and seals. The latter is not equivalent to the cached check.
- Kafka decoding happens once before the projection fan-out. Tool routing returns
  immediately for text deltas; it does not call Cube or PG for them. Readiness
  checks are background work, not a provider/Kafka probe on each claim.
- SQL transaction retries apply only to deadlock/serialization aborts, not unknown
  COMMITs or arbitrary Tool effects. Queue limits, tenant attribution, UNKNOWN,
  ordered seals and rebalance checks retain real duties in a private deployment.

## Isolated real-Kafka comparison

Four fresh benchmark processes ran **current / compiled / compiled / current**.
Each mounted the repository read-only, used Node 24.18.0, 2 CPU/512MiB, its own
eight-partition topic on the existing three local brokers, RF3/min-ISR2/acks-all,
and the unchanged producer batching/backpressure settings.

Both variants ran the actual DirectExecutionLog and KafkaAcceptedFactBus with
unique event IDs. The harness also invoked the event-factory/backend validation
calls and return-ACK parser around that port. A diagnostic module loader replaced
only the three `Value.Check(schema, value)` implementations with precompiled
checks in the candidate processes. Identity checks, publication ordering,
serialization, capacity checks and Kafka acknowledgements were unchanged.
Production source files were not edited.

Each process tested one and 64 synthetic Session publishers, with one outstanding
append per publisher. Each case warmed for 16 appends/publisher, then measured
two five-second windows. Rates below use total events / total window time.

| Cohort | One publisher events/s | 64 publishers events/s |
| --- | ---: | ---: |
| Current 1 | 195.7 | 726.5 |
| Compiled 1 | 276.0 | 10,143.1 |
| Compiled 2 | 278.7 | 9,450.7 |
| Current 2 | 206.1 | 727.6 |

Across the four 64-publisher windows per version: **727.0 → 9,797.0 events/s**,
about **13.5×**. Individual window ACK p50 ranged **82.8–94.7ms → 5.67–6.51ms**.
For one publisher it ranged **4.72–5.42ms → 3.51–3.65ms**. These are window ranges,
not pooled latency percentiles. Shared host/brokers introduce noise, but the
return to the current implementation reproduced the lower throughput.

This is an intentionally saturated publication test, **not 64 real Agent Loops,
not a full Projector/PG/SSE benchmark and not Kafka's throughput limit**. No model
requests were made. Opening writes used the real bus; the benchmark's close-only
PG stub did not persist product state. This does not establish any improvement to
the previously measured 151ms whole-Turn non-provider median or storage tails.

## Correctness, scope and cleanup

- 558 differential inputs for the event, publication and ACK schemas matched
  interpreted versus compiled acceptance (16 accepted, 542 rejected). Cases
  included missing/extra fields, wrong types, invalid IDs, NaN/Infinity, unsafe
  integers and Unicode. This is not exhaustive protocol conformance.
- 38 existing protocol, producer-backpressure, execution-boundary and Projector
  handoff tests passed on unchanged production code. They are not claimed as a
  full acceptance run of a shipped compiler change.
- The shared protocol also runs in the browser. Its production CSP disallows
  dynamic evaluation. TypeBox has a documented non-JIT path, but any real patch
  must test the strict-CSP browser build; do not loosen CSP to obtain this gain.
- All five isolated Kafka topics and all benchmark containers were removed.
  Temporary loader/benchmark scripts were removed. No users, Sessions, Volumes,
  development machines or provider credentials were created or changed.

Recommended next slice: retain validation rules and use the existing library's
compiled validators on the hot path, then validate error contracts/browser CSP
and rerun full request timing. Address same-row SQL reuse separately. Do not merge
durability boundaries or introduce a new cache/transport to obtain these gains.
