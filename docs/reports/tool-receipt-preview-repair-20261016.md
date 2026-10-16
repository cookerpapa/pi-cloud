# Tool receipt and preview repair

Baseline: `39ec5643`. The owner approved [ADR-0252](../adr/0252-tool-receipt-and-ephemeral-preview.md).
Status: source/native/fault gates and artifact scans pass; **deployment incomplete,
applications offline**. Native Cube switched to `tool-preview-325f0ebd`, but host KVM
is unavailable and guest-template creation failed. `guest-execution-5536fc73` is the
last fully accepted release, not a currently serving fallback.

## Acceptance and progress

- [x] Source: receipt-only failure preserves valid completed outcomes and background-work admission;
      missing proof, real timeout/fault cleanup and native abort remain distinct.
- [x] Source: guest renders bounded terminal-aware previews independently of final output.
- [x] Source: revision-bound edits/resets survive tested lossy/coalescing boundaries without
      entering Kafka, PG or model context; final completion retires observations.
- [x] Required source/native/race/transport/fault checks pass after the recorded fixture and packaging corrections.
- [x] Matched artifact provenance/SBOM/vulnerability scans pass for clean `325f0ebd`.
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
release gate was skipped. Subsequent artifact and deployment results follow.

## Scanned candidate and partial cutover

Preparation completed for clean revision
`325f0ebd2ff0be9d2848b4d79dbf3aa837eae2e9`, version `tool-preview-325f0ebd`.
All eleven provenance/SBOM/checksum-covered image scans pass with zero fixable
HIGH/CRITICAL findings under the maintained policy. The guest identity is
`a253c3fee801893e1a916d45d423317f737a0f5d`, completion identity
`4740af5f91006b64b308d16a016b0960648fb165`, native patch identity
`a05105f2c1bbd9d9`. The prepared guest OCI digest is
`sha256:4a990b8422cf86a79dcbb281a42e17683a5f7ba5f8ba8668ac93518020c1fa3c`.
Its contracts are PG189 / Session topic17 / boot reply3 / guest7 / completion
startup3 / preview2 / management7. No business-history migration is needed.

The maintained apply verified empty native inventory and settled writers, drained
applications and replaced native Cube. Guest registration then failed while
creating its template VM with `Failed to create the hypervisor: no supported
hypervisor`. Rootfs distribution had completed on the one node. The failed template
is `tpl-e26b5c207b134916892083a5`; its job is
`6d56aeb7-b3f7-4a6a-b234-a1b251477730`. No user/acceptance VM was started.
After confirming native inventory empty on its recorded node, the maintained Cube
template-delete path removed that exact failed template; all four previous
templates remain. Applications intentionally remain at zero replicas after partial protocol cutover;
the installed application/template catalogs still reference the previous release.
Do not start those old applications against the new native executor.

