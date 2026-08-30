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
- Different Sessions may run model/Agent Loops and Tool operations concurrently
  against the same elastic Workspace. They receive independent Tool bindings
  to one Workspace-owned Cube.
- A human terminal no longer blocks Run claim. It owns one elastic Cube; an
  Agent that starts while the terminal is connected borrows that same physical
  Cube under its own external lease, avoiding an unsupported second Volume
  attachment.
- A cloud development machine may have one active Agent authority and one
  human terminal/SSH session at the same time inside the same Cube. Lifecycle
  mutations such as pause and release still require both to settle.
- The shared Workspace settlement pointer is last-observed metadata,
  not a compare-and-swap writer lock. A concurrent settlement cannot fail an
  otherwise successful Run merely because another Session settled first. Each
  Session advances only its own settlement pointer; it never rewrites every
  sibling Session's base revision.
- Remove per-tenant active-Run, unsettled-Turn and active-Sandbox ceilings.
  Project and Session limits bound long-lived product resources, while
  Worker/Cube/Sandbox-Domain capacity remains real infrastructure admission.
- The Run queue does not claim tenant fairness without a measured starvation
  problem and an explicit policy.
- A `shared` Subagent uses the same Workspace runtime and ordinary Linux
  concurrency. `isolated` remains the explicit separate-Volume/Cube mode.

## Consequences

Pure chat and model generation do not wait for a terminal or Cube state.
Operators scale Worker and Cube capacity globally instead of assigning each
tenant an arbitrary active ceiling.

A terminal and Agents sharing one Cube can race on files and process-visible
resources. Different Sessions can reason and execute Tools concurrently in the
Workspace's one physical runtime. PiCloud records
independent Run/Attempt evidence and does not promise merge semantics or restore
a lost update caused by terminal/external edits.

An exclusive machine currently retains one Agent binding at a time; its
physical Cube lifecycle remains independent from that temporary binding.
