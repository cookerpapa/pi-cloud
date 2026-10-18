# Session publication and Run completion review

Date: 2026-10-18 (Asia/Shanghai). Reviewed baseline:
`6b7bc02bc1993f8f6f66bdc8e7e1bf3d38fe6def`.
Serving release remains `tool-settlement-20ac9696`.

Scope: public Pi Durable 1.0.0 Storage commit through the direct Session Kafka
producer, and native family completion through `work_finished`, PG retirement,
successor readiness and browser termination. This revisits the publication hop
after ADR-0243–0255 instead of relying on the older ingress review.
Only review artifacts and documentation change. No runtime repair, deployment,
production fault injection or business-data mutation is included.

## Findings

### SPC-01 — P2: normal completion replay does not restore its terminal notification

`ExecutionStreamProjector.#finishWork()` returns without a terminal when
`run.output_sealed_at` is already set. This is correct for avoiding a second
business transition, but also discards the presentation result of the original
transaction. The forced-seal path already reads the stored terminal on replay;
the normal `work_finished` path does not.

A real isolated PG fixture reproduces this schedule:

1. The final PG transaction commits a `turn.completed` at sequence 2, closes the
   Run and releases its writer.
2. A wrapper drops the transaction's successful return and throws before the
   Projector can deliver the event. This models an uncertain COMMIT response;
   the test does not claim to inject an actual TCP failure.
3. Reprocessing the exact same Kafka position succeeds, but returns no terminal
   or canonical-coverage result. The stored terminal remains unique.
4. The live view remains at sequence 1 with its earlier running event. The normal
   consumer retries a failed partition record without resetting live subscribers.
   SSE keepalives do not reread PG, and the browser changes its Session to idle
   on a terminal event or a replacement snapshot.

Impact: a connected page can keep showing running after the Run has actually
completed, until refresh/reconnect or another snapshot replacement. The result
and closure are persisted; this is a missing presentation recovery path, not
lost conversation history or authorization to replay a Tool.

Locations: `packages/runtime-core/src/execution-stream-projection.ts:407`,
`packages/runtime-core/src/session-projector.ts:236`,
`packages/event-log/src/kafka-log-consumer.ts:509`,
`packages/runtime-core/src/session-event-stream.ts:112` and
`packages/web-ui/src/session-view.ts:652`.

Repair direction: return the exact persisted terminal and coverage on normal
completion replay, after the existing identity/closure checks, so the current
live-view deduplication can deliver it or suppress a genuine duplicate. Do not
reallocate an event sequence, rewrite the Run, introduce a second completion
Outbox, or turn completion into a per-Step PG acknowledgement. Add lost-COMMIT
return, duplicate replay and successor/old-writer tests.

### SPC-02 — P2: a proved pre-send refusal interrupts the whole native owner

`PublishedDurableStorage.commit()` distinguishes `PublicationNotSentError` from
an ambiguous publication and returns native `StorageRejected` without advancing
its sequence. Pinned Pi likewise discards that transaction draft without
poisoning its Session. `WorkerExecutionLog` and the direct producer preserve the
same distinction for local queue/size refusal.

However, the enclosing `PostgresDurableSessionHost` unconditionally aborts its
shared interruption signal when `active.publish()` rejects. By the time Storage
classifies the error correctly, the entire physical Session has already been
marked `writer_publication_failed`.

The actual Host with a real PG lease reproduces a trusted pre-send refusal:
no publication succeeds, both the local and PG native head remain at sequence 1,
the first call throws `StorageRejected`, but the owner signal is aborted and
the second call never reaches the publisher. This also affects sibling native
Conversations because they share that owner. The outer runner maps the signal
to writer recovery and ordered closure.

Impact: local capacity refusal or attachment preparation failure, when explicitly
proved not to have reached Kafka, can unnecessarily interrupt the whole family.
Other running unsafe Tools then face ordinary interruption recovery even though
this rejected batch created no uncertainty in their writer. No stale write or
automatic shell replay was observed.

Locations: `packages/pi-session-postgres/src/durable/session-host.ts:392`,
`packages/pi-session-postgres/src/durable/published-storage.ts:175`,
`packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts:897` and pinned
`node_modules/@earendil-works/pi-durable/dist/session/session.js:273`.

Repair direction: carry the existing trusted no-send classification through the
Host, leaving Pi to handle the rejected draft while preserving the acknowledged
state and other Conversations. Continue to retire the owner on unknown/mismatched
ACK, producer fencing or failure after ACK. This restores ADR-0199's bounded
refusal contract at the current Durable boundary; it does not authorize automatic
retry, an unbounded queue or a weaker fencing rule. Test the integrated Host,
not only the standalone Storage adapter.

### SPC-03 — P3: lifecycle documentation still describes the removed topology

`docs/RUN_LIFECYCLE.md:39` still describes separately claimed child Lanes,
`pi_sessions.unsealed_runs`, and a healthy owner claiming another Lane.
Its terminal section still sends ordinary completion through a drained-proof
write and terminal Outbox. `docs/STREAM_DURABILITY.md:3` still places a control-plane
ingress before Kafka; lines 67–100 describe ingress fencing and per-Lane seals.
The current README, architecture document and ADR-0247 describe direct Session
producers, native child Conversations and ordinary `work_finished` correctly.

