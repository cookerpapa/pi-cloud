# Tool reply uncertainty and continuation

Date: 2026-10-16–17. Baseline `03c3a7ec`.
[ADR-0253](../adr/0253-tool-reply-uncertainty-and-continuation.md) is implemented
and deployed as `tool-unknown-791a6ed0`. Source and relevant live acceptance are
complete. Failed samples and the remaining conservative Volume-reference recovery
limit are preserved below; the owned crash fixture required confirmed operator
detach before its normal physical cleanup completed.

## Implemented behavior

Fixed Tool replies retain Pi's final-result interface. A local reply deadline or
explicit Cube handoff transport failure can request one fresh execution probe.
The original Worker receives the guest reply through its Kafka mailbox, then
the current Projector owner confirms the nonce and current binding/target/boot
from memory over the internal readiness endpoint. The full check has a ten-second
budget; concurrent checks share work. It is not an execution grant.

Confirmed readiness allows Pi to commit the UNKNOWN Tool error and continue to
inspect effects. Repeated uncertainty without a confirmed Tool result interrupts.
Stop, lease/writer failure, uncertain native publication, closed/replaced bindings,
quarantine, protocol inconsistency and Workflow channel errors retain interruption.
The current implementation deliberately does not infer benign result loss from
generic native execution failure. Malformed completed guest frames now produce
a blocking protocol error instead of disappearing into a later wait timeout.

Reply deadlines use the invocation's execution budget plus the existing 120-second
transport allowance: file Tools 180 seconds, Bash with timeout 30 seconds 150
seconds, default Bash 420 seconds. Guest execution budgets remain unchanged.
Three orphaned error recognizers and the unused pre-Durable cancellation text
are removed. No result outbox/cache, new database table, additional consumer,
automatic command replay or native Pi patch is added.

Probe packets stay out of native history, model context and PG sample storage.
Readiness checks add no request on the ordinary successful Tool path. The one
extra HTTP confirmation belongs to eligible failure handling and uses the same
partition ownership discovery and Worker management authentication.

## Initial source verification

- Targeted native Harness, mailbox, completion, routing and probe tests pass.
  They cover distinct inspection without original-command replay, repeated
  uncertainty, Stop, hard failures, owner replacement, closed/replaced targets,
  expired evidence, coalescing, lost publication ACK and late replies.
- Builds, type checks, native Cube race/admission/allocation, installer/Helm,
  documentation and runtime-policy checks have passed in the current CI run.
- Full CI passed: 1,793 workspace tests, 77 acceptance-helper tests, eight real
  RF3/PG transport tests, all 244 previously indexed deterministic fault cases
  and a security audit with no remaining vulnerabilities. A subsequent complete
  expanded run passed all 252 cases, including the eight new continuation/readiness
  cases. [Machine-readable results](fault-eval-latest.json) retain the baseline
  revision/dirty-worktree marker from execution start; source was subsequently
  committed as `865e0e11`. The final strict HTTP readiness-status change and live
  fixture checks also passed their affected targeted suites.
- The owned live fixture has been added and its suppression isolation is tested.
  Its initial matched live run is recorded below. It retains a checksum/ownership
  restore receipt, suppresses only fixture results/probes, expires automatically,
  and restores the adapter before the owned Cubelet crash case. See the
  [operator procedure](../MATCHED_RELEASE.md).

Private working logs are under `/tmp/pi-cloud-unknown-*`; release/host maintenance
state is under `deploy/production/runtime/release-evidence/tool-unknown-20261016/`.
Do not publish credentials, transcripts or raw host configuration.

## Host capacity follow-up

The owner requested enlarging WSL after the release preflight headroom check
found approximately 14.7% available. The Ubuntu disk was 1500 GiB on
`G:\WSL\Ubuntu\ext4.vhdx`; the prepared target was 1700 GiB. A private Windows
script required a clean source checkpoint,
completed CI, no active Runs/writers/resources and a complete empty native VM
inventory. It records workload replicas/selectors and account/configuration
fingerprints, stops services normally with retained PVCs, then uses Microsoft's
supported WSL resize command and restores/validates the cluster. The owner
authorized automatic restart; the attempt and completed host expansion are below.

The existing seven-day-old unused Docker build-cache cleanup reclaimed zero
bytes; no image, Volume, account or business history was removed.

## Initial cutover and live finding

