# Run lifecycle

## Admission

`POST /v1/sessions/{id}/turns` authenticates tenant ownership and writes the
user message, Turn and accepted Run row in one PostgreSQL transaction. The Run's
unique Session/idempotency key prevents a retry from creating another Run.
Same-Lane Runs remain serialized by mailbox position. A queued Run is dispatchable
only when `ready_at` is non-null. Acceptance readies the initial head; committed
predecessor closure readies its successor under the same Session row lock.

Pending human inputs are editable before admission (ADR-0194). Queue actions use
the Session revision and an idempotent control receipt. Adjacent swaps are atomic;
cancelled unstarted Runs retain their identity without a native execution/seal.
Model, credential, environment and Tool snapshots remain fixed at acceptance.
The Worker locks the Run, then reads current input text in a fresh statement;
queue edits acquire that lock with NOWAIT and cannot change admitted context.

Queued Follow-up is a persisted input/Run, not yet a Pi user Entry or Kafka
Session mutation. Direct Steer also creates a source Turn/Run and holds it with
a queue control request in the same transaction (ADR-0203). Its HTTP 202
`accepted` response confirms durability. Delivery to the running Pi queue records
acknowledgement; only native consumption creates its user Entry through the
Fact path. The held source inherits the target's frozen execution settings.
Delivery uses the HTTP management backend. WebSocket registration/heartbeat
has no Steer prepare/commit/release fallback.

Both direct Steer and promotion hold their source out of dispatch until consumption is
confirmed. Its control ID is the stable Agent-input identity. HTTP retries cannot
append a second input. A lost acknowledgement does not cause queue re-execution:
the reconciler checks the canonical input Entry and the target's projected seal.
Only a sealed target with no consumed Entry restores the source's queued position.
Steer inputs to the same Run are sent in acceptance order; different Sessions can
deliver concurrently. An optional edited text is committed with promotion.

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
- the Run has never been admitted before;
- all active Lanes of the physical Pi Session have this Worker as owner;
- a new owner sees zero `pi_sessions.unsealed_runs`;
- a delegated task still belongs to its live parent execution.

Lane order/previous seal dependencies were established by readiness, not scanned
again during claim. First Run owner binding increments the family count; first
seal projection decrements it, inside the existing transactions. A current healthy
owner can run another Lane before its siblings finish. KEDA counts active leases
and ready cold families, not waiting follow-ups or unbound startup claims.

It binds the Run to the physical Session's owner lease, records publication scope
and marks Run/Turn/Session running in one transaction. Locked facts are reused;
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

For a Tool call, the Worker uses the execution's PG-issued publication identity.
Its first lazy binding prepares the Workspace-owned Cube and records a bounded
immutable execution descriptor; later bindings can share that VM. Different
Sessions may execute Tools concurrently there. The control plane owns lifecycle
and binding closure, while Cube enforces boot identity, active-operation identity
and per-VM Kafka partition progress.

There are two native post-sampling commits. First, an AcceptedFact carries the
complete Pi Assistant Entry, its usage Record and `model.sampling.completed`.
Pi validates the Tool name and arguments. Second, one combined invocation fact
carries `tool_started`, the public `tool.started` and the concrete prepared
command. This single commit replaces separate intent and command acknowledgements.
A rejected Tool call never writes execution intent. The Projector materializes
that intent, confirms its dispatch offset and issues the bounded Cube handoff.
Cube owns execution and final Kafka delivery; Pi's Worker-side processing makes
the returned Tool Result canonical.

An ambiguous handoff closes its operation scope and is not replayed. Cube rejects
a changed active duplicate and recognizes an identical active operation within
its boot. Completed operation bodies are discarded after delivery; source
positions reject historical replay without retaining every closed Run.
If start/result or stopping cannot be proven, the outcome remains `UNKNOWN`;
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
An execution seal in the same Kafka partition closes a retired Run. The
control-plane ingress closes publication admission, requests PG binding closure,
and waits for its ordered Kafka control fact to stop Cube. The binding's lifecycle
acknowledgement distinguishes stopped from quarantined. Normal resource release
requires stopped; quarantine never releases quota. An explicit retry advances the
closure revision. Only then can ingress publish the final seal (ADR-0219). Replaced ingress owners are transactionally
fenced. Earlier accepted data is projected before the successor is allowed to
claim; replayed records cannot reopen a sealed scope. A caught interruption writes Pi's minimal
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
terminal Run commit     idempotent Run transaction
Cube create/delete      idempotent reconcile
live AcceptedFact       Recorded publication scope + Kafka acks=all + Projector fact-id/sequence projection
```
