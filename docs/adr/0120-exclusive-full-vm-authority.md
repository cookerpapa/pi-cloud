# ADR-0120: Exclusive environments use Cube full-VM state authority

## Status

Accepted on 2026-08-23.

## Context

PiCloud originally presented an exclusive Cube as a persistent development
environment while treating only the separately mounted `/workspace` Volume as
durable. That contract preserved project files across Cube replacement but lost
guest-root filesystem changes, installed system packages and processes. It also
made the directory chooser infer folders from a Session's Workspace file index
instead of reading the live machine. Deleting the last Session therefore made
an otherwise live environment appear empty.

CubeSandbox already provides the required infrastructure. Pause/resume captures
the microVM's CPU, memory, runtime and filesystem state. Explicit Cube snapshots
are independent resources that can seed another Sandbox. Cube v0.6 does not yet
provide a generally portable, remotely replicated cross-node pause authority,
so the availability boundary must remain explicit.

An exclusive guest may eventually grant its owner administrative access. Any
in-guest process is consequently tenant-controlled and cannot be the durable
authorization authority for Tool execution or platform access.

## Decision

- Elastic execution keeps the existing model: a disposable Cube mounts one
  persistent Workspace Volume at `/workspace`. Reclaiming the Cube may lose
  processes and guest-root changes but not Workspace bytes.
- An exclusive environment is a complete user-owned Cube machine. Its guest
  root filesystem, user home, memory and process tree belong to the machine
  state. `/workspace` may remain a convenient project directory, but it is not
  the definition of machine durability.
- A conversation attached to an exclusive environment stores a directory
  binding inside that machine. Session lifetime remains independent: archiving
  a Session neither pauses nor releases the environment.
- Idle exclusive environments use Cube pause/auto-resume instead of destroy.
  Planned Tool Broker shutdown pauses owned machines and relinquishes control;
  it never destroys them.
- PostgreSQL stores the logical environment identity, Cube runtime/snapshot
  identity, state generation and an encrypted reconnect capsule. A replacement
  Broker may adopt a machine only after validating tenant/user ownership, Cube
  metadata, physical runtime identity and the newer authority epoch. Adoption
  rotates the guest handoff authority before any terminal or Agent Tool call.
- If adoption cannot be proven, PiCloud reports `recovery_required`; it never
  silently creates an empty replacement and claims the old root filesystem or
  processes survived.
- The maintained one-host contract is node-affine full-VM durability. Cross-node
  recovery may be claimed only after Cube's snapshot bytes are replicated to a
  shared store and restored on another compute node in a measured acceptance
  test.
- The exclusive directory browser reads the live guest filesystem. It shows
  directories and ordinary files, including empty directories, and never uses a
  historical Session as its source. Paths are canonicalized in the guest;
  traversal and symlink escapes are rejected.
- The exclusive guest contains no model, PostgreSQL, Kafka, CubeAPI, Tool Broker
  or object-store credentials. Tool Broker remains the external authorization
  and fencing boundary. An in-guest helper is transport, not authority.
- Administrative/root access is an exclusive-environment policy only. Elastic
  Agent Sandboxes retain the non-root immutable tool policy. Enabling root in an
  exclusive guest must not grant another tenant's identity or a platform
  credential.

## Consequences

The product now has two intentionally different durability contracts instead of
one overloaded `persistent` flag. The UI must call them elastic Workspace and
exclusive machine, not two variants of the same Workspace Sandbox.

Full-VM snapshots are larger and more node/storage sensitive than Volume-only
Workspace persistence. Pause and snapshot latency, storage usage and recovery
failure are visible machine lifecycle states rather than hidden inside a Run.

The previous behavior that destroyed every development environment from
`ToolBroker.close()` is invalid. Directory selection, restart recovery and
release acceptance must cover `/etc` or another guest-root marker in addition
to `/workspace`, and must prove Session archival does not change machine state.
