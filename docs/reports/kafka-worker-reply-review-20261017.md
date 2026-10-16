# Kafka replies → Worker callback review

Date: 2026-10-17. Baseline `85ece0ed88fcd97c57d24cbeb1fe7c55aa56e34b`;
serving application release `tool-unknown-791a6ed0`.

Scope: the original Worker's boot-scoped Kafka reply consumer, operation matching,
image restoration, cancellation/late results and return to Pi's `execute()`.
The canonical Storage commit after return is the next walkthrough boundary.
This review changes no production implementation, protocol, deployment or data.

## Findings

### KWR-01 — P2: reply transport health is absent from Worker admission

`KafkaLogConsumer.checkHealth()` detects lost assignment, consumer failure and
sustained partition stalls. `KafkaToolReplyMailbox` neither exposes that health
nor reports continuing failure to its owner. After startup assignment succeeds,
`PiWorkerRuntime` builds its periodic readiness check from Session publication
availability and provider health only. Its HTTP readiness and PG claim admission
therefore can remain ready when the separate reply consumer cannot receive.

Example: Session writes and the model route work, but the boot reply consumer is
reconnecting or cannot reach its partition. The Worker can keep taking new Runs
and dispatching Tools which cannot finish their return path. Fixed Tools eventually
hit their reply deadline; control Tools rely on their cancellation signal and
the outer Run budget. This is delayed failure detection, not proof that the
deployed Run can wait forever: the Runner retains an outer deadline.

Evidence: an isolated real-mailbox/consumer test fails the driver's metadata path
after a healthy assignment. Three consumer instances are observed, existing
waiters receive no failure notification, another waiter is accepted, and there
is no mailbox health port. The runtime composition and readiness endpoint wiring
were checked in source; this review did not inject a production Worker outage or
claim to test its HTTP readiness end to end.

Locations: `packages/event-log/src/tool-replies.ts:253`,
`packages/event-log/src/kafka-log-consumer.ts:532`,
`packages/supervisor-host/src/runtime.ts:304` and `:424`,
`packages/supervisor-host/src/tools/worker-tool-runtime.ts:155`.

Repair direction: expose local reply-consumer readiness through the existing
Worker admission monitor, and restore admission on recovery. Give sustained
transport failure an explicit bounded settlement policy for outstanding waits,
separate from the legitimate duration of a Subagent task. Preserve native abort,
writer closure and unsafe-replay rules. Add no channel lease, PG health table,
new consumer group or VM-destruction inference.

### KWR-02 — P2: attachment restoration overwrites completion evidence

The mailbox validates and accepts the final Tool reply before the Worker downloads
its referenced images. However, `waitForToolReply` returns one Promise for both
receipt and image decoding. The remote Tool adapter sets its `received/completed`
flag only after that combined Promise succeeds.

Consequently, an S3/attachment failure after a valid final reply is wrapped as
`tool_operation_outcome_unknown`, invokes `onToolOperationUnavailable`, and marks
the Runner's sandbox world state unavailable. Its unwind also sets
`cancelOutstanding`. Stop during an in-progress image download similarly records
unconfirmed physical cancellation, although the final execution reply has already
arrived. The mailbox itself has correctly removed the completed operation.

The composed mailbox + image codec + remote Tool probes reproduce both cases:

- Valid final reply, injected image download error: zero mailbox waiters,
  `completed=false`, one unavailable callback and no readiness probe.
- Valid final reply, Stop during image download: `completed=false` and one
  cancellation-unconfirmed callback.
- Successful image restoration retains exact bytes, reports completion and adds
  no readiness probe.

Existing tests explicitly group image-decoding errors with transport UNKNOWN;
the new probe demonstrates the lost distinction after an actual accepted reply.
This finding does not claim that a healthy VM was physically destroyed. The
verified effect is wrong failure attribution and unnecessary abnormal-cleanup
intent; VM lifecycle still belongs to Control Plane.

Locations: `packages/supervisor-host/src/runtime.ts:523`,
`packages/sandbox-supervisor/src/trusted-remote-tools.ts:295`, `:319` and `:378`,
`packages/sandbox-supervisor/src/remote-tool-sandbox-turn-runner.ts:797`, `:864`
and `:937`; sandbox status is stored by `pi-sandbox-continuity.ts:219`.

Repair direction: distinguish validated execution receipt from materializing its
attachments and from Pi's later canonical commit. Retain receipt evidence in the
existing invocation's memory; classify attachment delivery errors separately.
Stopping the Run may still be appropriate, but an image-store failure should not
assert missing execution evidence or sandbox unavailability. Native Stop remains
authoritative; late bytes cannot resurrect an aborted task. No result cache or
durable operation ledger is needed.