The Windows-side automatic resize attempt returned -1 and restored the cluster.
The owner then had the host Codex complete expansion. Verified block capacity is
1,825,361,100,800 bytes (1700 GiB), with about 404 GiB free. KVM API 12 and actual
empty-VM creation, all Pod readiness, Windows/Linux web HTTP 200 and the seven
account/configuration fingerprints passed after restoration.

Candidate `tool-unknown-7e1ca3ff` passed all eleven image/provenance scans and
matched preflight, then deployed successfully. Guest identity/templates were
reused unchanged. This cutover was not yet complete feature acceptance.

The first owned live reply-loss injection failed before the target Tool started:
restarting the idle completion child left the reused VM's Submit path returning
`execution_unavailable`. Native capability discovery already calls bounded
`EnsureReady`, while Submit/async probes only check `Ready`. Record this as an
execution-readiness recovery gap, not a passing UNKNOWN continuation test. The
adapter was restored and tenant/VM cleanup completed. ADR-0253 now includes a
bounded demand-recovery fix before repeating matched release/live acceptance.
Private evidence: `live-unknown.json` and its adapter restore receipt under the
release directory above. Preserve this failed sample.

The follow-up native patch reuses `ProcessDelivery.EnsureReady` before Submit and
async-probe admission, with the existing three-second bound and cancellation
checks. Healthy requests remain memory-only, and direct physical probes remain
independent of completion readiness. Real child-process tests cover idle exit,
single execution after recovery, failed startup, caller cancellation/deadline,
closed delivery and the default time bound. The maintained service test selection
now includes these cases and the direct-probe/protocol contract (whose stale
expected protocol 5 is corrected to the existing protocol 7).

The composed Cube allocation/Volume/execution race suites, service contracts,
standalone admission suite, 77 acceptance-helper tests, documentation, formatting,
runtime budgets and image-closure checks pass after this follow-up. It changes
no TypeScript runtime, schema or wire version. These checks preceded the next
matched artifact set and live repeat below.

The follow-up release `tool-unknown-adf6728b` passed all eleven artifact scans,
matched preflight and drained deployment. The first repeated live case passed:
one original append, canonical UNKNOWN, a distinct successful Read and a completed
Run in 137,493 ms, with no probe nonce in native storage. The next case interrupted
with `tool_reply_timeout` and `timed_out`, as the existing Run executor's timeout
classification specifies. Its fixture incorrectly required `failed`; correct it
to assert both the precise timeout state and code, then rerun the remaining
assertions and crash case. Do not claim this partial run as complete acceptance.
Adapter restoration and owned tenant/VM cleanup passed. Preserve its evidence
as `live-unknown-recovery.json`; this assertion repair changes no runtime image.

## Startup Stop race found during repeated acceptance

`live-unknown-complete.json` confirms both result-loss cases and restored browser
UNKNOWN rendering: inspection completed in 136,990 ms; lost result plus lost
probe stopped with `timed_out/tool_reply_timeout` in 139,462 ms. Both cases had
one original effect, retained the same VM, and kept probe nonces out of native
storage. Before the Cubelet crash was injected, polling a newly accepted Turn
assumed its optional transcript already existed. Fix that fixture read.

The resulting early cleanup Stop exposed a real existing recovery loop: each
writer bootstrap was aborted before a finalizer existed, then ordered recovery
requeued and redelivered Stop into the next bootstrap. The original shortcut
comes from ingress commit `2462e8b9` and survived the direct-publication migration
in `4f887b17`. The fixture reached 900 transitions before its tenant claim policy
was disabled. At isolation, all old writers were sealed/released and the owned
Run stayed queued with its Stop and cleanup records intact. Fixture cleanup and
the crash case were still pending; the completion adapter had been restored.

The source repair retains Stop through bounded producer initialization and uses
Pi's existing `stopOnResume` effect barrier before ordinary native cancellation.
It also joins a pending PG cancellation acknowledgement before starting Pi; a
rollback fails without starting or stranding the runner. Normal authorization,
uncertain-publication closure and native result ownership are unchanged. Three
real-PG cases cover immediate Stop, initial writer failure followed by recovery,
and acknowledgement rollback. Pinned Harness tests cover effect blocking.
The stale 128-item Run-transition response cap is removed without dropping
history. The 255-case fault gate and targeted startup/Harness/API cases passed
before the expanded application/transport checks. Scanned Worker recovery of
the isolated fixture and a complete matched release preceded final live acceptance.

