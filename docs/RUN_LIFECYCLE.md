# Run lifecycle

## Admission

`POST /v1/sessions/{id}/turns` authenticates tenant ownership and writes the
user message, Turn and ready Run row in one PostgreSQL transaction. The Run's
unique Session/idempotency key prevents a retry from creating another Run.
Same-Session Runs remain serialized by mailbox position.

Queued Follow-up is a persisted input/Run, not yet a Pi user Entry or Kafka
Session mutation. Steer is first stored in `turn_control_requests` and delivered
to the running Pi queue; only native consumption creates its user Entry through
the Fact path. A `delivered` response does not prove model consumption. See
[the real API/Worker check](reports/worker-handoff-findings.md).

## Claim and execution

All Pi Workers claim directly from the same ready `runs` rows. PostgreSQL sends
a notification to reduce idle latency, but a one-second poll is the recovery
path. A narrow indexed query locks one candidate with `SKIP LOCKED`; only that
Worker loads the immutable Run context and creates its Attempt. Before doing so
it briefly locks the physical `pi_sessions` row: a Session lease owned by another
Worker makes this candidate ineligible, while another Lane on the same Worker may
proceed without reserving a second family slot.

`RunExecutor` transactionally rechecks:

- the Run is still eligible;
- this is the Session's next runnable message;
- cancellation has not won;
- no current Attempt already owns the Run.
- all active Lanes of the physical Pi Session have this Worker as owner;
- every requested predecessor execution seal for this product Session is projected.

It creates a RunAttempt with a startup claim deadline, binds it to the physical
Session's owner lease, registers publication scope and marks the Turn/Session
running in one transaction. There is no separate startup phase commit. The
startup deadline cannot steal a lease-bound claim. The Worker renews that owner once per heartbeat;
it does not renew a child task's startup deadline. Each task carries an
`ExecutionReference`: the shared lease/epoch plus its own Attempt identity. The
reference is never placed in model context or the guest Tool runtime. Cube's
trusted management metadata retains the creation identity for inventory and
orphan reconciliation; it is not authority for later Tool calls. Task
states/deadlines are managed independently; lack of child output does not imply
owner loss.

Once a minute, the Worker releases completed in-memory Run/control outcomes
only after PG confirms a terminal Run, projected seal and terminal control
requests. Uncertain or still-running work is retained; failed lookups are logged
and release nothing. Lookups are batched off the execution path. A concurrent
new Lane/owner is not evicted by an older check. Local duplicate caches are not
authority: Run admission and Steer replay still consult the durable rows before
any new execution. This cleanup never deletes conversation history.

## Pi and Tools

The Worker opens Pi's native Session state and appends the accepted user
message. Pi may perform multiple model sampling steps. Pure chat never contacts
Cube.

Before that prompt is appended, the Worker compares the current execution
World State with the newest persisted baseline. A renewed Session lease on the same
physical Cube keeps the same continuity identity. A new Cube around the same
Workspace produces `sandbox_reset`; a different stable Workspace binding
produces `workspace_changed`. Both are hidden Pi custom facts, never browser
messages or modifications to the user's text. Repeated context hooks on the
same binding do not append another fact, and Compaction retains the newest
material fact for recovery after Session ownership moves to another Worker.

For a Tool call, the Worker presents the task reference used by the
execution publication. Tool Broker verifies the shared lease and active task together with the Tool
binding, frozen Tool policy and Step context. The first binding lazily creates
the Workspace-owned Cube; later bindings share it without provider rebind.
Different Sessions may execute Tools concurrently in that Cube.

There are two native Session post-sampling commit boundaries in this flow.
They are not the total number of transport/database acknowledgements before an
effect: concrete operations additionally require Kafka command PubAck and Broker
PostgreSQL execution admission. First, one AcceptedFact atomically carries the complete Pi
Assistant Entry, its usage Record and `model.sampling.completed`. Pi then
validates the Tool name and arguments. Second, one AcceptedFact carries the
specific `tool_started` intent and public `tool.started`. Only after its
Kafka acknowledgement returns does the bound Tool publish its concrete
operation command for Projector routing to the owning Broker. A
rejected Tool call never writes execution intent. This distinguishes a Tool
that may have started from later calls that were merely present in the model
message.

