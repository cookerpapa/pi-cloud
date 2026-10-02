# ADR-0211: execution-path observations and physical runtime probes

Status: accepted by the owner, implementation in progress, 2026-10-02.

## Context and adoption

ADR-0201 observes Worker publication through the Session Projector. It does not
exercise a guest or the Worker reply mailbox. The current controller checks at
most 16 runtimes serially, ahead of resource cleanup, so fleet size and slow
requests extend both health detection and cleanup latency.

Reuse the [Prometheus pipeline-heartbeat pattern](https://prometheus.io/docs/practices/instrumentation/#offline-processing)
and the existing pinned Kafka, HTTP and Cube transports. The maintained
[Prometheus blackbox exporter](https://github.com/prometheus/blackbox_exporter)
(Apache-2.0; reviewed release [0.28.0](https://github.com/prometheus/blackbox_exporter/releases/tag/v0.28.0))
supports bounded endpoint probes, but its HTTP/TCP/gRPC probes cannot traverse
PiCloud's admitted Session writer, Projector and boot-local Worker mailbox.
Adding that service would still require the application instrumentation below.
Retain the bounded instrumentation in the existing owners; add no monitoring
broker, durable health table, execution scheduler or independent consumer group.

## Decision

1. A physical Session's Worker runtime originates a small probe on its existing
   publication path. Projector arrival immediately refreshes log-path evidence.
   When a current running guest binding exists, the same probe may continue
   through Cube, the fixed guest execution transport and the original Worker's
   Kafka reply mailbox. The Worker reports completion over disposable HTTP.
   Log-path and execution-path observations have independent freshness and waits.
   A slow guest branch cannot block projection or later log-path observations.
2. A fixed, non-user-configurable guest probe returns its nonce and guest boot
   identity without touching Workspace contents. Both Session probes and direct
   controller probes use this capability. Native Tool execution and probe replies
   remain distinct types. No probe creates a Pi Entry, Tool Result, display
   sequence, PG sample, Run, lease or execution authority.
3. Only existing runtimes are probed. Pure chat without an activated binding is
   explicitly not applicable. Paused/released runtimes are not resumed/recreated
   by observation. A missing expected binding is unavailable, never silently
   reclassified as not applicable. A changed binding, Worker boot or executor
   boot invalidates old evidence. Replies must match an outstanding, unexpired
   probe and its exact physical target; late or replayed replies cannot refresh it.
4. The controller owns disposable physical-runtime health, keyed by physical
   identity including the recorded node and executor boot. A confirmed current
   guest response (including a real native Tool response) can refresh that VM's
   execution evidence. Shared VM evidence is reusable across bindings, but one
   Worker's successful return path cannot refresh another Worker's Session path.
5. Without fresh guest evidence, the controller probes Cube and the guest
   directly with a bounded HTTP round trip. This works for idle VMs without a
   Run or Worker and does not depend on Kafka reply availability. The direct
   response establishes VM execution readiness, not Session/Kafka health.
6. Health work runs independently from destructive cleanup, uses per-runtime
   due times and bounded concurrency, and has no 16-item sweep truncation.
   Recent valid execution evidence postpones redundant direct probes. Preserve
   the deployed 15-second/45-second observation baseline initially; measure
   actual scheduling lag and durations before claiming fleet-scale detection.
   Bound in-flight work, apply deadlines, and drop optional observations under
   pressure rather than queueing them behind real Tools indefinitely.
7. Use bounded Cube inventory reads for lifecycle reconciliation. Treat a list
   as positive observations only: partial node failures, response limits and
   missing pagination cannot prove absence. A missing/anomalous runtime receives
   exact observation on its recorded node. Inventory `running` does not refresh
   guest-execution freshness. Confirmed absence remains the quota-release guard.

## Failure interpretation

Record the last confirmed stage: Projector arrival, confirmed Cube admission,
and complete return to the Worker. Reuse natural RPC receipts; do not install
a separate heartbeat sender at every intermediate hop. These stages narrow the
suspected interval, not conclusively identify a failed component. Failure to see
a completion may also mean its HTTP observation was lost.

A missing probe can trigger bounded diagnostic observation, but cannot renew or
revoke a lease, replay a Tool, delete a VM, release quota or revive a closed Run.
Definite stopped/absent/unsafe observations retain the existing controller-owned
quarantine and cleanup policy. A normal Tool error has no VM destruction power.
User-owned machines retain explicit release/rebuild semantics. Node disconnection
remains unavailable until absence or safe cleanup can be confirmed.

Public status distinguishes log-path freshness, execution-path freshness and
not-applicable/unconfirmed targets. Probe success does not assert model progress,
progress of an individual Bash command, or PostgreSQL native-history durability.
Metrics use bounded labels; identities may appear only in bounded payload-free
diagnostics. Controller restart resets disposable evidence to unknown.

## Acceptance and rollout

- Pure chat performs no VM allocation or execution probe; pause never wakes a VM.
- Shared Session Lanes do not amplify log probes; shared VMs reuse health evidence.
- Guest echo and direct probes use one fixed native transport with bounded input,
  output, lifetime and shutdown; malformed or replaced identities fail closed.
- Stalled Cube/guest/replies cannot block Projector or cleanup. At least 160 due
  runtime fixtures demonstrate full coverage, fairness and concurrency bounds.
- Lost/reordered/duplicate replies, binding replacement, late callbacks, Worker
  replacement, Projector reassignment and cancellation cannot fabricate freshness.
- Kafka loss with successful direct guest probing remains a transport diagnosis;
  guest/node loss remains uncertain until management evidence resolves it.
- Real Tool completion can provide execution evidence; synthetic dispatcher errors
  cannot. Ordinary assistant text never provides guest evidence.
- Protocol, controller, guest/Cube, mailbox and browser tests, plus real GPT-6 Luna
  and owned Cube acceptance, cover both probe routes and preserve native history.

Update Worker, Control Plane, Web, Cube patch set and guest template together.
Managed execution and completion-adapter readiness use protocol version 2;
native Tool guest frames retain their existing version 2 contract. The new Cube
RPC accepts only a fixed probe, with a five-second execution deadline and four
concurrent diagnostic slots. Direct HTTP has a ten-second client deadline, and
Worker probe callbacks also expire after ten seconds. Controller health
concurrency defaults to four and is deployment-configurable; it is an in-flight
budget, not a fleet-size or sweep limit. Test and record saturation and due-time
lag before increasing it for a larger multi-node deployment.
Record the exact tested revision and topology. No legacy probe fallback or new
durable authority is retained. Native Session history and Workspace Volumes keep
their existing export/recovery contracts; rollback requires a matched, drained
application/Cube set, not mixed protocol readers.