Source `d3fcc781` subsequently passed 1,795 application tests, 77 helper tests,
eight real RF3/PG transport cases, the full 255-case fault gate, builds/types,
documentation/format/runtime/image-closure checks and eleven image scans.
The scanned Worker rollout ended the isolated recovery loop with a sealed Run,
but its Stop was classified as `workspace_seed_cancelled`, not native cancellation.
The pure claimed-seed descriptor still had a pre-Durable abort check. Remove
that check/parameter and pass the original Stop through native bootstrap. The
actual remote runner + real seed resolver + pinned Harness now passes an
already-aborted Stop with zero model permits, zero Cube activation and normal
native cancellation; both seed variants also pass. Add this to the fault index.

The operator failure remains in `isolated-stop-recovery.json`. Separate normal
API cleanup read all 903 transitions, confirmed zero Tool calls, deleted the
owned conversation/Workspace and waited for physical purge before removing its
tenant. `isolated-stop-failed-cleanup.json` records cleanup success without
claiming cancellation acceptance. All original seven account/configuration
fingerprints match, all Pods are Ready, and no Run/writer/VM/binding remains.
Only Workers temporarily ran `tool-unknown-d3fcc781` at this point; the seed
follow-up below preceded the final complete matched release and live acceptance.

The seed follow-up passes all 207 sandbox-supervisor and 86 supervisor-host tests,
the three affected package type checks, documentation/format/runtime/image-closure
checks and all 256 indexed fault cases. No native Cube, guest wire, schema or
dependency changed. The live fixture now also checks an immediate Stop after
claim, and tolerates an as-yet-unmaterialized transcript while awaiting a Tool.

## Matched release and live outcome

`tool-unknown-791a6ed0` passed all eleven image scans and matched preflight, then
completed the normal drained full rollout. Guest identity `a253c3fee801893e1a916d45d423317f737a0f5d`
and all four templates were reused; native patch identity remains `3a7e75cece12fef5`.
`live-unknown-final.json` records passing functional cases: early Stop before the
first output (cancelled, zero Tools/VM activations), lost reply followed by a
distinct successful Read (136,285 ms), lost result and probe (timed_out after
141,700 ms, no later Tool and the same VM), browser UNKNOWN restoration, and a
real owned Cubelet Pod loss after a confirmed guest effect (one original Tool,
Run failed without fabricated completion). Probe nonces never entered native
storage. The completion adapter was restored.

That live command exited unsuccessfully during automatic Workspace cleanup.
The VM allocation was irreversibly closed/absent and the complete native node
inventory was 0, but restart reconciliation retained `count=0, confirmed=false`
for the Volume. ADR-0226 intentionally holds such unknown state. Do not relabel
the script as a fully automatic passing crash-cleanup test.

A scoped operator recovery on October 17 checked deleted fixture ownership,
closed Volume admission, zero Master holds, the recorded allocation's closure,
complete node absence, the pinned POSIX plugin identity and its detach receipt.
With all writers and VMs drained, it stopped idle Workers/Cubelet, exclusively
opened the native reference store and compare-and-set only that completed-zero
record. It retained the store incarnation and advanced revision 779 → 780;
unrelated records were untouched. Eight guarded helper cases passed before use.
The first helper image lookup timed out before execution and restored services;
the retry used a locally verified pinned image with pulling disabled. Native
reference observation then confirmed zero and the normal deletion reaper removed
the Volume. The fixture tenant was purged only after physical cleanup confirmed.

Private `volume-repair/receipt.json` and `final-fixture-cleanup.json` preserve that
evidence separately from the failed automatic cleanup sample. Original account,
model/provider and credential fingerprints still match. Automatic recovery of
these unknown Volume references remains a separately tracked operational limit;
no Volume-safety marker was cleared merely because a heartbeat or reply was lost.
Native-input, browser/image and full-Cube regression subsequently passed.

## Final acceptance and preservation

- All five native-input/live-stream cases pass, including edits/retry identity,
  Stop, Worker replacement and simultaneous Control Plane/Worker loss. Native
  partial content survives; PG retains no streaming bodies. Fixture cleanup passes.