### KWR-03 — P2: reassignment rereads the retained reply prefix

The mailbox sets `commitMessages:false` and supplies neither group recovery nor
a replay cursor. Every assignment consequently chooses Kafka's current low
watermark. `KafkaLogConsumer` already tracks processed offsets in memory, but
assignment overwrites them with that low watermark. Reconnection within the same
Worker boot therefore decodes the previously handled prefix again.

An isolated pinned RF3 Kafka test publishes 100 valid replies with 16 KiB text
each, then forces a real group reassignment while keeping the original mailbox
object alive. Exactly 100 old records are delivered again before the next reply;
the old operation reaches `accept()` twice. Its callback still settles once,
and the fresh callback succeeds. This is redundant network/decoding work, not
duplicate Tool execution or duplicate canonical results. No fleet latency or
timeout rate is inferred from the small sample.

Locations: `packages/event-log/src/tool-replies.ts:268`,
`packages/event-log/src/kafka-log-consumer.ts:278`, `:313` and `:473`.
The reply topic's normal retention is 121 minutes, so the replay prefix depends
on the current retained data, not just the invocation which is waiting now.

Repair direction: preserve a completed-delivery cursor for the lifetime of this
boot's mailbox and resume from it on reassignment, respecting retention bounds
and unsettled handlers. Reuse the existing reader/replay seam; avoid per-reply PG
writes or a second canonical progress store. A new Worker still creates a new
boot/topic and never adopts the old callbacks. Keep Session Projector recovery's
different durable replay semantics intact.

## Boundaries which remain sound

- Wait registration precedes execution-intent publication; fast replies can
  arrive before the original writer observes its ACK without being dropped.
- `operationId` selects the waiter; native call ID and Tool name are checked.
  Duplicate replies settle a callback once. Cancelled/retired waiters ignore
  late messages. Different operations may share a provider Tool call ID safely.
- One consumer serves the boot's family slots. Matching ordinary text results
  needs no PG lookup; image metadata and bytes use their existing scoped ports.
- Image downloads run outside the synchronous Kafka handler; a slow S3 request
  does not hold that partition's callback handler while other replies arrive.
- Probe replies remain outside native Tool callbacks and model history.
- The pinned Pi 1.0.0 `ToolTask` awaits `execute`, applies `afterTool`, bounds
  output and commits the canonical result. Unsafe recovered intent is not
  reexecuted. The callback is not a replacement persistence authority.
- A Worker crash after reply receipt but before native commit can still lose
  that uncommitted result. This is the accepted boot-local/unsafe-recovery
  contract, not a new finding or justification for a raw-result ledger.

The generic consumer retries decoding failures in partition order. A malformed
record could block this one-partition mailbox, but maintained reply publishers
also use the same parser before Kafka publication. No ordinary maintained producer
of such a poisoned record was established; this is not listed as a reproduced
production defect or a reason to weaken Session-log ordering.

## Verification and limits

- 96 existing targeted tests pass: event-log mailbox/ordered effects (17),
  attachment codec (7), remote Tools/native publication/presentation (66), and
  Worker Tool adapters/admission monitor (6).
- Five baseline characterization cases pass in the
  [isolated probe](../../scripts/experiments/kafka-worker-review-20261017/reply-hop.test.ts);
  [machine-readable evidence](kafka-worker-reply-review-20261017.json) distinguishes
  substituted transport/image storage from inspected runtime wiring.
- The [real RF3 probe](../../scripts/experiments/kafka-worker-review-20261017/rebalance.mjs)
  and [its evidence](kafka-worker-reply-rebalance-20261017.json) confirm replay on
  actual reassignment. Its three disposable brokers/network were removed.
  It does not simulate a production network partition or measure fleet capacity.
- Local installed Pi Durable 1.0.0 `dist/harness/tool.js` was checked for execution,
  after-Tool hooks, abort and unsafe-recovery semantics. No Pi private API or
  upstream loop change is proposed.
- The initial isolated outage fixture had an incomplete mock error-code set;
  supplying an explicit injected transport code fixed the fixture. This was
  not a product failure. No model calls, production failure injection or live
  Cube effects were used in this review.

The probes intentionally characterize the reviewed baseline, including undesirable
behavior. They are explicit review experiments rather than ordinary acceptance
tests for a future repaired implementation. Repairs should replace those assertions
with maintained regression tests and retain the evidence above.
