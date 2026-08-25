# ADR-0118: Session, Workspace and execution-environment independence

## Status

Accepted on 2026-08-23; amended on 2026-08-25.

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
  authority only after active Agent and terminal writers settle; Tool Broker
  then removes both POSIX bytes and Cube Volume metadata. Referencing Sessions remain
  readable with `workspaceState=missing` and can be rebound to another live
  Workspace through an idempotent operation.
- The Agent Harness treats the Workspace binding as execution World State,
  separately from the content revision and the physical Cube identity. A
  rebind appends one hidden, model-visible `workspace_changed` fact before the
  next provider request. It states that the previous Workspace is unavailable
  to the current Tool environment and that `/workspace` now represents another
  binding; tenant, Workspace, Run and Activation identifiers never enter model
  context.
- Renewing an Agent Tool lease on the same physical Cube does not emit a reset.
  Recreating Cube around the same persistent Workspace emits `sandbox_reset`
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
- An exclusive execution environment is a user-owned full Cube machine with a
  deployment-owned size profile. Its complete guest state follows ADR-0120; a
  mounted Volume is no longer the definition of its durability. An Agent Run and a human
  terminal borrow the same Cube through a fenced, serialized Tool Broker
  handoff; two VMs never write that Volume concurrently. Several conversations
  may select different directories beneath that Volume; Workspace single-writer
  admission still serializes their mutable Runs.
- Workspace creation/deletion and environment create/pause/resume/release live
  on a dedicated user resource page. The new-conversation dialog only selects
  elastic versus exclusive execution and progressively discloses the relevant
  Workspace, machine specification, environment and directory choices. Releasing
  an exclusive machine deletes its machine-owned Volume but preserves the
  Session, which becomes readable with `workspaceState=missing` until rebound.
- HTTP preview remains an authenticated proxy. Applications may use any
  unprivileged port except envd and bind localhost or `0.0.0.0`; Tool Broker
  verifies the listener, and the trusted `preview` Tool returns the authenticated
  conversation route without exposing Cube routing authority to the model.
- Native OpenSSH access terminates at a trusted PiCloud SSH gateway. The user
  obtains a one-use ticket through the authenticated conversation API. An
  unused ticket expires after 24 hours by default; the gateway consumes it on
  first successful authentication, rechecks environment ownership and bridges
  the SSH channel to the existing Tool Broker PTY. Cube port 22, Sandbox IDs,
  traffic tokens and control credentials are never public.
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

An exclusive Cube is a node-affine development VM. Cube pause preserves its
rootfs, memory and processes; conversation history remains a separate authority.
Cross-node VM recovery is not claimed until Cube provides replicated snapshots.

The SSH gateway is reachable only on the operator-configured bind address. The
one-host default is loopback. LAN or public exposure requires an explicit bind,
firewall and host-key trust policy; Cube management endpoints remain private.
