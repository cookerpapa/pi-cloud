# ADR-0118: Session, Workspace and execution-environment independence

## Status

Accepted on 2026-08-23.

## Context

The first product UI coupled a conversation to one Workspace and exposed two
overlapping process-lifetime concepts: a persistent conversation Sandbox and a
separate development-environment page. It also required every conversation to
be deleted before its Workspace bytes could be removed. That made the most
valuable knowledge object—the Pi conversation—subordinate to replaceable files
and compute.

CubeSandbox provides two separate primitives. A Sandbox is a KVM execution
world whose memory and processes may be paused or lost. A Volume is a durable
filesystem that can be attached to another Sandbox. They must not be presented
as one resource merely because they appear together at `/workspace`.

CubeProxy offers authenticated HTTP/WebSocket port routing, while Cube's PTY
API offers an interactive shell. It does not provide a tenant authorization
contract for exposing an ordinary Sandbox's port 22 directly.

## Decision

- A Session owns Pi conversation history and tree relations. It survives
  Workspace deletion and execution-environment release.
- A Workspace owns durable project bytes. Deleting it soft-deletes the Volume
  authority only after active writers settle. Referencing Sessions remain
  readable with `workspaceState=missing` and can be rebound to another live
  Workspace through an idempotent operation.
- The Agent Harness treats the Workspace binding as execution World State,
  separately from the content revision and the physical Cube identity. A
  rebind appends one hidden, model-visible `workspace_changed` fact before the
  next provider request. It states that the previous Workspace is unavailable
  to the current Tool environment and that `/workspace` now represents another
  binding; tenant, Workspace, Run and Activation identifiers never enter model
  context.
- Recreating Cube around the same persistent Workspace emits `sandbox_reset`
  and preserves the file-continuity claim. Rebinding to another Workspace
  emits `workspace_changed` instead, so the Harness never claims that the old
  files survived. The persisted binding fingerprint, not a path or content
  hash, distinguishes two different Workspaces that both mount at
  `/workspace` or currently contain identical bytes.
- PiCloud never speculates that an old Workspace may exist at another path. A
  future multi-Workspace environment may expose such a path only when Tool
  Broker explicitly authorizes that mount and supplies a verified binding and
  revision as World State.
- An elastic execution allocates Cube on first Tool use and may keep it warm for
  a bounded idle period. Reclamation loses processes, not Workspace bytes.
- An exclusive execution environment is a user-owned Cube resource with a
  deployment-owned size profile. It binds one persistent Workspace Volume. An
  Agent Run and a human terminal borrow the same Cube through a fenced,
  serialized Tool Broker handoff; two VMs never write that Volume concurrently.
- Environment pause/resume/release controls live in the new-conversation and
  conversation surfaces. There is no separate tenant development-environment
  page. Releasing compute preserves both Session and Workspace.
- HTTP preview remains a same-origin authenticated proxy. Port 3000 or 8000 is
  meaningful only when an application listens on `0.0.0.0` inside the live
  Cube; the UI probes and explains an absent listener instead of exposing a raw
  502/503 page.
- Native OpenSSH access terminates at a trusted PiCloud SSH gateway. The user
  obtains a one-use, five-minute ticket through the authenticated conversation
  API. The gateway consumes it atomically, rechecks environment ownership and
  bridges the SSH channel to the existing Tool Broker PTY. Cube port 22,
  Sandbox IDs, traffic tokens and control credentials are never public.
- Teleport was considered for SSH access. Its identity proxy, certificates,
  reverse tunnels and audit plane are appropriate for a broader enterprise
  infrastructure estate, but would duplicate PiCloud's existing tenant
  identity and PTY broker for this single bounded route. The maintained gateway
  therefore uses the mature `ssh2` protocol implementation behind a PiCloud-
  owned ticket/terminal adapter. Teleport remains a deployment-level option if
  SSH becomes a general resource-access plane.

## Consequences

Deleting files can no longer erase or archive conversation knowledge. A
rebound Session intentionally keeps its Pi context while the model-visible
world state reports that the Workspace changed.

The binding fact is part of Pi's native Session history and therefore follows
the same PostgreSQL, compaction and cross-Worker recovery path as other hidden
Harness facts. Repeated context hooks and later Turns on the same binding do
not append it again.

An exclusive Cube feels like a small development VM during normal use, but the
durability claim remains precise: memory/process preservation depends on that
Cube; Workspace files and conversation history have separate authorities.

The SSH gateway is reachable only on the operator-configured bind address. The
one-host default is loopback. LAN or public exposure requires an explicit bind,
firewall and host-key trust policy; Cube management endpoints remain private.