Host evidence: Windows `10.0.26200.9711`, AMD Ryzen 9 7945HX, installed
`KB5127648`, WSL `2.6.3.0`, Linux `6.6.87.2-microsoft-standard-WSL2`.
Firmware virtualization is enabled, but WSL exposes neither `svm` nor `/dev/kvm`.
Loading the existing `kvm_amd` module fails with `Operation not supported`, and
the kernel records `SVM not supported by CPU`. There is no configured PVM fallback.
These symptoms and the Windows build match
[Microsoft's confirmed Windows-update regression](https://github.com/microsoft/WSL/issues/41917).
At that stage, this was strong evidence for the regression, but the investigation
had not independently queried Windows HCS or rolled back the update.
Community reports on that issue restore nested virtualization by uninstalling
the update and rebooting; that host-level change requires the owner's decision.

The operator now checks each scheduled Cube node is Ready and has a readable,
writable KVM character device **before** import/drain. Five new tests cover missing
devices and incomplete node coverage; the full helper suite passes 76 tests.
Running the new check against the actual Ready Cubelet correctly refuses release
without changing workloads. This is a device-presence/permission gate, not proof
that a VM can start; real template creation and live acceptance remain required.
An initial test invocation referenced a nonexistent Vitest config and performed
no tests; the maintained helper command above was then used successfully.

After the failed cutover, native inventory positively reports one of one nodes
scanned and zero VMs. PG has zero unfinished Runs, writers, bindings or unfinished
seals. All seven preserved account/configuration/credential tables match their
pre-cutover count and SHA256 (ignoring only API credential `last_used_at`): 32
tenants/users/API credentials, five password credentials, 35 model profiles and
35 credential bindings, zero source-control credentials. No live fixture tenant
was created. Native/infrastructure Pods are Ready; application workloads are offline.

## Authorized host repair, awaiting reboot

The owner subsequently authorized trying the Windows-host repair. A bounded local
PowerShell script first verified the exact installed package manifest identifies
`KB5127648`, the current Windows build and the absence of a prior pending reboot.
The unelevated HCS query returned access denied (`0x8037011B`); after Windows UAC
authorization, `Basic` returned `S_OK` while `ProcessorCapabilities` independently
reproduced `0x8007000D` / invalid data. This matches the upstream failure more
specifically than the earlier missing-KVM symptoms alone.

At 14:19 on October 16 (Asia/Shanghai), Windows completed the online phase of
`Remove-WindowsPackage -Online -NoRestart` for exactly
`Package_for_RollupFix~31bf3856ad364e35~amd64~~26100.9711.1.30`.
The cmdlet reports `RestartNeeded:true`, and CBS records successful finalization
with reboot required and no additional repair needed. Automatic reboot was not
requested. Other packages, Windows feature settings and `.wslconfig` were not
separately changed. Removing the cumulative update also rolls back its other
included fixes; restore current updates once an applicable upstream fix is verified.

**Host repair is not yet accepted:** Windows still needs a restart, followed by
the WSL KVM API/empty-VM-creation check and real Cube acceptance. Do not describe
the online servicing success as proof that KVM works or PiCloud is deployed.
The private Windows-local repair script, diagnostic result, DISM log, post-reboot
probe and handoff notes are under
`%LOCALAPPDATA%\Temp\pi-cloud-kvm-20261016\`; copies of the result and log are
retained with the ignored release evidence. Applications remain offline pending
the matched release.

## Resume after host repair

1. Save open work and restart Windows to finish the staged rollback. Run the
   prepared `verify-after-reboot.ps1`; it loads the existing AMD KVM module and
   creates/closes an empty VM through the KVM API, without RAM, vCPU or disk.
   Then check KVM inside every Cubelet using
   `assertCubeKvmAvailable`; a missing device must never be worked around with a
   different execution backend or an ignored gate.
2. Prepare/apply a new candidate from the current clean revision using
   [the maintained procedure](../MATCHED_RELEASE.md). The old candidate remains
   immutable evidence for `325f0ebd`; later operator/docs commits must not be
   represented as having been included in its scan. Reusing that candidate requires
   its exact clean source revision and a separate successful host precheck.
3. Complete native/template/application matching through maintained registration;
   the failed owned template from this attempt has already been removed. Do not manually
   erase runtime ownership or enable a mixed release.
4. Run the progress/reconnect/Control-Plane-replacement/receipt-fault fixture with
   GPT-6 Luna, plus maintained full Cube, native-input recovery and browser checks.
   The real receipt/background-server case, VM Stop/recovery and actual preview
   bandwidth have **not** passed on this candidate yet.
5. Confirm fixture physical cleanup, compare preserved configuration again, and
   record successful deployment before closing the backlog items.

The temporary build relay has stopped and owned native source/build directories
have been removed. The private candidate, logs and preservation fingerprints are retained under
`deploy/production/runtime/release-evidence/tool-preview-325f0ebd/` (Git-ignored).
They contain no replacement authority or new application data store. Source
implementation is complete; deployment and live acceptance remain externally blocked.