- Real browser Stop/returned-input retry/image resend passes with the same upload
  identity and direct vision. Native Read truncation and UTF-8 diagnostics pass
  for 120,017-byte ASCII and 140,031-byte Unicode files. Fixture cleanup passes.
- [Full Cube acceptance](cubesandbox-production-acceptance-latest.md) passes on
  source/runtime `791a6ed0`: pure chat without VM activation, multi-round warm VM
  reuse, authenticated preview, background service survival, a persistent 1024-file
  fixture attached to a fresh VM, tenant isolation and rejection of late commands
  to a deleted VM. Normal allocation/Volume cleanup and the owned tenant purge pass.
- Final checks show no active Run, writer, binding, VM, development machine or
  terminal. Native inventory is complete (1/1 nodes, 0 VMs), all matched release
  participants are Ready, and separately pinned infrastructure retains its own
  declared versions. Windows and Linux both return web HTTP 200.
- All seven original account/model/provider/credential fingerprints match:
  32 tenants/users/API credentials, 5 password credentials, 35 model profiles/
  credential bindings and no source-control credentials. WSL remains 1700 GiB
  with approximately 390 GiB free. No user backup or compatibility data reset
  was introduced.

Source evidence is 1,795 application tests, 77 helper tests and eight real RF3/PG
transport tests for `d3fcc781`, followed by all 293 tests in the final delta's two
affected packages, their consumers' type checks and the expanded 256-case fault
gate. Native Cube contract/race tests and all eleven final artifact scans pass.
Private final reports, runtime checks and preservation receipts are under the
release-evidence directory above. The remaining Volume-reference item is an
explicit operational limitation, not a claim of automatic node-loss recovery.

## Owner-requested resource cleanup, October 17

The unknown fixture Volume was already physically deleted by the operator
recovery above. A fresh check returns Volume HTTP 404, with no native Volumes,
node reference rows or holds, no VMs on the complete recorded node and an empty
Workspace Volume directory. The owner then requested clearing remaining unused
PiCloud resources.

- Removed 102 already settled business/runtime rows: 18 deleted and physically
  purged Workspaces and their 18 deleted projects, 13 released runtimes, one
  released development machine and associated deletion/environment records.
  The transaction rechecked quiescence and physical-absence evidence; it did not
  modify account, model/provider, credential or native fencing tables.
- Removed 318 obsolete Docker tags and 227 obsolete K3s image references after
  protecting current workload images, the current guest and separately pinned
  infrastructure. These are reference counts, not unique-layer counts.
- Removed 15 obsolete registry manifests. Offline collection reclaimed
  682,950,656 bytes (about 651 MiB). The current guest's three-manifest OCI graph
  retains all 33 referenced blobs, verified through the registry API. Only its
  current tag remains; all four current Cube templates retain their IDs/digest
  and READY state.
- Removed 86 inactive ReplicaSets, 27 superseded Helm revision records, the
  completed database-bootstrap Job and three obsolete development database-backup
  directories. Current Helm records, release evidence and configuration remain.

Registry collection follows Distribution's documented
[offline garbage-collection procedure](https://distribution.github.io/distribution/about/garbage-collection/).
Initial maintenance attempts encountered a replaced HTTP connection, already
deleted manifests' empty directories and Service endpoint convergence. A later
read-only rollout did not become Ready within its 60-second bound; each attempt
restored the original configuration. Final collection stopped the registry,
ran its pinned collector in a disposable Job, then restored normal service with
deletion disabled. The failed maintenance receipts and final graph verification
remain separate in private evidence.

Final verification finds zero Sessions, Runs, projects, Workspaces, runtimes,
development machines and pending control records; S3 lists zero objects and
unfinished multipart uploads. All 28 serving Pods are Ready, all serving images
remain available, and Windows/Linux web access returns HTTP 200. Seven original
account/configuration fingerprints still match. Rounded filesystem availability
increased from 391 to 412 GiB; this is an observed host-space change, not a sum of
image sizes. No application behavior or image version changed during cleanup.

Existing Kafka retention and retired-writer/allocation protection records remain
intact. Two retired Worker mailboxes were still inside the normal 121-minute GC
grace; their existing collector, rather than an ownership reset, handles expiry.
The automatic unknown-reference recovery backlog item is unchanged, but the
specific unknown fixture Volume no longer exists or occupies storage.
Private `cleanup-*.json` receipts under the release directory record before/after
state, individual removals and final preservation checks.
