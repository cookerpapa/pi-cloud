# Recoverable VM allocation — 2026-10-04

## Result

[ADR-0223](../adr/0223-recoverable-vm-allocation.md) implements durable physical
allocation identity, reply recovery and irreversible closure. PostgreSQL stores
the immutable creation configuration and authorization before calling Cube.
Cube persists a fixed VM/node/boot before dispatch; the node persists admission
before native creation. Retrying the allocation returns its original result.
Closing excludes later creation and joins an accepted creator before confirming
physical absence. Missing routes or replies never count as absence.

Workspace runtimes, dedicated machines and independently allocated terminals use
the same contract. Late PG activation cannot reopen a closed allocation. An
unconfirmed node remains UNKNOWN; another physical lifetime needs a new identity.
There is no new scheduler, per-Tool PG ledger, Agent Loop modification, Workspace
checkpoint or shell replay. Closed receipts have bounded retention and expired
authorization remains invalid after receipt collection.

## Verification

| Gate | Evidence |
| --- | --- |
| Whole repository | `npm run check` passed: 1,739 assertions including 63 acceptance helpers; nine opt-in external-service assertions skipped |
| Final lifecycle repository | All 18 real PostgreSQL assertions passed after adding terminal late-activation protection; the new regression failed before the fix |
| Cube allocation | Nine race/persistence tests passed against the pinned exported source, real Bolt metadata and disposable MySQL |
| Existing Cube execution | All 15 admission/cancellation contract tests passed |
| Fault suite | [178/178](vm-allocation-faults-20261004.md), including frozen creation, lost replies, closure and legacy uncertainty |
| Preview repair | Nine preview/connection assertions passed; the global-proxy regression failed before the fix |
| Final release helpers | All 63 passed, including deterministic rendering, configuration identity and mounts |
| Static/build | Workspace types; final Sandbox/Control Plane types; documentation, runtime policy, formatting and matching native/application/template builds |

The whole-repository and fault commands ran on the implementation worktree before
its first commit; their reports correctly retain that dirty revision. Later
terminal, renderer and preview repairs have the targeted passing reruns above.
These overlapping counts are not an additional aggregate assertion total.

## Live acceptance

[Native Cube evidence](vm-allocation-native-20261004.json) covers three real cases:

1. Drop the successful HTTP creation response. Query the original allocation,
   reuse its VM/node/private-ingress identity, and successfully run a guest command.
   Duplicate Create does not allocate another VM. Close confirms node absence;
   the delayed original Create is rejected.
2. Close before the original Create reaches Cube. The later Create is rejected.
3. Observe Master placement in `creating`, then Close. Cleanup reaches node
   absence and a later Create is rejected. The deterministic node test separately
   holds an accepted native creator in flight to verify Close joins it.

[Control Plane crash evidence](vm-creation-recovery-20261004.json) uses GPT-6 Luna.
After PG creation intent exists but before a runtime capsule exists, SIGKILL the
Control Plane container. The test verifies exit 137, restart and readiness;
the original allocation is recovered without extending its authorization. The
original Run fails and is not rerun. Its test file has zero writes. A fresh Luna
Run successfully uses Bash on that same physical allocation. Exactly one
Workspace allocation exists, and the owned Session/Workspace is cleaned up.

[Dedicated-machine acceptance](vm-allocation-development-20261004.json) passed
real Luna repair/reverification, shared and separate-compute Subagents, shared
home bytes with independent system disks, same-port preview isolation, terminal
reconnect, SSH, Control Plane replacement, pause/resume and old-pause replay.
The VM identity, root filesystem and background process survived the expected
lifecycle operations. Release removed the VM and Cube Volume metadata while
the conversation survived with a missing-Workspace state. Test Sessions were
then removed.

[Final deployment inventory](vm-allocation-rollout-20261004.json) confirms schema
174, managed Cube protocol 6, Guest protocol 3 and synchronous node metadata.
Native/API/authorizer images use `vm-allocation-v6`, applications
`vm-allocation-v6-app2` (source `f0778de4`), and Control Plane
`vm-allocation-v6-cp3` (source `d509a3ae`). Renderer corrections are in `9a4f3a8e`;
the final live harness is `4258621c`. All listed replicas are ready. There are
zero pending/active Runs, unsealed issued Runs, active leases, live Workspace
runtimes, development machines, terminals or observed Cube VMs. No new UNKNOWN
allocation remains. The two historical untracked UNKNOWN allocations remain held.

## Deployment findings and fixes

The initial native startup rejected upstream's `no_sync = true` Bolt setting.
The declarative renderer now requires synchronous metadata, and the native guard
remains enabled. A renderer newline defect was caught during that correction;
the regression now retains the following TOML section. The actual rendered TOML
was parsed and its synchronous setting verified before restoring admission.
The startup wait timed out once; deployment resumed from that checkpoint after
the node was ready. Business data was not reset.

The broad development-machine check then exposed a preview failure. Direct guest
TCP and direct authenticated CONNECT both worked. In the Control Plane container,
the same private CONNECT hit the configured egress proxy: enabling the environment
proxy returned 403; disabling it reached the owner and returned its expected 401
for an unauthenticated diagnostic. Node's documented `NO_PROXY` formats include
IP ranges but not the CIDR values configured for the Pod network.
[Node HTTP proxy documentation](https://nodejs.org/api/http.html#built-in-proxy-support).
Preview now uses explicit direct HTTP/HTTPS agents for the PG-resolved internal
owner; external provider/Internet proxy settings remain in force. Earlier failed
preview fixtures released their owned machines.

The next broad run exposed a fixture race after Control Plane replacement:
global readiness and PG's retained `running` state preceded local adoption of
the specific machine. A read-only directory readiness check now precedes the
terminal command. The machine subsequently adopted successfully, and the failed
fixture's release was retried through the normal API. The final complete run
passed; no terminal command is replayed after an uncertain execution.

## Limits

This is a single-host K3s/Cube acceptance, not physical multi-node HA or a
power-failure experiment. A missing node journal after an unfinished prior boot
remains uncertain and needs physical reconciliation; the system does not silently
recreate the VM. Historical UNKNOWN resources without the new authorization are
not retroactively proved absent. Existing broad Cube Volume-reference drift and
superseded-template cleanup timeouts remain separate backlog items. Synchronous
node metadata adds lifecycle I/O; fleet-scale latency is not established here.

Rollback requires a drained, matched native/application/database restore as
specified by ADR-0223. Mixed protocol versions are rejected.
