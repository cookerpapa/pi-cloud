# Tool reply uncertainty and continuation

Date: 2026-10-16. Baseline `03c3a7ec`.
[ADR-0253](../adr/0253-tool-reply-uncertainty-and-continuation.md) is implemented
in source; matched deployment and live acceptance are pending. The serving
release remains `tool-preview-325f0ebd`. This report is not release evidence yet.

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

## Verification in progress

- Targeted native Harness, mailbox, completion, routing and probe tests pass.
  They cover distinct inspection without original-command replay, repeated
  uncertainty, Stop, hard failures, owner replacement, closed/replaced targets,
  expired evidence, coalescing, lost publication ACK and late replies.
- Builds, type checks, native Cube race/admission/allocation, installer/Helm,
  documentation and runtime-policy checks have passed in the current CI run.
- Full CI passed: 1,793 workspace tests, 77 acceptance-helper tests, eight real
  RF3/PG transport tests, all 244 previously indexed deterministic fault cases
  and a security audit with no remaining vulnerabilities. The expanded 252-case
  run is in progress; all eight new continuation/readiness cases have passed.
- The owned live fixture has been added and its suppression isolation is tested.
  It has not yet been run on a matching release. It retains a checksum/ownership
  restore receipt, suppresses only fixture results/probes, expires automatically,
  and restores the adapter before the owned Cubelet crash case. See the
  [operator procedure](../MATCHED_RELEASE.md).

Private working logs are under `/tmp/pi-cloud-unknown-*`; release/host maintenance
state is under `deploy/production/runtime/release-evidence/tool-unknown-20261016/`.
Do not publish credentials, transcripts or raw host configuration.

## Host capacity follow-up

The owner requested enlarging WSL after the release preflight headroom check
found approximately 14.7% available. The current Ubuntu disk is 1500 GiB on
`G:\WSL\Ubuntu\ext4.vhdx`; the prepared target is 1700 GiB. No disk resize has
been performed. A private Windows script first requires a clean source checkpoint,
completed CI, no active Runs/writers/resources and a complete empty native VM
inventory. It records workload replicas/selectors and account/configuration
fingerprints, stops services normally with retained PVCs, then uses Microsoft's
supported WSL resize command and restores/validates the cluster. Restart timing
is pending the owner's answer because WSL termination interrupts this connection.

The existing seven-day-old unused Docker build-cache cleanup reclaimed zero
bytes; no image, Volume, account or business history was removed.
