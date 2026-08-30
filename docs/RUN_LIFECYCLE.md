# Run lifecycle

## Admission

`POST /sessions/{id}/messages` authenticates tenant ownership and writes the
user message, Turn and ready Run row in one PostgreSQL transaction. The Run's
unique Session/idempotency key prevents a retry from creating another Run.
Same-Session Runs remain serialized by mailbox position.

## Claim and execution

All Pi Workers claim directly from the same ready `runs` rows. PostgreSQL sends
a notification to reduce idle latency, but a one-second poll is the recovery
path. A narrow indexed query locks one candidate with `SKIP LOCKED`; only that
Worker loads the immutable Run context and creates its Attempt.

`RunExecutor` transactionally rechecks:

- the Run is still eligible;
- this is the Session's next runnable message;
- cancellation has not won;
- no current Attempt already owns the Run.

It creates a RunAttempt with a bounded claim lease. The Worker heartbeats that
claim and obtains an opaque execution authority containing the current Attempt
and fence. The raw authority is not placed in model context or Cube.

## Pi and Tools

The Worker opens Pi's native Session state and appends the accepted user
message. Pi may perform multiple model sampling steps. Pure chat never contacts
Cube.

Before that prompt is appended, the Worker compares the current execution
World State with the newest persisted baseline. A renewed Tool lease on the same
physical Cube keeps the same continuity identity. A new Cube around the same
Workspace produces `sandbox_reset`; a different stable Workspace binding
produces `workspace_changed`. Both are hidden Pi custom facts, never browser
messages or modifications to the user's text. Repeated context hooks on the
same binding do not append another fact, and Compaction retains the newest
material fact for cross-Worker recovery.

For a Tool call, the Worker presents the same Session lease used by the
FactChannel. Tool Broker verifies its expiry and fence together with the Tool
binding, frozen Tool policy and Step context. The first binding lazily creates
the Workspace-owned Cube; later bindings share it without provider rebind.
Different Sessions may execute Tools concurrently in that Cube.

A Tool transport retry may reattach to the same operation identity. It must not
start a second arbitrary shell operation. If start/result cannot be proven, the
result is `UNKNOWN`.

## Events and terminal commit

The Worker opens one short-leased logical Fact Stream for its opaque
ExecutionLease before Pi starts. Streams from all active Runs in that Worker
share one physical Fact WebSocket. Assistant text deltas cross their Stream
without an intentional batching delay; one lease remains ordered while
different leases publish concurrently. Tool arguments and Tool results enter
the same stream only as complete Items. Each event's Kafka `acks=all` receipt is the
visibility boundary. Event ordering and duplicate handling belong to the
Kafka/downstream adapter rather than the Authority Gate. Stream close flushes
the post-PubAck event progress and releases short channel ownership
before terminal settlement releases the lease. Terminal sequence allocation
uses the maximum of Attempt progress and the separately projected channel
progress, so a lagging projection cannot move the Session stream backwards.

Pi `message_end` submits a complete Session mutation through that same
FactChannel. The unified PostgreSQL Gate validates current writer authority once
and removes the lease before the AcceptedFactBus performs Kafka append. The
PostgreSQL projector then applies the accepted fact idempotently without another
authority query, and the Worker waits at a read-your-writes barrier before the
next model Step. On successful settlement, the Worker
prepares the lightweight Workspace Volume settlement. The terminal transaction
validates the current Attempt/fence, records the last Workspace settlement
if applicable, writes a terminal event Outbox record and settles the Run. A
different Session settling the same Workspace first does not fail this Run. Kafka
retention eventually removes hot fragments while canonical Pi
messages remain in PostgreSQL.

## Cancellation and failure

Cancellation revokes authority before trying to interrupt model/Tool work.
Expired or superseded Workers cannot mutate Pi SessionStorage, execute another
Tool or commit terminal state. A caught interruption writes Pi's minimal
abort/reset boundary. A hard Worker loss is reconciled from the retained Kafka
prefix plus a factual interruption marker; no Tool result is invented. A
normal failure/cancellation also fetches that trusted prefix from the Control
Plane instead of trusting a possibly-behind Worker-local buffer.

Cube loss discards processes, memory, sockets and PTYs. The persistent Workspace
Volume survives and can attach to a fresh KVM. The next Pi step is told only
when the execution world materially changed.

If a Worker dies during lazy Cube creation, its Tool binding expires. A late
physical runtime with no current Workspace bindings is reconciled and destroyed
without retaining scarce admission capacity.

## Delivery semantics

```text
Run table queue        at-least-once wakeup + transactional claim
Pi Session mutation    Authority Gate + Kafka + idempotent PostgreSQL projection
Tool start              no blind retry; UNKNOWN if ambiguous
Workspace settlement    fenced last observation; persistent Volume owns bytes
terminal Run commit     idempotent current-Attempt transaction
Cube create/delete      idempotent reconcile
live AcceptedFact       Authority Gate + Kafka acks=all + Gateway fact-id/sequence projection
```
