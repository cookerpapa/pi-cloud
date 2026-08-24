# ADR-0117: Persistent terminal handoff, private preview and development profiles

## Status

Accepted.

## Context

The first development-environment UI allocated one fixed Cube template. The
conversation terminal also destroyed an idle warm Cube before opening a second
terminal-only VM. That preserved the single-writer rule but violated the user
meaning of a persistent sandbox: background processes and `$HOME` disappeared
merely because the owner opened a terminal.

CubeProxy issues a per-Sandbox traffic token when public traffic is disabled,
but cross-node routing requires each application port to be declared in the
immutable template. Reserving every possible development port is neither
supported nor operationally sound. Cube does not expose a tenant-safe raw SSH
endpoint for ordinary Sandboxes.

## Decision

- An idle persistent conversation Cube is rebound to a short-lived human
  terminal authority, not replaced. The previous Agent capability stays
  revoked. Closing the PTY snapshots the boundary, returns the same physical VM
  to the persistent warm pool and preserves background processes.
- Every Agent-to-warm, warm-to-terminal and terminal-to-warm handoff advances
  the Session fence in PostgreSQL. Tool Broker changes the external owner
  reservation without starting a Tool Worker or killing user processes. Old Supervisor
  cleanup requests therefore fail identity validation instead of deleting the
  current warm VM.
- Broker-owned warm runtimes are excluded from Supervisor assignment inventory.
  Terminal-Run orphan cleanup measures its grace period from durable settlement,
  avoiding a race with normal checkpoint/release.
- A Workspace still has one writer. New Agent Runs remain queued while a human
  terminal owns the Cube; an idle exclusive environment can instead lend that
  same Cube to one Run under a rotated authority.
- Browser previews use a PiCloud-authenticated path. Control Plane verifies the
  tenant/user target and Tool Broker resolves the live handle. The Cube provider
  uses the sole private envd ingress to launch an unprivileged one-shot HTTP
  helper, which reaches the guest-local application and exits. Neither CubeAPI
  credentials, Sandbox IDs nor traffic tokens reach the browser or helper.
- Preview supports bounded HTTP bodies and response sizes. WebSocket ingress and
  raw TCP are separate contracts. Any unprivileged guest port except envd is
  reachable without a fixed template reservation; applications bind localhost
  or `0.0.0.0`. The product does not call the Web terminal "SSH".
- User-owned development environments select one deployment-owned profile:
  starter (1 vCPU/2 GiB/8 GiB), standard (2 vCPU/4 GiB/16 GiB), or performance
  (4 vCPU/8 GiB/32 GiB). Each profile maps to an immutable Cube template built
  from the same trusted tool image. The user cannot supply a template ID or
  arbitrary VM resources.
- Environment allocation, profile selection, pause/resume/release, Preview,
  Terminal and SSH are part of the conversation resource flow. The former
  standalone development-environment page has been removed.
- A fenced Agent Run may borrow the same exclusive Cube after Tool Broker
  proves there is no active human terminal. It returns the Cube to its
  user-owned authority at Run settlement instead of starting a second writer.
- Cube's standard cube-agent/vsock/envd path is the only resident guest control
  channel. PiCloud Tool Workers are short-lived uid-1000 processes; all durable
  authority and fencing remain outside the VM.

## Consequences

Persistent conversations now preserve a process world across Agent Turns and
owner terminal reconnects, but not across Tool Broker/Cube loss. Persistent
Workspace bytes remain the stronger durability boundary.

PiCloud's public HTTP binding remains loopback by default. Operators may bind it
to a LAN address or publish it behind an authenticated TLS reverse proxy. Cube
management endpoints remain private in either mode.
