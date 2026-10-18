# ADR-0256: Session publication refusal and completion replay

Status: accepted and implemented in source, full verification and release pending,
2026-10-18. See the [delivery record](../reports/session-publication-completion-repair-20261018.md).

The owner approved the [publication/completion review](../reports/session-publication-completion-review-20261018.md)
and its repair directions after discussing native `StorageRejected`, the current
64 MiB/4,096-record Worker budget, and the loss of an uncommitted Tool result.
This refines ADR-0199/0247 at the current Pi Durable boundary. PG control authority,
native Storage ownership, Session producer identity and external-effect fencing
remain unchanged; schema and transport versions do not change.

## Decisions

- Normal `work_finished` replay returns the persisted terminal event and its
  coverage after the existing scope/closure checks. The live view delivers or
  deduplicates that same identity. It does not create another terminal event,
  transition the Run again, add an Outbox hop or unblock a successor early.
- A trusted `PublicationNotSentError` before acknowledgement remains a definite
  rejection through the Session Host. Pi receives `StorageRejected` and owns
  draft rollback/task failure. Ambiguous publication, mismatched ACK, fencing
  and every failure while adopting an acknowledged publication still interrupt
  the entire owner. A post-ACK exception cannot claim the batch was not sent.
- This does not add storage retries or waiting for queue space. In particular,
  retaining the owner does not preserve a rejected Tool Result automatically:
  native task fault settlement may produce missing-result context. Bounded
  publication backpressure would require a separate decision and acceptance.
- Completion reuses its transaction-local locked Run snapshot. The transition
  helper retains its version check and returns the updated snapshot for a second
  cancellation transition. No cross-request cache or new durable authority is
  introduced.
- Transport tests synchronize with observed control changes before measuring
  idle reads. Replayed closure notifications retain their logical identity and
  ordering; exact delivery counts are not an exactly-once contract. Assert one
  durable outcome and no repeated Tool submission instead.
- Rewrite maintained lifecycle/streaming documentation around Session direct
  publication and native children. Superseded ingress/child-Run descriptions
  remain in historical evidence, not active instructions.

## Reuse and acceptance

Reuse the pinned public Pi transaction semantics, existing Kafka consumer retry,
stored `session_terminal_events`, live-view deduplication and PG transactions.
No queue, broker, cache, task engine or storage protocol is being built/adopted.
The prior no-send and direct-producer research remains applicable.

Required checks: actual PG commit-return loss plus duplicate/late replay;
terminal identity and successor fencing; integrated Host no-send versus unknown
and post-ACK failures; native Tool fault behavior; one locked Run read for normal
completion and correct successive cancellation versions; deterministic control
wakes/duplicate notifications; existing source/fault/RF3 gates. Then use the
maintained drained matched release and relevant GPT-6 Luna/Cube/browser/recovery
acceptance, preserving configuration and verifying physical fixture cleanup.

Delivery status is tracked separately in the backlog and release report.
