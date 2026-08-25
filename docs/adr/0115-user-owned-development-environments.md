# ADR-0115: User-owned exclusive development environments

Status: accepted; amended on 2026-08-25

## Context

CubeSandbox's cluster WebUI is an operator console: it exposes the fleet,
templates, nodes and every Sandbox. PiCloud needs a tenant-aware product
surface where an ordinary user can request one isolated Linux environment and
see only environments they own. Giving browsers Cube credentials or filtering
the Cube inventory in frontend code would not establish an authorization
boundary.

The existing Workspace terminal creates a short-lived Cube for one WebSocket
and destroys it on disconnect. Persistent Agent retention keeps a Run-created
Cube warm, but it is still owned through Run/Attempt authority. Neither is a
user-owned development-environment lifecycle.

## Decision

- Add a PiCloud `DevelopmentEnvironment` resource owned by
  `(tenant_id, owner_user_id)` with one private machine Volume represented by
  an internal Workspace identity.
- PostgreSQL owns the product allocation, idempotency and user visibility.
  Cube owns the live process/memory state; the persistent Workspace Volume
  remains the sole file-byte authority.
- Only Tool Broker may call CubeAPI. The browser uses authenticated PiCloud
  REST and WebSocket endpoints and never receives Cube IDs, traffic tokens or
  control credentials.
- A live allocation has one Cube KVM and one Workspace writer. A human terminal
  keeps Agent Runs queued. Otherwise Tool Broker may seal the current boundary,
  rotate authority to one fenced Agent Run and return the same Cube after
  settlement. No second Cube writes the Volume.
- Support explicit `start`, `pause`, `resume` and `release` operations. Pause
  uses Cube's memory/filesystem snapshot lifecycle; resume reconnects the same
  Sandbox identity. Release destroys the VM and its machine-owned Volume while
  preserving independently stored conversations.
- The environment terminal opens a PTY inside the existing KVM. Disconnecting
  kills only that PTY; it does not release the environment.
- One Workspace has at most one live development environment. Tenant and
  Sandbox-Domain capacity accounting includes these environments.
- Tool Broker ownership remains leased. A replacement Broker may adopt the same
  machine only after its encrypted reconnect capsule, PostgreSQL ownership and
  physical Cube metadata agree; ambiguous state fails closed rather than
  silently creating a replacement and claiming process continuity.
- Environment templates, resource limits, networking and UID remain
  deployment-owned. Users choose a machine profile, not an arbitrary image,
  PodSpec or privileged runtime policy.

## Consequences

- From the user's perspective the environment behaves like a small managed
  development VM: an independent kernel, persistent files, long-lived
  processes, pause/resume and an interactive terminal.
- It is not a second Workspace authority or a general cloud-instance API.
- SSH is a separate trusted ticket gateway over the same PTY, not a public
  Sandbox port or a parallel execution path.
