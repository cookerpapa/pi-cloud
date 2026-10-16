# Tool reply uncertainty and continuation

Date: 2026-10-16. Baseline `03c3a7ec`.
[ADR-0253](../adr/0253-tool-reply-uncertainty-and-continuation.md) is implemented
in source and deployed as `tool-unknown-7e1ca3ff`. Live acceptance found the idle
completion recovery gap below; its repair and repeat acceptance are in progress.

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
reused unchanged. This cutover is not yet complete feature acceptance.

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
no TypeScript runtime, schema or wire version. A new matched artifact set and
the failed live scenario must still pass before U5 can be completed.

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
