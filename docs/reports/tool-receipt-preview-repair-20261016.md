# Tool receipt and preview repair

Baseline: `39ec5643`. The owner approved [ADR-0252](../adr/0252-tool-receipt-and-ephemeral-preview.md).
Status: source/native/fault gates and artifact scans pass; **`tool-preview-325f0ebd`
is deployed and all required live acceptance passes**. Windows rollback and reboot
restored KVM; Windows localhost web access is repaired. Complete preview/receipt,
native-input/dual-process recovery, browser/image/Read and full Cube suites pass.
The recovery probe explains the earlier too-short fixture deadline. External proxy
TLS failures are retained as failed samples, not claimed fixed by this release.
Earlier deployment and investigation stages are retained below.

## Acceptance and progress

- [x] Source: receipt-only failure preserves valid completed outcomes and background-work admission;
      missing proof, real timeout/fault cleanup and native abort remain distinct.
- [x] Source: guest renders bounded terminal-aware previews independently of final output.
- [x] Source: revision-bound edits/resets survive tested lossy/coalescing boundaries without
      entering Kafka, PG or model context; final completion retires observations.
- [x] Required source/native/race/transport/fault checks pass after the recorded fixture and packaging corrections.
- [x] Matched artifact provenance/SBOM/vulnerability scans pass for clean `325f0ebd`.
- [x] Matched release and real Luna/Cube/browser/failure acceptance pass, with
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

## Resume plan recorded before Windows restart

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
They contain no replacement authority or new application data store. The subsequent
deployment and acceptance results follow.

## After Windows restart: deployment and live samples

Windows is now `26200.9457`, the target hotfix is absent, and there is no pending
reboot. WSL exposes `/dev/kvm`; its API reports version 12 and an actual empty VM
can be created and closed. KVM inside Cubelet passes the current operator check.
The initial not-Ready Pods were still recovering from the host boot; they became
Ready without replacing infrastructure or changing its configuration.

The already-scanned `325f0ebd` candidate was applied from an exact clean detached
checkout, with the original runtime directory and Cube repository supplied by
absolute path. Source runtime packages/dependencies/deployment inputs are identical
to that candidate; later main-branch changes are operator checks and documentation.
The first retry omitted the Cube repository override and failed before native
reconciliation because it looked for `/tmp/CubeSandbox`; the next invocation fixed
that operator path without rebuilding/substituting any scanned image.

At about 15:16 Asia/Shanghai, all four new guest templates and the matched native /
application release completed. The prepared guest digest remains exactly the
scanned digest above. Web, Control Plane, both Workers, SSH and Volume Gateway are
Ready; the web endpoint returns HTTP 200 when accessed directly. The Cube egress
gateway also becomes Ready after Control Plane supplies its configuration.

Passing real samples:

- Continuous Bash output, browser collapse/expand/reload and one forced Control
  Plane replacement: the command executed once; 25 preview messages included 19
  deltas and six resets. Maximum preview text was 8,192 bytes, maximum encoded SSE
  envelope 8,563 bytes, total envelope bytes 57,424 for this one sample. Final
  output retained the completion marker. This is not a fleet bandwidth estimate.
- Exact patched native driver in an owned real VM: one reverse receipt was
  filtered; result was retained after 5,477 ms, scoped cleanup was not invoked,
  and both the background HTTP server and sibling process remained alive.
- The full Cube suite's initial real GPT-6 Luna pure-chat case completed without
  activating a Cube VM.

Incomplete/failed samples are not hidden:

- The first progress suite's subsequent progress-bar Run failed before Tool
  execution. CLIProxyAPI reports an upstream TLS-handshake EOF surfaced as HTTP
  500. Two later initial Runs and the full Cube suite's first coding Run encountered
  the same failure, at approximately three or five seconds.
- One intervening progress-suite attempt timed out waiting for visible preview
  text after Control Plane replacement. Its precise cause is unresolved. The
  fixture now records replacement time, failed-Run state, snapshots, received
  preview revisions and browser expansion/text state before cleanup. Later TLS
  failures occurred before this instrumented path, so no diagnosis is claimed yet.
- The CR/ANSI browser case, silence, Stop/no-late-preview, subsequent four-tool
  coding and complete native-input/Worker-recovery/browser suites have not passed
  for this release. Do not close ADR-0252 acceptance on the earlier baseline's results.

The relay's payload-free audit records attribute the TLS close to its upstream
proxy side. A fresh credential-free uTLS probe passed three direct-local-proxy and
three PiCloud-relay handshakes; that small successful sample does not disprove the
intermittent issue previously reproduced in the
[October 12 investigation](model-egress-tls-20261012.md). No model retry owner,
credentials or proxy routes were changed. The owner elected to switch to a backup
proxy node; wait for confirmation that the switch is complete before continuing
network-dependent acceptance.

