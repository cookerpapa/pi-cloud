# Run lifecycle

## Admission

`POST /v1/sessions/{id}/turns` authenticates tenant ownership. For an idle
Session it writes the initial user text/uploads, frozen configuration and Run
identity in one PG transaction, returning `kind:run`. There is no `turns` table;
`turn_id` in Run remains the public root presentation/provenance ID. The unique
Session/idempotency key prevents a repeated initial request from creating a new Run.

For an active Run, ordinary input becomes native follow-up and explicit Steer
becomes native steer. The Worker submits through Pi's public API and returns
`kind:input` only after its existing Kafka-backed Storage commit is acknowledged.
One Run can therefore consume several user messages. Follow-up waits for Pi's
final boundary; steer uses Pi's earlier continuation boundary. No holding Run or
PG payload queue is created. An unavailable Worker leaves the browser draft
unconfirmed, with the same request key for retry (ADR-0238).

Native InboxDoc and submission state own membership, order and consumption.
The Worker's code-owned metadata DocFamily stores human text/upload references,
original fingerprints and mutation receipts in that same native log. Edit,
move, individual cancel and promotion are atomic public document transactions;
consumption winning the race rejects the change. Promotion keeps the same input
identity. Local unsaved edits do not enter the log. Repeated saves append document
changes, and retries never restore an earlier version over a later edit.

Unclaimed initial Run inputs remain editable in PG. Queue edits acquire the Run
lock with NOWAIT; a competing Worker claim produces a conflict. Model, credential,
environment and Tool snapshots stay fixed at acceptance. The Worker reads the
latest saved initial text in a fresh statement after locking the Run. A queued
Run is dispatchable only with non-null `ready_at`; closure and acceptance update
readiness under the Session lock. Native queued follow-up is not another Run
waiting for cloud scheduling.

## Claim and execution

All Pi Workers claim directly from the same ready `runs` rows. PostgreSQL sends
a notification to reduce idle latency, but a one-second poll is the recovery
path. A narrow indexed query locks one candidate with `SKIP LOCKED`; only that
Worker loads the immutable Run context. Before authorizing it, the Worker
briefly locks the physical `pi_sessions` row: a Session lease owned by another
Worker makes this candidate ineligible, while another Lane on the same Worker may
proceed without reserving a second family slot.

`RunExecutor` atomically assigns a ready Run. It checks:

- the Run is still eligible;
- cancellation has not won;
- this is initial admission or ordered old-writer closure permits native recovery;
- all active Lanes of the physical Pi Session have this Worker as owner;
- a new owner sees zero `pi_sessions.unsealed_runs`;
- a delegated task still belongs to its live parent execution.

Lane order/previous seal dependencies were established by readiness, not scanned
again during claim. First Run owner binding increments the family count; first
seal projection decrements it, inside the existing transactions. A current healthy
owner can run another Lane before its siblings finish. KEDA counts active leases
and ready cold families, not waiting follow-ups or unbound startup claims.

It binds the Run to the physical Session's owner lease, records publication scope
and marks Run/Session running in one transaction. Locked facts are reused;
there is no Attempt, startup deadline or separate claimed phase. Worker-local
pending reservations protect capacity; PG retains no occupancy counter. The
Worker renews its Session owner once per heartbeat. Each task carries an
`ExecutionReference`: the shared lease/epoch plus its Run identity. The
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

The Worker opens the native Durable Session/Harness and submits the input using
the logical Run as request ID. Recovery finds that same submission instead of
appending another user message. Native Tasks own continuation; PG owns admission. Pi may perform multiple model sampling steps. Pure chat never contacts
Cube.

Before that prompt is appended, the Worker compares the current execution
World State with the newest persisted baseline. A renewed Session lease on the same
physical Cube keeps the same continuity identity. A new Cube around the same
Workspace produces `sandbox_reset`; a different stable Workspace binding
produces `workspace_changed`. Both are hidden Pi custom facts, never browser
messages or modifications to the user's text. Repeated context hooks on the
same binding do not append another fact, and Compaction retains the newest
material fact for recovery after Session ownership moves to another Worker.

For a Tool call, the Worker uses the execution's PG-issued publication identity.
Its first lazy binding prepares the Workspace-owned Cube and records a bounded
immutable execution descriptor; later bindings can share that VM. Different
Sessions may execute Tools concurrently there. The control plane owns lifecycle
and binding closure, while Cube enforces boot identity, active-operation identity
and per-VM Kafka partition progress.

Native Durable commits the Assistant entry and Tool tasks before execution.
After argument validation and before-hooks, a fixed Tool's execute checkpoint
and compressed dispatch co-commit through Kafka. Arguments occur once, in the
checkpoint. Projector materializes it and confirms the dispatch offset before
Cube handoff. Cube owns execution and final Kafka delivery; native Worker
processing owns the canonical result. Invalid arguments admit no external effect.

An ambiguous handoff is not replayed or compensated by killing its process. Cube rejects
a changed active duplicate and recognizes an identical active operation within
its boot. Completed operation bodies are discarded after delivery; source
positions reject historical replay without retaining every closed Run.
If start/result cannot be proven, the outcome remains `UNKNOWN`;
quarantine does not assert physical VM absence.


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
authority requests a seal through Outbox. Projector commits the seal and public
terminal, then updates its live view directly. Recoverable owner loss instead
closes the old incarnation and re-admits the original Run without a terminal. A queued
successor waits for this PG closure. No second Kafka commit notice is needed.

Lanes share one native append sequence while their Agent Loops remain concurrent.
Cold restore reads the latest Compaction and active suffix; active Steps read
the acknowledged in-memory view. Model-output and validated-intent boundaries
remain distinct. Public Run state stays settling until its seal is projected.

## Cancellation and failure

Chat Stop aborts the native Conversation and its owned tasks. Fixed Tool and
Workflow operation cancellations enter the same ordered Session log with native
abort state. The Harness may settle `aborted` without awaiting an uncertain guest
result; late replies cannot rewrite that decision. Cancellation acceptance does
not prove process termination. Sibling Conversations keep their shared lease.
Completed background work is never cancelled retroactively.

Recoverable Worker loss revokes routing, closes the old writer incarnation and
re-admits the same Run/Turn/native submission under a new PG lease. A stopped
recovering Run is admitted only to record native abort; model and effect ports
remain gated. Native pending tasks cannot self-authorize a replacement Worker.
Unsafe Tool checkpoints produce native interruption results instead of replaying
shell effects. Provider requests may be retried under the new grant. Finite
configured budgets retain a conservative floor from committed native intents;
unlimited defaults add no admission query. No RunAttempt or operation ledger is
introduced, and external effects are not exactly once.

A normal failure/Stop is logical termination. Its seal still waits for ordered
publication and binding revocation. Abnormal retirement retains its immutable
cleanup target in the existing control Outbox. Replaced ingress owners are Kafka
transactionally fenced; old callbacks cannot mutate the new lease. Native progress
owns the retained text and abort messages, not a fabricated prefix Entry from the
Projector. No guessed Tool result or physical VM absence is inferred from failure.

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
terminal Run commit     idempotent Run transaction
Cube create/delete      idempotent reconcile
live AcceptedFact       Recorded publication scope + Kafka acks=all + Projector fact-id/sequence projection
```
