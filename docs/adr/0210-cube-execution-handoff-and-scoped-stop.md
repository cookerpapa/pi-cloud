# ADR-0210: Cube execution handoff and native timeout cleanup

Status: deployed and verified under the owner's accepted ADR-0209 cutover,
2026-10-01. See [isolated acceptance](../reports/cube-execution-authority-20261001.md)
and [production acceptance](../reports/cube-execution-rollout-20261001.md).

Chat Stop follows [ADR-0220](0220-agent-stop-is-not-process-control.md). It never
invokes native process cleanup; the kernel mechanism below is for native Tool
timeout and executor shutdown. ADR-0219 bounds destination admission state.

## Decision and evidence

Reuse Cubelet's containerd execution lifecycle for fixed Tool takeover, and the
existing guest kernel's cgroup v2 for operation-scoped stopping. Do not fork Pi's
Agent Loop or add a second distributed task scheduler. The original Cube/E2B/
OpenSandbox survey is recorded in
[the comparison](../reports/cube-result-delivery-study-20261001.md).

Two owned, short-lived VMs were checked against the installed Cube template.
The guest exposes writable cgroup v2 to its trusted root infrastructure. Killing
one test cgroup stopped its deliberately detached `setsid` descendant; another
group's HTTP server continued responding. Both test VMs were deleted afterward.
This establishes a usable kernel primitive, not a completed dispatch protocol.

