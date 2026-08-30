# 0136 — Workspace-owned elastic Tool runtime

## Status

Accepted.

## Context

PiCloud already treats a user-owned cloud development machine as one physical
Cube with temporary Agent authority. Elastic execution did not follow that
model: each Run reserved a logical Tool activation that also became the Cube's
physical identity. Two Sessions sharing one Workspace therefore transferred a
single Volume between Run-owned activations and queued their entire Tool phase.

That coupling is unnecessary. Selecting the same Workspace intentionally shares
its files, Git credentials, processes and service ports. Platform-level file
locking or conflict resolution would contradict ordinary Linux behavior and the
user-managed concurrency decision in ADR-0130.

## Decision

An elastic Workspace owns at most one live physical Cube in one Sandbox Domain.
Runs do not own that Cube. Each Tool-using Run receives an independently fenced
**Tool binding** that authorizes operations against the Workspace runtime:

```text
Workspace
└── elastic runtime: one physical Cube
    ├── Tool binding A: Session A / Run A / ExecutionLease A
    ├── Tool binding B: Session B / Run B / ExecutionLease B
    └── optional human terminal
```

The Broker validates every binding's current `ExecutionLease`, frozen Tool set,
Turn context and Step context before dispatch. Multiple bindings may execute
inside the same Cube concurrently. They run as the same unprivileged guest user
and observe ordinary Linux file, process and port-conflict semantics.

The physical runtime identity is stable while the Cube is live. A binding ID is
never used as the Cube identity. Worker cleanup revokes only that binding and
must not destroy a Workspace runtime still used by another binding.

The first Tool operation lazily creates the Workspace runtime. When the last
binding leaves, the runtime enters the existing bounded warm TTL. A later Run
for the same Workspace reuses it without Session handoff or provider rebind.
Capacity eviction or failure may destroy it; the persistent Workspace Volume
remains the file authority.

Workspace settlement is observational and does not freeze the Cube. It records
a lightweight Volume revision after a Run's own Tool operations have completed.
Concurrent writes by another Session are allowed and may be included in that
observation. Settlement is neither a file lock nor a snapshot.

An isolated Subagent Workspace still receives a different Volume and therefore
a different Cube. A shared Workspace uses the same Workspace runtime. Exclusive
development machines retain their existing one-Cube resource lifecycle and
temporary Agent bindings.

## Consequences

- Different Sessions sharing one Workspace can issue Tool operations
  concurrently instead of waiting for one another's Run boundary.
- Sessions can see and affect each other's files, processes and ports by design.
- Cancellation revokes one Tool binding; it destroys the physical Cube only
  when provider uncertainty makes the shared process world unsafe.
- Preview and terminal routing resolve the Workspace runtime directly.
- Broker restart does not promise transparent recovery of in-flight Tool RPCs.
  Expired bindings fail, while orphan reconciliation destroys an unadopted
  elastic Cube without changing persistent Workspace bytes.
