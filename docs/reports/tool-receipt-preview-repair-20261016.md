# Tool receipt and preview repair

Baseline: `39ec5643`. The owner approved [ADR-0252](../adr/0252-tool-receipt-and-ephemeral-preview.md).
Status: implementation in progress; serving release remains `guest-execution-5536fc73`.

## Acceptance and progress

- [x] Source: receipt-only failure preserves valid completed outcomes and background-work admission;
      missing proof, real timeout/fault cleanup and native abort remain distinct.
- [x] Source: guest renders bounded terminal-aware previews independently of final output.
- [x] Source: revision-bound edits/resets survive tested lossy/coalescing boundaries without
      entering Kafka, PG or model context; final completion retires observations.
- [x] Required source/native/race/transport/fault checks pass after the recorded fixture and packaging corrections.
- [ ] Matched artifact provenance/SBOM/vulnerability scans pass.
- [ ] Matched release and real Luna/Cube/browser/failure acceptance pass, with
      preserved configuration and confirmed fixture cleanup.

Failed samples, release identity, verification counts and measured limitations
will be recorded here as work proceeds. A checked source slice is not a deployed contract.

R1 source checks: 13 targeted guest tests, Tool Sandbox typecheck and the full
patched native execution suite with the race detector pass. A real local PTY
running the actual launcher/guest (privilege and cgroup operations substituted)
retains a successful final frame and exits 76 on a withheld receipt, without a
plain protocol error; the healthy case exits 0. Native FIFO tests cover preserved
receipt-only results, required timeout cleanup, wrong identity, duplicate/partial
frames and deadline/result races. Live VM/background preservation is still pending.
R2/R3 targeted suites pass 113 tests before the added real-HTTP and launcher
contracts. The HTTP→subscription→browser-store chain passes with a 6,338-byte
initial preview and a 557-byte coalesced edit in its synthetic sample, including
missing bases, HTTP failure, owner redirect and a new subscriber. Actual launcher
PTY contracts pass normal/missing/malformed receipt and reserved-child-exit cases.
The unchanged-screen test now varies the source fixture's final counter when
asserting repeated observations: identical terminal views intentionally emit no
delta. Typechecks pass across the workspace. Complete CI and live acceptance remain pending.

The stop-helper race is also covered: an empty proof observed before its deadline
can retain a receipt-only exit just after that deadline, using a short join within
the existing final cleanup budget. The full updated native suite passes with the
race detector (23.2 seconds in the isolated sample).

A fresh Node synthetic source sample processes 20 paced display states in 55 ms
wall / 58 ms CPU, emits 16 deltas and four resets totaling 8,423 update bytes, and
observes about 5.3 MB incremental peak heap. The largest update is 1,759 bytes;
this particular sample uses short lines. A separate injected oversized input
retires its preview while the independent final collector retains `FLOOD_DONE`.
These are bounded local samples, not fleet capacity or live VM acceptance.

The first complete CI invocation passed native/allocation, Helm/installer and
build gates, then caught a new test importing a React `.tsx` module into a backend
package without JSX enabled. The browser's pure preview store is now a separate
module shared by the renderer and chain test. This was a test dependency issue;
the failed sample is retained, and affected build/check stages plus remaining CI
gates must pass before preparation.

The workspace run then found an existing management-reconnect fixture expiring
only `expires_at` relative to the host clock; a concurrent heartbeat could make
that timestamp precede `last_heartbeat_at`, violating the retained PG constraint.
Both affected fixtures now construct consistent past heartbeat/expiry timestamps
using PG time. The complete eight-case gateway suite passes without changing
production lease/reconnect behavior or weakening its assertions. All other
workspace tests passed in that run.

The guest build-closure gate correctly caught the new `tool-preview.ts` missing
from the explicit Docker COPY list. That input is added without broadening the
guest import boundary to model/API modules. The remaining release gates are rerun
after this packaging fix.

The first artifact preparation built all images but stopped during database
download. The default mirror stalled; an official GHCR attempt hit its five-minute
budget; the ECR attempt exposed `no space left on device` in the 256 MiB download
tmpfs with a 128.03 MiB compressed DB. Downloads now have a separate 512 MiB
temporary bound, a 15-minute budget and an optional official repository selector.
Offline image-scan bounds and the vulnerability gate remain unchanged. Preparation
must be repeated from a clean revision with matching artifact provenance.

The next scan completed all eleven reports but blocked Cubelet/cubecli on
`CVE-2026-95837`: the resolved containerd dependency was 2.2.5. The
[upstream advisory](https://github.com/containerd/containerd/security/advisories/GHSA-p7v4-vr35-mj6f)
identifies 2.2.7 as the fixed patch line. Patch `0010-containerd-security.patch`
pins 2.2.7 and its required module graph; CubeMaster's graph is tidied to match
its local Cubelet module. No vulnerability ignore or experimental CRI restore
option is added. Presence in the binaries is the scan finding; this report does
not claim exploitation of the advisory's CRI checkpoint path in PiCloud's KVM runtime.

The dependency recheck passes native execution race tests, maintained cleanup
service cases and complete Cubelet/CubeMaster compilation. A broader upstream
CubeMaster service test invocation lacked its upstream `test/conf.yaml` and
panicked in configuration access; it is not claimed as passing. Required managed
allocation/Volume/native contracts and live KVM acceptance remain the release gates.

Verification is complete in stages: 1,761 workspace tests and 71 acceptance-helper
tests pass (1,832 total; ten conditional skips), together with eight real RF3
Kafka/PG transport tests, 244 deterministic fault cases and the native race suites.
Dependency audit reports zero vulnerabilities. Installer/runtime-policy, Helm,
observability, image closure, application builds and workspace typechecks pass.
The fault artifact records the then-uncommitted test/COPY corrections honestly;
those corrections have separate passing targeted checks. No failed assertion or
release gate was skipped. Artifact preparation and live acceptance remain pending.
