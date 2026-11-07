# Independent Session runtime and resource accounting

Delivered on 2026-11-07 for Issues [#5](https://github.com/cookerpapa/pi-cloud/issues/5),
[#6](https://github.com/cookerpapa/pi-cloud/issues/6),
[#7](https://github.com/cookerpapa/pi-cloud/issues/7),
[#8](https://github.com/cookerpapa/pi-cloud/issues/8),
[#9](https://github.com/cookerpapa/pi-cloud/issues/9) and
[#10](https://github.com/cookerpapa/pi-cloud/issues/10).

The serving matched release is `runtime-accounting-20261107-r11`, source
`b8631fd00201097a46073441b586185adf8cba01`, application Helm 148,
infrastructure Helm 115 and schema `212_workspace_capacity`.
Fourteen custom artifacts passed the maintained scan gate; seventeen upstream
dependencies have separate immutable image evidence. The gate found no fixable
HIGH or CRITICAL findings. This does not mean that every dependency has no advisory.

## Result and the two evaluation decisions

| Issue | Delivered behavior |
| --- | --- |
| #5 | An independent `metering` process receives model receipts, deduplicates and values them in the single PG accounting ledger. Public statements are served by Session runtime. |
| #6 | Cube v0.7.3 at `4411c96ba8658a959de34693f54f4918db2a432f`, including the patched TemplateCenter, updated operator CLI and five maintained patch groups. Fixed Tool, allocation, cancellation and Volume ownership boundaries remain. |
| #7 | Cubelet measures allocated workload CPU/memory over confirmed intervals. A shared VM has one resource identity. Periodic source receipts feed compute statements independently of management. |
| #8 | XFS project quotas enforce Workspace and upload-staging capacity. Growth has a PG intent/revision and actual kernel acknowledgement. A separate storage source measures enforced capacity over retention time. |
| #9 | `session-runtime` owns API, history/statements, SSE, Worker membership and the sole Session Projector. `control-plane` owns resource intent, lifecycle and recovery. |
| #10 | Worker renewals go directly to PG; local expiry and producer fencing remain. The redundant periodic observer SELECT and socket family-renewal path are removed. Known publication failure aborts the entire native family and its model grants. |

For the first requested evaluation, choose the independent receiver, rather than
giving every provider and resource adapter PG credentials, pricing logic and
financial-schema ownership. Sources retain their existing durable outboxes and
delete receipts only after PG acknowledgement. This adds no second accounting
database or broker. See [ADR-0298](../adr/0298-independent-metering-receiver.md).

For the sixth evaluation, retain direct Worker PG renewal and local expiry.
Renewing through management would make management uptime an execution dependency.
Kafka fencing does not itself observe PG expiry, and an absent manager may not
initiate takeover. There is no additional CLIProxyAPI fencing cache. Silent PG
revocation is learned on the next renewal, normally twenty seconds; a stalled
renewal cannot extend the last confirmed deadline, normally sixty seconds.
Known Kafka failure revokes locally immediately. Already accepted provider work
may still finish or bill. See [ADR-0303](../adr/0303-direct-renewal-and-local-execution-authority.md).

No production prices, wallet, top-up, payment collection or automatic deductions
were enabled. Test prices were confined to disposable acceptance tenants.
Missing rates remain unpriced; uncertain intervals receive no monetary amount.

## Resource and storage boundaries

Compute quantities use the accepted workload allocation, excluding VMM overhead
and snapshot rounding. Collection runs every thirty seconds and on coalesced
lifecycle changes. Clock discontinuity, boot changes, failed observations and
long observation gaps remain unconfirmed. The unsampled pause/delete tail is
not silently billed as verified execution.

Workspace capacity is separate from the disposable VM system disk. The default
is 32 GiB and can grow. It is a kernel-enforced ceiling, not a reservation of
physical blocks in the shared backing pool. Persistent Cube Volumes remain the
single authority for mutable Workspace bytes. Retained conversation objects in
S3 are a separate resource and are not included in this storage meter.

Original Workspace directories were moved into the quota-enabled XFS pool only
after writer/VM closure, enforced-project validation and full copy/checksum
verification. The old source was removed only after verified cutover. Mount
identity uses the filesystem's on-disk UUID, and its mount precedes K3s at boot.
See [the storage operator](../WORKSPACE_STORAGE_POOL.md).

## Serial validation

Heavy tests, image construction, scans, deployment and live fixtures ran serially.
Consolidated TS/runtime, Go/provider/native, actual PG/Kafka, kernel quota,
browser, Helm/install and dependency checks preceded publication. Old schema
fixtures were corrected using frozen historical SQL; later findings received
targeted regression runs instead of repeatedly rerunning unrelated suites.

| Check | Observed result |
| --- | --- |
| Model receipts | On the unchanged provider/receiver implementation, management outage did not prevent ingestion. Receiver outage plus provider replacement retained receipts. Two repeat deliveries did not add duplicate facts. Pricing, authenticated query, multi-row NDJSON export and the costs page passed. |
| Actual quota | Luna's Bash hit a real 1 GiB limit. Growing the same Workspace to 2 GiB was acknowledged by the kernel and allowed the write. The fixture removed its large file. |
| Shared compute | Two Sessions used one allocation; its resource quantity was counted once. |
| Pause/storage | The measured paused window contained zero confirmed compute milliseconds while the same 2 GiB Workspace continued producing confirmed storage receipts. Unconfirmed compute tails had no amount. |
| Resource replay | Repeated delivery of two original receipts left exactly two stored facts. Authenticated aggregate statements, summary and receipt export passed. |
| Pause deletion | The strengthened final fixture checked native all-node inventory before financial purge. Neither an active VM nor its pause binding remained. |
| Management outage | Management was absent for 86,094 ms. The active Run crossed its earlier PG-confirmed lease deadline on the same Worker/lease and VM. Two sequential Bash calls each executed once and the Run completed before management returned. |
| Independent reads/receipts | During that outage, PG projection, authenticated history/cost reads and SSE remained available. New model, compute and storage receipts reached PG. A new pure-chat Run was admitted on its first attempt, with replay preserving its identity. |
| Recovery | Five native cases passed: queued-input consumption, Stop, Worker SIGKILL, streaming Stop, and Worker plus Session-runtime SIGKILL. One logical Run, retained interrupted text, edited input identity and absence of PG streaming bodies were checked. |
| Images | Two approximately 6.3 MB images and one 25.1 MB image passed. Their reply records were 596–597 bytes of references. A replacement Worker correctly recovered visual context. |

The quota/storage and outage fixtures confirmed physical cleanup and coherent
source-delivery closure before removing their disposable financial rows. All
final owned fixtures reported successful cleanup. The image fixture also removed
its temporary Session/Workspace. The previously deferred 131 MiB cold request
was not rerun.

Private raw evidence remains under the ignored operator directory
`deploy/production/runtime/work-evidence/runtime-accounting-20261107/`.
It includes the final resource, management-outage, native-input and image reports,
model-metering recovery evidence, asset comparisons and release-stage records.
Credentials, rendered Secrets, user data and transcripts are not part of this report.

## Findings resolved during publication

- Native storage maintenance initially omitted the host-mounted bootstrap
  DaemonSet. The operator now stops it and waits for observed generation, zero
  desired/current Pods and actual Pod disappearance.
- The host's `xfs_io` printed inheritance as `[--------P--------]`, rather than
  the name used by an earlier fixture. Validation now checks numeric `0x200`
  while preserving project-ID and copy/checksum guards; storage regressions passed.
- The new Session listener's initial health check depended on its later started
  state. Listener initialization and readiness are now separate. Real HTTP
  lifecycle regressions and an isolated full startup in the cluster passed.
- TemplateCenter needed registry access formerly granted only to Master. The
  authoritative registry manifest and matched operator now include it.
- Managed allocation closure initially reaped a paused VM but bypassed upstream
  pause-package deletion. It now joins that cleanup on the recorded node's current
  address and retains ownership on failure. Native regressions and the final real
  pause/delete fixture passed. The two earlier test leftovers were removed with
  the scanned fixed Master before the final matched rollout; original machines
  were retained during that targeted repair.
- Acceptance scripts were corrected for synchronous S3-client close, host route
  convergence after receiver replacement, and multi-row NDJSON. Their final runs
  completed successfully; earlier failed attempts were not counted as delivery.

The v0.5.1-to-v0.7.3 chart transition also needed a one-time obsolete-port update
and Redis controller recreation. The Redis Pod/PVC and credentials were retained;
the final desired configuration is the maintained Helm/post-rendered declaration.
Proxy/Windows interop and stale dependency mirrors caused additional preparation
failures. They did not authorize bypassing writer closure, ownership checks,
artifact provenance or the security gate.

## Preservation and limits

The final comparison retained all 32 pre-existing users, 35 model profiles,
two original Workspaces, both stable development-machine identities/intents and
both OAuth-file hashes. The original VM allocations were intentionally replaced
through confirmed closure. Final native inventory covered the recorded node and
contained only the two expected running machines; no test pause bindings remained.
There were no active Runs or Session writers after acceptance, and enabled
application/infrastructure workloads were ready.

This is single-host K3s evidence, not fleet HA or a throughput SLA. New VM
activation, resource mutation and physical recovery still need management.
The outage test exercises bound Bash execution, reads/SSE and metering; it does
not establish every optional Tool's behavior under every outage. Missing source
observations, node-store loss and lifetimes shorter than initial capture retain
the documented uncertainty limits. Shell effects are not exactly once.

Operational follow-ups remain: earlier diagnostics for immutable native chart
changes, less expensive artifact reuse for operator-only fixes, and expiry of
unreferenced image pins. These do not introduce another runtime authority or
weaken the completed ownership/fencing contracts.
