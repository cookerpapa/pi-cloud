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
- Different Sessions may run concurrently against the same elastic Workspace.
  Each Session receives its own Cube process world; both mount the same
  persistent Volume. Conflicting edits are the user's responsibility.
- A human terminal no longer blocks Run claim. For an elastic Workspace it
  uses a separate Cube unless it can reuse that Session's idle warm Cube.
- A cloud development machine may have one active Agent authority and one
  human terminal/SSH session at the same time inside the same Cube. Lifecycle
  mutations such as pause and release still require both to settle.
- The shared Workspace version pointer is last-settled observational metadata,
  not a compare-and-swap writer lock. A concurrent settlement cannot fail an
  otherwise successful Run merely because another Session settled first.
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

Two conversations or a terminal and Agent can race on the same files and
process-visible resources. PiCloud records independent Run/Attempt evidence,
but it does not promise merge semantics or restore a lost update. The UI and
documentation describe this as user-managed concurrency.

An exclusive machine still has only one Agent activation because all Agent
operations share one physical Cube authority. Supporting multiple simultaneous
Agent leases inside one machine would require a distinct in-VM execution
ownership protocol and is not implied by this decision.