A Tool transport retry may reattach to the same operation identity. It must not
start a second arbitrary shell operation. If start/result cannot be proven, the
result is `UNKNOWN`.

## Events and terminal commit

Admission binds an immutable publication scope to the current
Session lease and task identity. After admission commits, the Worker appends real
records directly to Kafka, without an opening marker. The first native record
co-commits its recovery floor in PG; first display/control records persist that
floor before delivery. There is no Fact WebSocket or second renewable channel lease.
One Projector group checks recorded scope and same-partition seals, applies native
PG state, updates the live view and routes Tool commands to their owners.
The Worker continues at Kafka ACK without waiting for per-Step PG receipts.

Projector also co-commits message-level display coverage, so an active Run's
complete messages are queryable before its terminal. Covered spans leave the
live cache. Presentation becomes terminal only after its requested seal commits,
not merely because a Worker reported completion. Snapshots are framed values;
partial transport values never become user-visible messages.

Complete native state and projection position commit atomically. At completion,
the Worker drains its append queue, persists that drained-output proof and the
authority requests a seal through Outbox. Projector commits the seal, interrupted
prefix if any and public terminal, then updates its live view directly. A queued
successor waits for this PG closure. No second Kafka commit notice is needed.

Lanes share one native append sequence while their Agent Loops remain concurrent.
Cold restore reads the latest Compaction and active suffix; active Steps read
the acknowledged in-memory view. Model-output and validated-intent boundaries
remain distinct. Public Run state stays settling until its seal is projected.

## Cancellation and failure

Cancellation stops that task's new effects before trying to interrupt model/Tool
work; it does not release siblings' shared owner lease. Task state and current
Session authority are required for effects. The maintenance loop retires every
task of an expired physical Session, while leaving unrelated Sessions on that
Worker alone. The shared lease is removed only after its task scopes drain.
Already admitted shell effects
remain UNKNOWN. SQL-only lifecycle retries cannot re-execute the Agent Loop.
Before admission commits, no output or Agent execution is allowed. After admission,
even preparation failure or a lost first Kafka ACK requires a seal, not a blind
retry or output-free pre-start requeue. Running includes context preparation,
not proof that a model or Tool has actually started.
An execution seal in the same Kafka partition closes a retired Attempt. A delayed
Worker producer can still append its old record, but if it arrives after the seal both
canonical and live consumers discard it. Earlier accepted data is projected
before the successor is allowed to claim. A caught interruption writes Pi's minimal
abort/reset boundary. A hard Worker loss is reconciled from the retained Kafka
prefix plus a factual interruption marker; no Tool result is invented. A
normal failure/cancellation uses the same ordered seal reducer, with no best-effort
HTTP prefix fetch and no guessed terminal sequence.

Cube loss discards processes, memory, sockets and PTYs. The persistent Workspace
Volume survives and can attach to a fresh KVM. The next Pi step is told only
when the execution world materially changed.

If a Worker dies during lazy Cube creation, its Tool binding expires. A late
physical runtime with no current Workspace bindings is reconciled and destroyed
without retaining scarce admission capacity.

## Delivery semantics

```text
Run table queue        at-least-once wakeup + transactional claim
Pi Session mutation    Recorded publication scope + Kafka + idempotent PostgreSQL projection
Tool start              no blind retry; UNKNOWN if ambiguous
Workspace files         persistent Volume; independent of Run completion
terminal Run commit     idempotent current-Attempt transaction
Cube create/delete      idempotent reconcile
live AcceptedFact       Recorded publication scope + Kafka acks=all + Projector fact-id/sequence projection
```