Impact: the exact documents recommended for following the message path give
contradictory accounts of who schedules work, fences writers and ends a Run.
This is documentation drift, not evidence that the runtime still uses those paths.

Repair direction: rewrite both maintained documents around the current code and
separate voluntary normal retirement from forced Session closure. Remove old
counts, per-child queue/seal claims and ingress descriptions; keep historical
details in their versioned reports. Check nearby source comments as part of that
bounded cleanup, without renaming current control-only publication machinery
merely because it retains an older internal name.

## Measured optimization

### SPC-O1: reuse the already locked Run inside the completion transaction

The simple successful-completion fixture records 18 SQL statements through the
Kysely query plugin: one timeout-configuration statement and 17 other statements,
excluding BEGIN/COMMIT. This measures `project(work_finished)`, with no pending
live checkpoint, images or child views; it is not the total SQL cost of a Run
or of routing revocation.

Three SELECTs read the same Run in that transaction:

1. `ExecutionStreamProjector.#finishWork()` reads and locks the Run.
2. `finishWorkIn()` reads its state and closure fields again.
3. `transitionCurrentRun()` reads state/version/identity and locks it again.

Locations: `packages/runtime-core/src/execution-stream-projection.ts:359`,
`packages/runtime-core/src/work-finished-projection.ts:22` and
`packages/runtime-core/src/run-state.ts:21`.

Carry an explicit transaction-scoped locked snapshot to completion and transition
helpers, including its version and identity, and update that snapshot after any
intermediate cancellation transition. This can remove two redundant reads in
the ordinary path. Keep all authority/native-head/closure checks and separate
lock-then-read boundaries where their snapshots actually differ. No cross-request
cache is needed. This runs once per completion and has lower priority than SPC-01/02;
no throughput or latency gain is claimed without measurement.

## Contracts rechecked without a new finding

- Pi transaction drafts and the Worker overlay become adopted only after the
  ordinary native publication acknowledgement. Exact native batches, origins,
  image references and same-commit display/dispatch descriptions are preserved.
- A physical Session has one serial producer identity independent of Run/Boot/
  lease incarnation. Before/after initialization PG authorization, native Kafka
  producer fencing and ordered forced closure remain in place. Ordinary appends
  do not add PG authorization reads or reinitialize uncertain producers.
- Native parent `Conversation.waitForIdle()` includes owned descendants. A parent
  final answer alone does not close the Run. The root adapter also joins child
  runner/publication teardown, and `finish()` refuses attached child log views.
- Input admission closes on the same local input line as the final queue-version
  decision. Native follow-ups remain within the same Run.
- The writer drains before `work_finished`, which carries its final native and
  display positions. PG rejects completion ahead of the native head. Normal
  completion does not need a terminal Outbox hop.
- Routing revocation precedes the PG successor boundary. If forced closure was
  already requested, native completion does not discard that pending writer
  seal; existing tests preserve that order and one logical terminal.
- Failed publication, lease loss, Stop, unsafe Tool recovery and Worker drain
  retain their existing ownership/cancellation boundaries. No result receipt,
  missing heartbeat or terminal browser event proves physical process exit.

## Verification and remaining test uncertainty

The two targeted existing-suite groups pass **157 tests** (93 + 64). The first
group also skips the real Kafka test when no broker fixture is supplied; that
case runs in the separate transport suite. Covered files include native Storage
conformance/Host, native Conversations/turn runner, the Session publisher and
Kafka writer, normal completion/forced seals, lease retirement, Worker drain,
cancellation admission, live view and SSE contracts.

The three isolated characterizations passed on this baseline and are archived
at Git commit `94ebd1ed`. They deliberately asserted the reproduced defects and
original SQL count. The approved repair replaces them with maintained
[completion](../../packages/control-plane/test/session-completion-boundaries.test.ts)
and [publication](../../packages/control-plane/test/session-publication-refusal.test.ts)
regressions. [Measurements](session-publication-completion-review-20261018.json)
retain the baseline results; [delivery](session-publication-completion-repair-20261018.md)
tracks the repair separately.

The complete disposable RF3 Kafka/PG transport suite initially passes **7/9**:

- `agent-stop-binding-closure.integration.test.ts:236` observes two closure
  delivery positions while asserting exactly one.
- `subagent-views.integration.test.ts:148` observes eight SQL statements from one
  control-handler pass during its asserted idle interval.

A fresh targeted diagnostic run, adding observation only and preserving the
original assertions, passes both tests. It observes one closure delivery and no
extra SQL in that interval. This is not a clean full-suite pass and does not
establish the exact cause of the first run's additional deliveries/wake.
The control path permits duplicate Outbox delivery and relevant delayed wakes;
the fixtures need to distinguish them from duplicate effects or continuous
polling. Track this separately as **SPC-Q1**, retaining the failed samples.
Do not weaken runtime ordering or add a deduplication ledger just to satisfy
an exact notification-count assertion.

No paid model, live Cube or production browser acceptance was repeated for this
review. All PG/Kafka fault work uses owned disposable containers and databases.
The reviewed release is unchanged. Repair and matched/live acceptance remain
separate work after the findings are agreed.
