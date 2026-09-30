# ADR-0193: Native Run input, retry and compaction boundaries

Status: accepted, implemented and locally validated, 2026-09-26, following owner approval of
the [focused review](../reports/cloud-agent-runtime-review-20260926.md).
[Repair and acceptance](../reports/cloud-agent-runtime-repair-20260926.md).

Keep Pi 0.84.1, the public Agent Loop and existing SessionStorage, authority,
Kafka ACK and no-effect-replay contracts. This is one runtime lifecycle slice;
no new scheduler, input ledger, storage backend or protocol is introduced.

## Decision

- A running CloudAgentRuntime accepts native steer/follow-up inputs until one
  synchronous close decision. After a successful native Agent continuation,
  queued messages cause another `Agent.continue()` within the same cloud Run.
  Checking that queue and closing input admission have no intervening await.
  Final Session writes occur with input admission closed. Delivery rechecks that
  boundary immediately before enqueueing, including after asynchronous dedup reads.
  Closed input maps to the existing `steer_target_unavailable` error. Abnormal
  termination retains the current durable-input/missed-delivery behavior; it
  does not replay a failed Run or promise consumption across Worker loss.
- A successful model response ends the previous sampling retry state regardless
  of whether its stop reason is `toolUse` or an ordinary completion. Failed and
  aborted responses cannot be reported as retry success. Native Step records and
  cloud model permits retain their existing identities and scopes.
- Compaction threshold decisions use provider usage only when a valid usage
  source exists in Entries after the latest Compaction. Native Entry order,
  rather than provider timestamps, establishes freshness. Otherwise estimate
  the full current context with Pi's public token estimator, including the
  summary, retained tail and new input. Explicit overflow recovery stays separate.
- A Run-local cancellation signal interrupts sampling backoff, then the existing
  native abort path settles the Agent without another model request. It does not
  revoke the shared physical Session authority; final records and other Lanes
  still require that authority.

Native `Agent.followUp()` remains an in-Run queue. This repair originally kept
product queued follow-ups immutable in PG until predecessor closure. The subsequent
[ADR-0194](0194-editable-pending-inputs.md) now permits editing, cancellation,
reordering and promotion before admission, while preserving this ADR's native
input closure and no-replay boundaries.

[ADR-0203](0203-consumption-confirmed-direct-steer.md) subsequently gives direct
human Steer the same held-source recovery as queue promotion. It preserves this
ADR's native input closure; unconsumed human input can become a future Run after
definitive closure, without resuming the failed Run or replaying its Tools.

## Acceptance

Cover inputs arriving at agent_end and while final append waits; delivery paused
in authority/dedup reads; repeated input identity; ordinary and Tool continuations;
retry reset after success; cancellation during backoff without a new provider call
or revoked Session; stale versus fresh usage and oversized new input after a
Compaction. Preserve native writer/PG, Tool intent ACK, failure, Lane isolation,
context-overflow and no-replay tests. Rerun the review probes with no findings.
