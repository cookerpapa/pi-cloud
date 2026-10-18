# Session publication and completion repair

Date: 2026-10-18. Implementation baseline: review commit `94ebd1ed`.
Decision: [ADR-0256](../adr/0256-session-publication-and-completion-boundaries.md).
Status: implemented and deployed as `session-completion-6e74fd5b`. Required
source, artifact and relevant live gates pass. Owned fixtures are physically
cleaned and original accounts/model/provider configuration/credentials are preserved.

## Implemented behavior

- SPC-01: normal completion replay reads the original tenant/Run/Session/Turn
  terminal and coverage. The shared reader also replaces duplicate forced-seal
  decoding. Replays preserve the event identity and all closure checks.
- SPC-02: a definite pre-send refusal remains native `StorageRejected` through
  the actual Session Host. Unknown ACK or post-ACK confirmation/adoption failure
  interrupts the owner; even a wrongly typed no-send callback exception after ACK
  cannot make a committed batch appear rejected.
  A refused publication yields one Node I/O turn before returning the error,
  preventing repeated native fault-settlement attempts from starving Kafka/lease
  callbacks. An isolated pinned-Pi probe reached 200 consecutive refusals in
  31.6 ms before a zero-delay timer ran. This is cooperative scheduling, not an
  automatic batch retry or a queue-space wait.
- SPC-O1: completion passes its locked Run to the transition helper, which still
  checks row version and returns the updated version for a subsequent cancellation
  transition. The measured fixture uses 16 statements instead of 18, and one Run
  SELECT instead of three. Counts exclude BEGIN/COMMIT and routing revocation,
  and include one timeout-configuration statement.
- SPC-03: RUN_LIFECYCLE and STREAM_DURABILITY now describe direct Session Kafka
  publication, native children and normal versus forced writer retirement.
- SPC-Q1: the closure fixture explicitly exercises a repeated control reference
  and checks one durable terminal/no additional Tool submission. The idle-query
  fixture restarts its bounded observation window only after an actually observed
  ordered wake; unexplained SQL still fails. The full RF3 suite passes 9/9.

The pre-send repair does not add waiting for queue space, automatic storage
retries or preservation of rejected Tool results. The native regression verifies
one Tool execution, native fault settlement and missing-result context. Those
costs were discussed with the owner before implementation.

## Verification

- Scoped runtime-core, pi-session-postgres, control-plane and sandbox-supervisor
  typechecks pass.
- Initial focused regression: 23 tests pass, covering normal completion lost
  return/replay, native cancellation versions, stale old-writer completion after
  readmission, shared Host refusal, unknown/post-ACK failures and native results.
- The five integrated Host cases pass after the additional I/O-yield correction.
- Full `npm run ci` passes on clean source
  `6e74fd5bcf4849a7dc404b428d0dad11e13b66a1`: 1,865 workspace tests, 77 acceptance
  helper tests, nine real isolated RF3/PG transport tests and all 288 indexed
  fault cases across 87 file groups. Types, builds, dependency hardening,
  formatting/docs, installer, runtime policy, native Cube admission/allocation/
  Volume contracts, Helm, observability and image closure pass. The npm security
  audit reports no remaining vulnerabilities.
- Separate browser presentation and Docker build-context checks pass. Candidate
  preparation verifies the exact reused guest's template/envd/path contract.

The initial CI stopped on formatting; the correction was committed before the
final clean run. A subsequent in-progress run was intentionally stopped before
tests to include the measured refusal I/O issue. An initial standalone template
check used an absent default experiment image; the candidate check uses the
actual scanned guest. None of these samples is counted as the final passing CI.

Baseline defect probes are archived at `94ebd1ed`; maintained regression tests
replace them. The [review](session-publication-completion-review-20261018.md)
retains the initial 7/9 RF3 result and passing diagnostic repeats; those historical
samples are not rewritten as a clean run.

## Artifacts and matched deployment

The application/native artifacts use version `session-completion-6e74fd5b` and
source `6e74fd5bcf4849a7dc404b428d0dad11e13b66a1`. All eleven artifacts pass the
existing SBOM/provenance/vulnerability gate with zero fixable HIGH/CRITICAL
findings under its unchanged policy. Unfixed findings remain reported.
The guest identity is `5d775367299e1cfc7877a2bf2544f857f4690f08`; its exact registered
artifact is reused and scanned. Completion identity is
`41871c26571c6721c0e791a14fbd892abbb80761`.

The maintained operator confirms KVM API 12, matching source/artifacts, settled
writers and complete native inventory before cutover. All four templates and
matched services are deployed. Schema 189, execution topic v17, boot reply v3,
guest/Tool protocol 7, completion startup 3, preview 2 and Cube management 7 remain
unchanged. The deployed Control Plane image is
`sha256:08b4d84245b4503a1359411642ef51ff575910d0c5172adfe23290e7864c8a87`.

