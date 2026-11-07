# ADR-0299: Cube v0.7.3 and source resource observations

Status: accepted; adaptation in progress.
Date: 2026-11-07. Tracking: [Issue #6](https://github.com/cookerpapa/pi-cloud/issues/6).

## Version and scope

Upgrade the fixed upstream base to official CubeSandbox v0.7.3, commit
`4411c96ba8658a959de34693f54f4918db2a432f`. The official release was rechecked
on 2026-11-07; newer master work is not the deployment target. Rebase the existing
PiCloud contracts on this release and remove dependency patches already provided
upstream. Keep only changes still needed by the maintained execution contract.
The runtime-build manifest and its patch hashes remain the build authority.

This is a matched update, not a rolling mixed-protocol experiment. Drain Session
writers and retire old compute through the existing confirmed-absence boundary.
Preserve persistent Workspace Volumes, accounts, configuration and credentials.
Do not delete Volume ownership to make a template or VM upgrade appear successful.

## Resource metrics evaluation

The upstream release includes the source-side `/v1/metrics/resource` endpoint.
Its collector caches current observations. Host-sandbox measurements include
VMM overhead; guest-workload measurements have their own capability and epoch.
These are separate scopes, not values to add together. CPU counters, current
memory and configured limits are observations, not a durable invoice history.
Pause has no sample; deletion removes series. Silence is neither zero usage nor
proof that a VM was destroyed. CubeMaster notifications are also not a billing
ledger: their delivery/retention contract does not preserve every physical interval.

Adopt upstream observations rather than implementing another CPU/memory agent.
Issue #7 separately records source-confirmed allocation intervals for the chosen
allocated-specification pricing model. Existing allocation-journal deadlines do
not establish physical start/stop timestamps. Unknown tails stay uncertain.
Issue #8 handles persistent Workspace capacity, which is not the VM system disk
or Cube's optional cubecow backend storage statistics.

## Contracts retained

- Whole fixed Tools execute in Cube; only Worker Harness processing makes a
  canonical Tool Result. Boot-scoped reply transport and explicit UNKNOWN remain.
- Tool admission checks actual VM/boot and ordered operation position. No PG
  per-Tool lease polling or replay of arbitrary shell work is introduced.
- Native cancellation stops only the unfinished Tool's process group.
- Allocation closure prevents delayed creates from reopening old identities.
  Verified old absence precedes replacement. Ordinary Tool failure does not
  authorize VM destruction.
- Closure also joins native pause-snapshot cleanup before reporting completion.
  A paused VM has no running process but retains a recoverable package and Master
  binding. Use upstream pause deletion on the allocation's recorded node, resolving
  its current address by stable node ID. Failure keeps cleanup pending; it never
  permits dropping ownership or silently accepting an orphan snapshot.
- Versioned Volume references and deletion admission protect shared Workspace
  bytes across lost replies and node replacement.
- Cubelet alone owns finite elastic idle expiry. Dedicated machines do not expire;
  management retains user intent and explicit lifecycle/recovery policy.

## Validation

Review each existing patch against the new source, compile the affected Go/Rust
components and run maintained admission/allocation/cleanup regressions. Build
pinned artifacts, repair the recorded OS dependency findings without vulnerability
exceptions, and perform matched real Tool/cancellation/VM recovery acceptance.
Verify original Workspace bytes and configuration after compute replacement.
Record actual patch disposition and any unsupported metric/template capability
in the delivery report; a successful patch application is not runtime acceptance.

References: [release](https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.7.3),
[resource metrics](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/docs/guide/resource-metrics.md),
[Volume plugin](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/CubeMaster/pkg/volume/plugin/plugin.go).

## Source adaptation record

The previous 15-file patch series is consolidated into four responsibility groups:
observations/whole Tools, allocation/Volume lifetimes, node-routed template cleanup,
and pinned build/dependency maintenance. Shared protocol additions now live once
in upstream `pkgs/proto`; custom migrations use `pkgs/cubedb`. Old per-component
protocol copies and the old CubeDB/cubelog package dependencies are removed.

The former dependency patches are consolidated using the greater of upstream and
maintained fixed versions, followed by module tidy; unused dependencies disappear.
CubeMaster's newer artifact deletion ownership stays with TemplateCenter. The
node-routing tests now exercise that handoff instead of resurrecting the removed
master-local deletion hook. Managed allocation ID validation precedes native
same-ID resume, with a regression for mismatched resume IDs.

Source checks have passed on the isolated port: native admission/race contracts,
allocation and Volume tests, selected composed Cubelet lifecycle tests, CubeMaster
compilation and node-routed cleanup tests, shared protocol compilation, and the
Rust observation regression. The four patches reproduce all 91 modified files
from a clean pinned upstream export. This is source evidence, not a deployed
upgrade or a passed full artifact/live acceptance.

## Complete native release closure

The v0.7.3 chart introduces mandatory CubeTemplateCenter. It imports the patched
CubeMaster library, builds rootfs artifacts and owns artifact data deletion after
Master's reference/node cleanup. Build it from the same patched export and fixed
Go/Ubuntu/APT inputs as Master; the matched custom-artifact set is fourteen.
The same chart requires CubeOps for Cubelet node registration. Enable that
upstream internal component while keeping its WebUI disabled and its optional
component warehouse unconfigured. It adds no PiCloud execution or storage
authority and requires no new object store.
Official Cube bootstrap/runtime dependencies remain separately inventoried by
version, immutable registry digest and local image identity. The fourteen custom
image scans do not stand in for that upstream dependency inventory.

Reconciliation starts from the new pinned chart defaults and preserves explicit
installed values, then applies the maintained native policy. Never carry forward
old chart defaults with `--reuse-values`. Keep the current Pod network, existing
Master artifact volume and persistent Workspace host root. Disable newly defaulted
MinIO and unused S3lvol; TemplateCenter uses the shared filesystem backend and is
colocated with Master. The removed network-agent container is not retained as a
compatibility path; Cubelet remains the host Workspace consumer.

Render the full pinned chart, including its new keys, against the explicit
installed values and private post-render inputs during preparation and verify it
again before draining any writer/VM. Save manifests only inside the private
candidate. Pin each upstream image to its resolved digest in the post-rendered
manifest and import those verified identities before native cutover. Refresh the
operator CLI from the matching pinned CLI image after its Pod becomes Ready; do
not relabel an old binary by merely updating cluster metadata. Retain ordinary
writer drain, confirmed physical absence and both original Workspace/machine
intents throughout the matched update.
