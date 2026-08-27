# CubeSandbox execution provider

## Current role

CubeSandbox KVM is Pi Cloud's only untrusted Tool runtime. The trusted Pi
Worker owns the Agent Loop and model credential; the Tool Broker owns execution
admission and Cube lifecycle. The guest owns neither.

```text
Pi Tool call
  -> trusted Tool adapter
  -> Tool Broker (Run/Attempt/lease/fence/Step validation)
  -> Cube API
  -> CubeProxy -> cube-agent/vsock/envd
  -> credential-free one-shot Tool Worker
  -> bounded result
  -> Pi Agent Loop
```

There is no Docker, gVisor, local-process or model-selectable runtime fallback.
The `SandboxProvider` interface in code is a narrow Cube adapter boundary, not
a supported production runtime menu.

## Identity and authority

The Tool Broker derives tenant, Workspace, Session, Run, Attempt, fence,
activation and Cloud Step identity from trusted state. The browser, model and
Tool arguments cannot choose a Sandbox ID, image, mount, resource limit or
network policy.

Each operation has an immutable operation ID. Duplicate delivery returns the
same in-process result while it is known; conflicting reuse fails closed. A
transport break after dispatch is `UNKNOWN` and is never reattached or replayed,
because envd is deliberately not a durable PiCloud operation ledger. A stale
Attempt cannot start another Tool or advance Workspace state.

The Worker never receives Cube management credentials. Cube receives no model,
PostgreSQL, Kubernetes, Volume-gateway or Cube-control
credential.

## Workspace and process lifetime

One tenant Workspace maps to one stable persistent Cube Volume. Only the
`workspace/` child of its trusted Volume envelope is mounted into the guest as
`/workspace`; platform generation and Git-baseline metadata stay outside the
guest view.

At a fenced settlement boundary, the trusted Volume gateway flushes the
Workspace and records a bounded file/hash/Git revision. PostgreSQL advances the
Workspace revision with compare-and-swap. This operation does not create a
second archive of all Workspace bytes.

A disposable Cube activation may remain warm for one deployment-bounded TTL.
Its processes, sockets and PTYs survive only while that exact activation
survives. After destruction or failure, a new KVM reattaches the same Volume and
recovers files, not RAM or process state. Warm retention is an optimization,
never a conversation or Workspace durability dependency. User-owned development
machines use the separate pause/resume/release lifecycle and never enter the
elastic warm pool.

Cube's absolute timeout is disabled for every Broker-managed activation. The
Broker is the sole lifecycle authority: an active multi-Turn Session is never
killed merely because its VM is old, while an idle elastic activation is
destroyed after `PI_CLOUD_SANDBOX_WARM_TTL_MS`. Broker restart reconciliation
recovers or retires recorded activations instead of depending on a competing VM
timer.

## Tool and terminal channels

Agent file and shell Tools use Cube's private envd data plane. The Web Terminal
uses a separate short-lived human reservation through the same external Tool
Broker:

```text
authenticated browser WebSocket
  -> Control Plane
  -> Tool Broker
  -> CubeProxy -> envd
  -> unprivileged PTY in /workspace
```

A human terminal and an Agent Run cannot write the same Workspace at the same
time. Standard SSH is terminated by PiCloud's trusted ticket gateway and
translated into this PTY protocol; Cube port 22 remains private. Envd is the
single generic guest agent and holds no PiCloud, model or database credential.

## Network policy

The guest has no route to platform services. Optional public HTTP/HTTPS egress
crosses a deployment-owned proxy that resolves targets and rejects loopback,
private, link-local, metadata, Kubernetes and platform destinations. A
deployment may separately add bounded RFC1918 CIDRs to Cube `allowOut`; these
destinations bypass the proxy through `NO_PROXY` and are reached directly from
the guest. No tenant-controlled request may expand that list.

## Template and resource policy

The deployment-owned immutable template supplies the language toolchain,
Cube's envd and the one-shot Tool Worker code. Elastic Agent Tools use the fixed non-root user. An
exclusive machine's authenticated human terminal/SSH channel may start as guest
root; KVM and the absence of platform credentials are then the tenant boundary.
Users cannot submit a template,
kernel, device, host mount, privileged flag or network policy. Cube, Tool Broker
and the short-lived Worker enforce bounded CPU, memory, process count, open
files, output and execution time.

Template retention deletes only superseded Pi Cloud templates after proving no
active Sandbox references them. It does not touch tenant Workspace Volumes or
Pi Session records.

## Reconciliation and evidence

PostgreSQL records desired activation identity and fenced ownership. Tool
Broker periodically reconciles that state with Cube inventory. Destruction is
qualified by both logical activation and physical runtime identity, so an old
cleanup request cannot delete a newer KVM.

Verification includes:

```bash
npm run cubesandbox:template-check
npm run cubesandbox:live-check
npm run production:check
```

The live gate is required for claims about guest identity, credentials,
cross-tenant file isolation, configured private-network reachability, public proxy behavior,
timeout/cancellation, persistent Volume reattachment and orphan cleanup. The
one-host profile still shares one physical host and does not claim host or Cube
administrator compromise tolerance.
