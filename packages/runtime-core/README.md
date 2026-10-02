# PiCloud runtime core

`@pi-cloud/runtime-core` contains execution semantics shared by the Control
Plane and trusted Pi Workers. It is not an HTTP API package and it does not own
NestJS controllers, browser authentication, deployment configuration or
Supervisor WebSocket transport.

## Owned boundaries

- exact-command Run and cancellation execution;
- physical-Session leases, single-execution Runs and terminal-state transitions;
- PG-authorized publication through the control-plane Kafka ingress and ordered closure;
- one Session Projector for semantic history, live views and Tool/control routing;
- cursor-free snapshots, cross-replica stream forwarding and bounded retention;
- native publication, conversation projection and interrupted-prefix recovery.
- one shared Outbox relay for seals and bounded control-change references.

## Dependency direction

```text
control-plane ──┐
supervisor-host ├─> runtime-core ─> domain/database/protocol/event-log
tests/tools ────┘                 └> pi-session-postgres/session-attachments

supervisor-host ─> sandbox-supervisor (concrete Pi runtime)
```

Runtime-neutral code belongs here only when at least two trusted runtime
components consume it or when moving it prevents a Worker from importing the
Control Plane product layer. REST controllers, tenant-facing services,
WebSocket channel code and production bootstrap stay in `control-plane`.

The package exposes explicit subpaths so consumers import one capability rather
than pulling a barrel that accidentally widens the dependency graph.
It has no dependency on the concrete `sandbox-supervisor` Runner. Control views
are rebuildable; PG retains admission and mutation authority, and arbitrary Tool
effects are never replayed by projection recovery.
