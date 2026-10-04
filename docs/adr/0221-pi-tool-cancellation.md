# ADR-0221: Pi Tool cancellation across the execution boundary

Status: implemented and deployed, 2026-10-04. See the
[verification and live acceptance](../reports/pi-tool-cancellation-20261004.md).

## Behavior

Supersede ADR-0220's intentional detachment on chat Stop. Keep Pi's public
`Agent.abort()` and await each already-published Tool callback's cancellation
result before ordinary Run settlement. Cancel interrupts model generation and
prevents later calls immediately; it does not wait for a command to finish its
original workload. Queue/draft behavior remains under owner discussion and is
outside this implementation.

Use an operation ID, never a remote PID, across the boundary. An operation that
already finished in Cube cannot be cancelled retroactively, including while its
reply is in transit. Preserve its result and any background services it left.
Normal cancellation acts on the guest Tool's AbortSignal and Bash process group.
Do not use the broader operation cgroup cleanup for a normal user cancellation:
that would also kill processes which created their own session/group with setsid.
Infrastructure teardown and native Tool timeouts retain their separate cleanup.

## Adopted mechanisms and ownership

The pinned Pi 0.84.1 public Tool API already receives an AbortSignal, awaits the
Tool promise, and finalizes its result after cancellation. Its built-in Bash
collects output and reports `Command aborted`. Local source probes establish
that nohup alone stays in the current group, completed launch calls are not
retrospectively stopped, and setsid descendants can survive group cancellation.
Reuse this contract instead of modifying the Pi Agent Loop.

Reuse the installed Kafka/PG Outbox, Cubelet execution handles, fixed guest
framing and Worker reply mailbox. The source/adoption evidence in ADR-0219 and
the Cube execution comparison remains applicable: adding Temporal, another
queue/consumer or a general process scheduler would duplicate current execution
authority without removing the destination's cancellation responsibility.
Kafka ordering does not itself order RPC arrival at Cube; retain destination
boot and partition-position checks. No dependency, credential scheme, per-Tool
PG execution ledger, completed-result cache or process-status GET is introduced.

## Normal path

1. Existing PG cancellation admission persists the request and wakes the Worker.
2. The Worker's native Agent abort signal reaches its prepared remote Tool.
3. After its invocation publication settles, the adapter publishes a bounded
   `tool_cancel` fact through that same Session writer/ingress/Kafka path.
   Cancellation has its own bounded lifetime; it must not reuse the already
   aborted model/Tool wait signal for delivery.
4. Projector forwards the cancellation with its consumed Kafka position. Cube
   closes that operation's cooperative cancellation channel and acknowledges
   request acceptance only. This acknowledgement is not proof of process exit.
5. The fixed guest transport delivers cancellation to the original Tool's
   AbortController. Its ordinary final reply, with retained output, resolves
   the original Worker callback. Pi applies its hooks and publishes the
   canonical Tool Result before Run sealing.

Cancellation delivery is idempotent and may be repeated. It never resubmits the
original command. Cube advances partition progress even if a valid cancellation
overtakes an old submit RPC; an older submit then cannot start a new effect.
Completed operation IDs are still discarded after bounded reply delivery.

## Failure and retirement

Allow a bounded cancellation-result wait; use a shared code-owned transport
budget rather than an unbounded Tool promise. An accepted cancellation, a lost
reply or an unreachable executor cannot be reported as confirmed stopping.
Return `tool_operation_outcome_unknown` with an explicit inspection-before-retry
message when the result cannot be established. Run cancellation and unknown Tool
outcome may coexist. Confirmed completion wins over a racing cancellation.
Late replies cannot rewrite a sealed Run or resolve another invocation.

Retirement must cover a Worker that dies before publishing its cancellation.
Reuse closed binding control references for an abnormal/unconfirmed retirement,
carrying the bounded immutable Cube target and Run/writer identity needed after
binding deletion. Cube selects only unfinished operations belonging to that
scope. Healthy completion needs no extra Cube cancellation. This is durable
cleanup intent, not a PG stopped/quarantined receipt or a second execution ledger.
Pending control delivery may be retried; it does not block unrelated partitions
indefinitely or authorize VM deletion. A new binding still verifies executor
availability and boot before new Tools are admitted.

Keep model output interruption, Tool outcome and physical VM evidence distinct.
Only the existing control-plane lifecycle can destroy/recreate a VM, and quota
release still requires confirmed physical absence. Missing replies/probes never
provide that proof.

## Cutover and acceptance

Advance managed Cube protocol to 5 and guest Tool wire to 3. Retire the old
detach-only path; deploy matched app/Cube/guest artifacts after draining Runs.
Do not reset business data. Rollback requires matched drained binaries/state.

Test interruption around invocation publication, immutable reply recovery,
cancel/complete races, lost replies, unavailable/changed executors, bounded wait,
Worker loss, cancellation redelivery, delayed old submits, and no shell replay.
Prove partial-output retention, foreground process-group cancellation, completed
background-service survival, setsid survival and shared-VM sibling isolation.
Use real PG/RF3 Kafka and GPT-6 Luna/Cube for final acceptance.
