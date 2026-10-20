# Subagent lifecycle and interaction review

Status: review complete, fixes not implemented, 2026-10-20.
Baseline: `6a9f5c9a`; production code/runtime remains `model-runtime-058925bb`, schema 192.
This is the second agreed branch, after the
[Workspace/Volume review](workspace-volume-lifecycle-review-20261020.md).
It covers direct and workflow delegation, native identity/ownership, control
dispatch/reconciliation, parent decisions, target discovery and result lifetimes.

## Findings

### SAR-01 · P1 · A waiting supervisor Tool repeatedly wakes its own reconciliation

[`SubagentController.executeTool()`](../../packages/control-plane/src/subagent-controller.ts)
calls `changed` after both new and repeated `contact_supervisor` reads, and while
rechecking a parent reply/wait. Production
[`main.ts`](../../packages/control-plane/src/main.ts) wires that callback to
`ControlToolDispatcher.wake()`. The dispatcher marks the currently executing
reference dirty; its `finally` removes the active marker and immediately drains
it again. Returning `waiting` with a future deadline does not clear that dirty bit.

The composed real-PG test uses this exact callback relationship. With no new
decision, no native updates and no interval advancement, it executes 20 handlers
and 63 business SQL statements in 76 ms. Only one supervisor request row exists
and no reply is sent. The fixture stops forwarding the self-wake at 20 calls to
bound the experiment; production has no such stop until the request changes,
expires or loses authority. This is an observed feedback loop, not a production
throughput or fleet-load estimate.

Direction: notify after an actual committed change, not after reading the same
pending state. Check reuse of the existing ordered supervisor control changes;
keep known deadline/retry wakes and lost-notification recovery. A no-change wait
must become quiescent. Do not hide the loop with a new polling service.

### SAR-02 · P2 · A progress update can hide a still-pending decision

`PostgresSubagentSupervisorChannel.latestForExecution()` combines progress updates
and outstanding decision requests, then returns the newest row. `#nativeWait()`
only returns a blocked result when that one row expects a reply. A newer progress
notification therefore makes the parent continue waiting, although an earlier
question still needs its answer.

The PG probe observes `blocked → waiting` after a progress update while the
decision remains in `pendingForParent()`. The maintained native tool mode permits
parallel control calls, so a model response containing both operations can reach
this ordering; this does not assert how frequently providers choose it.

Direction: select actionable pending decisions independently of progress display.
Define the order of multiple pending questions. A later progress update must not
hide the condition that prevents the child from finishing.

### SAR-03 · P2 · A cancelled child can still be returned as awaiting a parent reply

`#nativeWait()` checks the pending supervisor request before the child's terminal
state. `pendingForParent()` also does not exclude terminal children. An outstanding
unexpired request can therefore turn an already cancelled child's wait response
into `blocked`, with an instruction to reply.

The probe first completes native-record cancellation of both the generation and
its outstanding Tool. `status` reports `cancelled`, while `wait` returns `blocked`
and the old question remains listed. The initial fixture attempt cancelled only
the generation, leaving its synthetic contact Tool running; its failed assertion
was corrected to represent complete native abort settlement. That fixture error
is retained separately and is not evidence of a Pi cancellation defect.

Direction: respect the native terminal state before offering interaction. Retire
or exclude stale questions consistently from pending/read/reply paths without
reopening a completed child or creating a parallel cancellation scheduler.

### SAR-04 · P2 · Completed workflow host-call results remain retained for the entire Run

[`WorkerToolRuntime.create()`](../../packages/supervisor-host/src/tools/worker-tool-runtime.ts)
creates one `hostcalls` Map for all workflow invocations in that Run. Each native
Tool/task ID gets distinct keys, and entries retain fingerprints plus settled
result/publication Promises. Workflow disposal never removes those entries.

A controlled port-level GC experiment executes and disposes 64 separate workflow
Tools. WeakRefs show all 64 result objects still reachable while the Run's tool
bindings remain. Releasing those bindings permits all 64 to be collected, even
while the factory object itself remains. Their JSON payloads total 527,927 bytes;
this measures retained objects/serialized payload, not heap capacity or a
production OOM. Model, VM and actual script execution are substituted in this
specific lifetime probe.