Every progress-suite fixture reports confirmed cleanup. The failed full-Cube
fixture's normal Workspace deletion settled before its exact newly-created tenant
was removed using the maintained cleanup helper. The seven original account /
configuration table fingerprints still match, native inventory scans 1/1 nodes
with zero VMs, and there are no unfinished Runs, writers, Tool bindings or seals.
Deployment is online; remaining live acceptance and the reconnect investigation
are pending.

## Recovery timing diagnosis and complete targeted checks

An isolated empty-Session probe reproduced connection recovery without any model
request or Tool: after forced Control Plane deletion, the Kubernetes replacement
command returned in 1,240 ms, but SSE's replacement snapshot arrived at 30,377 ms.
The client retried intervening 502/500 responses and then recovered. Thus the
earlier 25-second preview assertion expired before this measured connection
recovery; it did not demonstrate a lost expansion state or broken delta parsing.
The instrumented browser had remained expanded and was displaying its waiting
text while the native Run continued running.

The maintained fixture now gives reconnection one shared 60-second window and
runs a bounded 90-second command with a 180-second Bash timeout, so the Tool is
still producing output after recovery. It retains every prior assertion and
records the actual recovery time; this does not change runtime deadlines or
claim a fleet-wide recovery SLA. The no-model probe and timing diagnostics are
retained privately under `dist/research/preview-reconnect-20261016/`.

The complete progress/receipt suite subsequently passes, including real CR/ANSI
overwriting, silence, Stop with no late previews and write/read/edit/bash after
Stop. The command executes once. Preview recovery is 27,100 ms; 64 envelopes
contain 50 deltas and 14 resets, totaling 127,597 bytes (maximum 8,571; source view
maximum 8,192). The repeated real receipt-loss check retains its result at
5,493 ms with zero scoped-cleanup calls and both background processes alive.
All fixture resources are confirmed cleaned.

The native-input suite also passes all five cases: consume/edit/retry identity,
Stop, Worker recovery, stopped streaming and simultaneous Worker/Control Plane
memory loss. The logical Run and native partial response survive, with no PG
streaming bodies or retained input-edit bodies. Both process crashes have exit
137/restart-count evidence. A transient kubectl `container not found` message
during the injected restart is retained; the complete recovery assertions pass.

The real-browser targeted suite passes lost-response/Stop/returned-input image
resend, preserving the upload identity and direct vision. Oversized ASCII and
Unicode Read results retain 51,200 and 51,196 valid UTF-8 bytes respectively and
their canonical truncation diagnostics. Both suites confirm fixture cleanup.
The full Cube suite's additional multi-round/background/Volume cases are tracked
separately; a follow-up attempt still encountered the known external TLS EOF.

## Final acceptance and cleanup

The subsequent unchanged full Cube suite passes at 08:27 UTC. Its 21 GPT-6 Luna
requests cover pure chat without VM activation, real coding, authenticated HTTP
preview, warm-VM reuse and background-process survival across Run bindings.
The deterministic 1,024-file fixture survives removal of its source VM and attaches
to a fresh VM through the same persistent Volume. The original executor rejects
late Tool and cancellation admission after deletion; final conversation deletion
and confirmed physical allocation closure release the fixture's runtimes.
The maintained [full Cube report](cubesandbox-production-acceptance-latest.md) and
[structured evidence](cubesandbox-production-acceptance-latest.json) retain measurements.
Its source revision identifies the test checkout; the deployed image is explicitly
recorded and belongs to the unchanged scanned `325f0ebd` release.

All four required live suites now pass, alongside the earlier source/native/race/
transport/fault gates and eleven image scans. Failed TLS samples remain retained;
the pre-existing external AnyTLS-path backlog stays open. No retry layer, credential
change or application workaround was added to hide those failures.

All newly-created fixture tenants were removed only after normal Workspace purge
and control settlement. The seven original account/configuration/credential table
counts and fingerprints still match their pre-cutover values. Final native inventory
positively scans 1/1 nodes with zero VMs; unfinished Runs, Session writers, Tool
bindings and unfinished seals are all zero. Application and infrastructure Pods
are Ready, and Windows/Linux direct web requests return HTTP 200. The temporary
release worktree, TLS probe source and port-forward process are removed/stopped;
private evidence is retained under the ignored release-evidence directory.

## Windows web entry after reboot

A direct Linux request to `127.0.0.1:8080` succeeded while Windows `curl.exe`
could not connect. A temporary native-listener `kubectl port-forward` on 18081
returned HTTP 200 from Windows. This isolates the local entry problem from the
web Pod itself: K3s hostPort DNAT did not provide the socket Windows localhost
discovery needed on this host.

The maintained WSL loopback deployment adapter now uses the installed systemd
socket proxy to the stable web Service. Real Windows and Linux requests to the
original port both return 200. Unchanged reconciliation preserves the socket's
activation timestamp; owned-unit removal/reinstallation and systemd unit
validation pass. The temporary port-forward has been stopped. This is a host
operator change with unchanged matched application/guest images; it does not
claim that a second Windows reboot has already been tested.