The host's configured Docker proxy still points at a closed listener on port
12450. Preparation temporarily forwards it to the existing working proxy using
systemd's socket proxy, without changing daemon configuration. The temporary
listener is removed before deployment; permanent proxy configuration remains a
separate operational backlog item.

## Live acceptance

All live model cases use GPT-6 Luna and owned fixtures:

| Check | Evidence |
| --- | --- |
| Native input | Consume, Stop and Worker replacement retain one Run, stable retry identity and edited input, without retaining obsolete edit bodies. |
| Streaming Stop | The fixture observes 122 characters, then Stops; the native partial survives and PG contains no streaming bodies. |
| Worker and Control Plane crash | Both processes exit with code 137. The observed 164-character prefix survives recovery in the same Run, with streaming bodies outside PG. |
| Browser and Read | Lost admission reply, draft removal, Stop/returned-image resend and direct vision pass. ASCII Read truncates 120,017 source bytes to 51,200; Unicode truncates 140,031 to 51,196 valid UTF-8 bytes. Both retain native truncation diagnostics. |
| Tool images | 6,294,281-, 6,294,356- and 25,129,569-byte images return; native image records are 596, 596 and 597 bytes. Visual recall survives Worker Boot replacement and overwritten source files. |
| Child across Control Plane replacement | Replacement takes 13,043 ms; the original Worker remains, the child effect executes once and its control reply completes through Kafka. |
| Full Cube | Pure chat uses no Cube; multi-round coding, preview, background processes, tenant isolation, a deterministic 1,024-file fixture on a persistent Volume, fresh-VM restoration and rejection of late Tool/cancel requests to a deleted VM all pass. |

The full Cube sample uses 21 model requests and records five terminal Turns,
36 native entries and 190 projected native commits. These are bounded acceptance
samples, not a fleet-capacity or latency guarantee.

Private evidence is under
`deploy/production/runtime/release-evidence/session-completion-20261018/`, including
`native-input.json`, `browser-images.json`, `tool-images-20261018.json`,
`child-20261018.json` and `full-cube.json`. The
[full Cube report](cubesandbox-production-acceptance-latest.md) and
[JSON evidence](cubesandbox-production-acceptance-latest.json) identify the host
test checkout and the actual deployed image separately.

### Retained failed samples and fixture correction

The native-input suite initially requested 2,000 mechanically repeated lines.
Two attempts ended normally with only 49 and 58 characters before the respective
dual-crash/Stop injection could start. These fail the fixture's prerequisites;
they are not passing recovery samples. A separate attempt failed its consume
Run while CLIProxyAPI recorded upstream `TLS handshake: EOF` at 12:02:22 local
time. All three failed fixtures were cleaned and their evidence retained.
Five subsequent credential-free uTLS handshakes through the existing proxy passed;
that observation does not establish that the intermittent TLS issue is fixed.

Host-only commit `d8b7b6b4c96d4bf15cd111c8720eabcca0be342f` replaces the repetitive
prompt with an 80-section technical handbook and adds script/helper hashes and
failed-Run codes to private diagnostics. All existing length, persistence, Stop,
crash and recovery assertions remain. The 77 helper tests pass. There is no
runtime/package/deployment diff from the serving artifact source, so this does
not require a second application rollout. The complete five-case native-input
suite and final full Cube suite pass with this host fixture revision.

The owner subsequently confirmed switching Windows v2rayN to a backup node.
The successful suites above had already completed; this report does not attribute
their success to that later route change or claim the upstream TLS problem solved.

## Cleanup and final state

Normal APIs closed/deleted owned Sessions and Workspaces before physical purge.
Native checks confirm zero Volumes, node attachment references, holders and
open/non-absent allocations. The owned full-Cube tenant was removed only afterward.
Three exact Tool-image objects were deleted after locking metadata and checking
their hashes and absence of references/uploads/unsealed source Runs. Three
physically purged bootstrap-tenant fixture projects/Workspaces were then removed.
Ownership and fencing guards were not bypassed.

Final inventory scans the sole native node and finds zero VMs. Active Runs,
writers, bindings, runtime/machine/terminal lifetimes and pending controls are
zero. No test project, Workspace, Session, Run, image object/reference or upload
remains. All 28 serving Pods are Ready; Windows and WSL localhost web checks both
return HTTP 200. No temporary build proxy or disposable Docker test container remains.

All seven original configuration fingerprints match `before.json`: 32 tenants,
users and API credentials, five password credentials, 35 model profiles and
credential bindings, and zero source-control credentials. Volatile API-credential
last-used timestamps are excluded from that comparison. Physical cleanup and
metadata/configuration checks are recorded in `cleanup-20261018.json`, `after.json`
and `final-verification.json` in the private evidence directory.