Direction: retain same-key deduplication only for the owning live workflow
invocation. Join/cancel its pending work and clear its entries when that Tool is
disposed. Native history already owns settled results. No global result cache,
new result table or total Run deadline is needed.

## Design gap and simplification

**SAR-D1: discovery after an interrupted direct launch needs an explicit contract.**
A direct `run` returns its execution ID with the child result or a blocked reply,
not a separate initial start receipt. Before that return, the model-visible
catalog has no list/discovery action; `status/wait/cancel` require an execution
or child Session UUID. The provider call ID and native `task:N` ID do not resolve
a direct target. Workflow keys work in their separate host-call scope, not as
names for arbitrary direct launches.

The interface probe proves same-command deduplication works and a known execution
UUID works; the other known identifiers are rejected and a distinct new `run`
creates a new child. The prior [live sample](model-runtime-repair-20261020.md)
independently shows the parent trying an invalid target after recovery and then
issuing another distinct launch. This is not proof that missing discovery alone
caused that model choice, nor a failure of same-command idempotency.

Discuss a small read-only family directory or model-visible recovery summary
derived from existing native identities/PG associations. Do not deduplicate
different Tool tasks merely because their text is similar, add child cloud Runs,
or mark arbitrary script/shell work safe to replay.

**SAR-O1: repeat reconciliation performs avoidable admission-shaped reads.**
Revisiting one already acknowledged pending direct child uses seven business SQL
statements, including two locked reads, with zero Worker RPCs. Full control
dispatch adds its own authority/current-task read. Preserve first creation and
uncertain-admission checks; investigate a joined current-status read and reuse of
confirmed identity for later waits. Family wakes should not redo child creation
admission for every sibling outcome. This sample is not a fleet-scale benchmark.

**SAR-N1: maintained documentation contains pre-migration statements.**
`docs/SUBAGENTS.md` still describes 256 KiB results, child Runs and broad cached
status/target reads. Current code exposes 50 KiB/2,000-line result limits, native
child Conversations under one root Run, and uses SubagentReadViews here for the
Worker route. Its description of PG dispatch/result state also needs to name
native commits/current records rather than imply the removed command ledger.
Align the document with the deployed contract when applying the repairs.

## Preserved boundaries and verification

The native generation owns child Conversations; the delegation Tool itself does
not own them, allowing the parent to reach a decision-reply Tool. Creation uses
a native receipt and unchanged request identity across lost admission replies.
The PG child table is an association/read model, not a separately leased queue.
The dispatcher reloads pending commands from native history and checks current
authority/tasks; sealed or terminal work is not relaunched. Whole scripts run
in Cube, and unsafe JS/shell effects are not automatically replayed. These remain
the appropriate boundaries; no Pi core change or separate scheduler is proposed.

Evidence:

- 64 existing tests in 15 relevant files pass, including native child reattachment,
  Worker Conversation integration, management transport, control dispatch/results,
  workflow cancellation/transport and supervisor PG-clock behavior.
- Five real-PG characterizations/measurements reproduce the states above. Native
  task records are projected by the existing fixture; model execution and actual
  Worker RPCs are substituted. The self-wake test composes actual Controller and
  Dispatcher methods with production-equivalent wiring and a bounded test stop.
- One separate explicit-GC/WeakRef probe establishes workflow cache reachability
  before and after tool-binding release. It does not establish production heap
  growth per second or an OOM threshold.
- Probes typecheck. No new live model, Kafka reassignment or Worker-crash test was
  run in this slice; earlier live evidence is identified separately.

Reproduction commands:
[`scripts/experiments/review-subagent-20261020/`](../../scripts/experiments/review-subagent-20261020/README.md).
Aggregate measurements: [JSON](subagent-lifecycle-review-20261020.json).
Private logs: `deploy/production/runtime/review-evidence/subagent-20261020/`.
No production/runtime/configuration changes are included. Approval remains deferred.
