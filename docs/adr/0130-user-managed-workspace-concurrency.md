# ADR-0130: user-managed Workspace concurrency

Status: accepted

## Context

PiCloud originally treated a Workspace as a platform-wide single-writer
resource. A human terminal, another conversation using the same files or an
exclusive-machine terminal could keep an otherwise valid Run queued before the
model was called. Per-tenant active-Run and active-Sandbox ceilings added more
claim-time locks and made a private deployment behave unlike a developer's own
machine.

The durable Workspace authority is the persistent Volume. POSIX already
defines the result of concurrent file access; it does not make concurrent
edits desirable, but the platform cannot infer the user's intended coordination
policy. Preventing every conflict in the scheduler also delays pure chat and
couples Run admission to optional compute state.

## Decision

- Same-Session Runs remain FIFO and non-overlapping. RunAttempt leases and
  fences remain unchanged.
- Different Sessions may run their model/Agent Loops concurrently against the
  same elastic Workspace. Cube's Volume contract permits one attached Tool
  runtime, so Tool Broker queues only their Tool-Sandbox phase and switches the
  Volume after the prior activation settles. This physical slot is not a Run
  Claim or model-admission lock.
- A human terminal no longer blocks Run claim. It owns one elastic Cube; an
  Agent that starts while the terminal is connected borrows that same physical
  Cube under its own external lease, avoiding an unsupported second Volume
  attachment.
- A cloud development machine may have one active Agent authority and one
  human terminal/SSH session at the same time inside the same Cube. Lifecycle
  mutations such as pause and release still require both to settle.
- The shared Workspace version pointer is last-settled observational metadata,
  not a compare-and-swap writer lock. A concurrent settlement cannot fail an
  otherwise successful Run merely because another Session settled first. Each
  Session advances only its own checkpoint pointer; it never rewrites every
  sibling Session's base revision.
- Remove per-tenant active-Run and active-Sandbox ceilings. Keep bounded
  project, Session and unsettled-Turn admission to prevent unbounded durable
  metadata, and keep Worker/Cube/Sandbox-Domain capacity as real infrastructure
  admission.
- Tenant scheduling timestamps remain a fairness hint; they are not a hard
  quota.
- Explicit `shared_serialized` Subagent handoff remains serialized because it
  is a parent/child workflow contract, not an ordinary user concurrency policy.

## Consequences

Pure chat and model generation do not wait for a terminal or Cube state.
Operators scale Worker and Cube capacity globally instead of assigning each
tenant an arbitrary active ceiling.

A terminal and Agent sharing one Cube can race on files and process-visible
resources. Different Sessions can reason concurrently, but their elastic Tool
effects use the Workspace's one physical runtime slot. PiCloud records
independent Run/Attempt evidence and does not promise merge semantics or restore
a lost update caused by terminal/external edits.

An exclusive machine still has only one Agent activation because all Agent
operations share one physical Cube authority. Supporting multiple simultaneous
Agent leases inside one machine would require a distinct in-VM execution
ownership protocol and is not implied by this decision.