The [Linux cgroup v2 contract](https://docs.kernel.org/admin-guide/cgroup-v2.html)
provides tree-wide killing and a populated-state check, including concurrent fork
handling. Use this existing primitive; process-group signals alone are insufficient
for descendants which detach into another Unix session. Require the verified
cgroup capability in the guest contract rather than silently falling back.

## Execution ownership

- Cubelet accepts a bounded command identified by physical runtime, executor boot
  and operation ID. It owns execution through the native process exit and final
  delivery. The Projector waits for bounded takeover, not Tool duration. The
  original intent is already durable in Kafka before dispatch.
- Use native containerd exec/process handles and local bounded concurrency.
  Operation identity/deduplication is boot-scoped; uncertain execution never
  causes automatic shell replay. No PG Tool ledger or completed-result GET/cache
  is introduced.
- A trusted guest launcher enters an operation-specific cgroup before launching
  the fixed Tool under UID/GID 1000 with existing privilege restrictions. Keep
  the original parent cgroup's resource accounting. A small root-owned scope
  locator may record the cgroup path; it contains no transcript or Tool result.
- On an explicit Tool timeout, stop and join its native main process
  first, then killing the entire recorded cgroup and confirming it is empty.
  Joining the main process first prevents a delayed launcher from creating new
  children after a premature empty-group observation.
- Ordinary completed Bash may intentionally leave a development server running.
  Preserve these completed background processes. Native timeout/cancellation
  must carry explicit transport metadata requesting scope cleanup; do not infer
  cancellation from arbitrary error text or kill every unsuccessful Bash's
  background work.
- Bound scope/dedup state. Do not evict evidence in a way that lets the same
  accepted operation execute again. Exhaustion rejects admission explicitly.
  ADR-0219 uses per-VM partition progress instead of closed task lists;
  confirmed native VM absence retires that VM's progress. Guest locators
  serve active scoped stopping, not another durable operation ledger. After the
  launcher leaves its cgroup, remove empty groups and locators; completed
  background groups are pruned only once empty. Thus repeated successful Tools
  do not exhaust the kernel's active-group bound.

Guest Tool transport version 2 requires `scopeStopRequired` on final operation
frames. It is true for the native execution signal's timeout/cancellation and
remains outside the native Tool Result. Ordinary nonzero Bash exit does not set
it. Old guest frames are not accepted after the matched template cutover.

The installed Cube agent does not create pipes for non-terminal exec. Reuse its
supported native PTY transport in explicit raw mode, with a ready frame before
sending input and a receipt before the launcher exits. This is the single fixed
guest transport, not a fallback. The receipt prevents native process reaping
from racing unread final output; it acknowledges bytes only, not Kafka durability
or successful Tool execution. Input, output and receipt waits are bounded. No
Cube agent/shim fork is needed for pipe support.

PG-authorized closure revokes publication and binding routing admission before
appending the seal (ADR-0220). It does not join or cancel accepted Cube processes.
The Worker aborts its Agent Loop and stops waiting for native replies. Interactive
workflow channels close with their caller; external Tool effects may continue.

Closure marks the existing Run binding as closed for
dispatch in PostgreSQL. Quarantine closes every binding of that exact physical
target in the same transaction as its resource state change. ADR-0212 replaces
the original per-Tool binding SELECT with a partition-owner memory view. PG
retains closure admission and recovery; acknowledged revocation requires a
synchronous owner barrier, not merely eventual delivery of a close notification.
Bootstrap reloads current closure before routing. This is not a Run/lease
revalidation, per-operation ledger, or another fencing authority.
Commands whose lookup preceded closure remain potentially in flight; native
execution proceeds independently of the Agent and its result may remain unknown.

## Results and failure

The control plane materializes the runtime at the Worker's existing lazy Tool
binding hook, before publishing the first Tool intent. Pure-chat Runs still do
not allocate a VM. Store one bounded immutable execution descriptor per Run
binding: recorded Cube/node/boot, fixed guest initialization and binding recovery
metadata. It is not a per-operation task ledger. The Projector reads it
and hands fixed Tools directly to Cube; it never waits for VM provisioning.
Elastic runtimes receive the same bounded encrypted recovery capsule as machines.
Controller restart preserves VM processes and accepted Cube executions. A new
controller adopts resource ownership after the old owner's management lease ends;
the historical Worker assignment in the VM capsule is physical provenance, not
authority to terminate every user sharing that VM.
Retire the old borrowed-machine rows from Workspace runtime storage: machine
ownership remains in `development_environments`, and Run bindings are represented
only by the new binding descriptors. Count physical allocations once, including
a terminal sharing an existing Workspace runtime. An orphaned terminal channel
does not authorize destroying that shared VM.
Kafka partition ownership is independent of Sandbox Domain. Descriptors therefore
identify the Cube API endpoint as well as node/runtime/boot. Every control-plane
replica dispatches directly using a deployment-owned endpoint credential registry;
descriptor data cannot introduce an unconfigured endpoint. Domain deployments
run the control-plane composition, rather than restoring a separate Broker.

A trusted Cube-side completion adapter reuses PiCloud's existing native-result
validation, image claim check and Kafka reply publisher. S3/PG credentials stay
outside the guest. The original Worker boot's mailbox receives the result and Pi
Harness processing still creates the canonical Tool Result. Progress is lossy
HTTP/SSE and never becomes history.

Completion context carries the native provider Tool call ID separately from the
Pi result Entry ID. Native final/error replies retain the provider ID; temporary
progress addresses the result Entry ID. The unique operation ID matches the
mailbox. These identities must remain distinct even if fixtures happen to use
the same string. Publisher and host-adapter changes require a drained cutover.

The self-hosted installer uses Kubernetes' existing Service/EndpointSlice and
Secret resources for host-adapter connectivity. It creates a namespace-scoped
deployment credential for refreshing those connections and the Cubelet template;
the kubeconfig stays in the ignored, owner-only host runtime directory. No such
credential or completion secret is mounted in a guest. Kafka readiness controls
new Tool admission, not availability of Cube's VM management APIs.

The adapter can retry delivery of an immutable result; it cannot rerun execution.
Bound pending command/result bytes and lifetime. Dispatcher loss after accepted
handoff does not abandon execution or its reply. Executor/node loss is a separate
UNKNOWN case; volatile process maps cannot promise durable result recovery.
Persist the accepted executor boot identity with the runtime recovery capsule.
Adopting a still-running VM must not silently refresh that identity after a
Cubelet restart: outstanding old executions are UNKNOWN until control-plane
recovery proves stopping or replaces the elastic VM. New commands carry the
recorded boot; a different boot explicitly rejects them before execution.
The control plane quarantines affected bindings when stopping cannot be proved.
It decides whether an elastic VM must be destroyed; user-owned machines keep
their explicit release policy. A single normal Tool failure has no VM destruction
authority.

## Acceptance

Exercise duplicate/late handoff, dispatcher restart, executor boot replacement,
result publication failure, image delivery, cancellation during launch, native
timeouts, `setsid` descendants and an unrelated background server in the shared
VM. Preserve terminal, preview, upload, workflow and machine-adoption behavior.
Ship the pinned Cube patch set, guest image, control plane and Worker together;
do not retain an old execution fallback after cutover.
