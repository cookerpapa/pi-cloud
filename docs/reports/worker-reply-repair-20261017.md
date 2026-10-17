# Worker reply delivery repair

Date: 2026-10-17–18 (Asia/Shanghai).
Plan: [ADR-0254](../adr/0254-worker-reply-admission-and-settlement.md).
Implementation `0afcad85` passes the required source/repository gates. The matched
release `worker-reply-b1f67dba` is deployed from source `b1f67dba`, with required
live acceptance and physical fixture cleanup complete. The initial missing-KVM
blocker and failed model fixture remain recorded below. Artifact IDs/checksums
come from the private matched-release evidence, separately from source tests.

## Source behavior

- Worker HTTP readiness and new-Run admission combine the cached Kafka partition
  mask with current local reply-consumer health. Provider HEAD admission/startup
  checks and their unused method are removed. Active Runs retain their original
  deadlines, native cancellation and ownership boundaries.
- The reply consumer uses its existing volatile processed position on reassignment.
  It joins old handlers, clamps reclaimed positions and retains impossible
  positions as unhealthy across repeated reassignment. Durable Projector recovery
  keeps its separate existing behavior; incompatible options are rejected.
- A current invocation's wait handle distinguishes known execution settlement
  from its eventual decoded result. Valid final replies and confirmed
  `not_started` set the indication before resolving/rejecting. UNKNOWN, mismatched
  identity and retired late replies do not fabricate settlement.
- Image restoration has the caller's lifetime/cancellation signal and its existing
  storage budget. The already-satisfied receipt deadline cannot interrupt that
  later stage. Attachment failures keep their own safe error and native Run
  interruption reason, without marking the sandbox unavailable or requesting
  cancellation of completed Tools. Pi still owns the canonical result and abort.
- Fixed Tools, control Tools and workflow hostcalls use the same new internal
  wait contract. Raw and decoded Promise failures are observed before intent ACK;
  the old combined-result completion flags and baseline bug-expectation probes
  are removed rather than retained as compatibility paths.

## Source verification

Initial targeted checks pass: Worker lifecycle/model/admission (22), reply mailbox
and reader tests (29 before the additional decode-retry case), fixed/control
adapter contracts (68), and parallel-claim/control-result contracts (12).
Five composed real-Harness/image cases verify attachment failure, integrity,
Stop during restoration and receipt-deadline precedence. The model, byte store
and Cube response are isolated fixtures; no model provider or real VM is used
for these five cases.

Three additional native termination races reproduced an existing outer-Runner
priority bug: an earlier Tool diagnostic replaced a later native Stop, lease
revocation or writer-publication failure. The outer adapter now preserves those
native terminal causes. All eight image/priority cases and the three existing
native bootstrap/Stop cases pass together. A separate microtask-return regression
checks cancellation again after decoding, preserving receipt without returning
late content. These cases are included in the expanded 270-case fault index.

The expanded isolated RF3/PG transport suite passes all nine tests in eight files,
including the new same-boot reply reassignment case. The original 100 replies
remain single deliveries after reassignment while the next callback completes;
no per-reply offset commit is introduced. Existing ordered projection/fencing,
native child and Stop/binding transport cases pass.

The first new image fixture used an incomplete Entry query and assumed exactly
two model calls in a successful environment-reminder flow. Correcting the fixture
to supply its Conversation and to assert one original Tool plus successful
continuation resolved those failures. They were not product failures. The three
attachment-failure cases still strictly require one model request and no next
sampling. The fixture's fake completions provider is explicitly test-only;
production provider configuration remains pinned to Responses routes.

The complete workspace run passes **1,817 tests**, plus **77 acceptance-helper
tests**. All **270 indexed fault cases** pass. Dependencies, formatting/docs,
installer, runtime policy, native Cube admission/allocation/Volume contracts,
Helm, observability, image closure, builds and all workspace type checks pass.
The final cancellation-priority delta also passes its affected package type
checks and the composed native tests. The npm security audit reports no remaining
vulnerabilities. The nine real RF3/PG tests above are separate from the default
workspace run's intentionally skipped transport fixtures.

The initial format command encountered the two unstaged deleted review probes;
staging their removal allowed the required tracked-file formatting gate to pass.
No acceptance policy was weakened. Private full-check and failed/passing priority
logs are retained under `deploy/production/runtime/release-evidence/worker-reply-20261017/`.

## Initial host blocker before deployment

Read-only preflight on October 17 found `/dev/kvm` absent both on the WSL host
and in Cubelet. The AMD Ryzen 9 7945HX guest exposes neither SVM nor VMX;
firmware virtualization is enabled. Windows reports build `26200.9711` with
`KB5127648` installed. The previous October 16 guarded rollback receipt recorded
that exact update's removal; subsequent evidence confirmed KVM API 12 and an
actual empty VM before the prior release's successful live tests.

The current observations match the Windows-update regression acknowledged by
the [WSL maintainers](https://github.com/microsoft/WSL/issues/41917). The merged
[warning change](https://github.com/microsoft/WSL/pull/41942) explicitly does not
repair the underlying Windows regression. This is a diagnosis supported by
matching symptoms/version, not a fresh administrator-level reproduction of the
HCS failure: this turn's Windows process is not elevated and its HCS queries
returned `0x8037011B`, so administrator verification remains necessary.

That initial WSL-side attempt performed no Windows update removal, host restart
or application drain. It retained the KVM preflight and supported sandbox boundary.
Private `before.json` records zero active
work/writers/VMs and the seven configuration fingerprints: 32 tenants/users/API
credentials, five password credentials and 35 model profiles/credential bindings.
Those original accounts/configuration remain intact after the completed delivery.

## Host recovery and matched deployment

On October 18 the separate host operator completed the guarded KB5127648 rollback
and the owner restarted Windows. The host reports build `26200.9457`, no pending
CBS reboot and a temporary Windows Update pause through October 25. The pause
requires review before expiry; a warning-only WSL change is not a Windows servicing
fix. No update/security service was permanently disabled.

The WSL-side continuation independently verified SVM, KVM API 12 and actual empty
VM creation. The maintained operator checked Cubelet device access, source/image
identities and idle PG/native state before draining. Candidate preflight and apply
then passed without bypasses or a partial-version fallback. All four new templates
are registered; four obsolete templates were removed with no deferred cleanup.

- Application/native version: `worker-reply-b1f67dba`, source
  `b1f67dba71b0e2cf0d1ba99773c82c0367c9bbb8`.
- Seven application images, three native Cube images and one guest image passed
  the existing eleven-artifact evidence gate, with zero fixable HIGH/CRITICAL
  findings under its recorded scan policy. Unfixed findings remain reported;
  the policy was unchanged.
- Guest identity: `6fd981cd0a6b45b2bfb135fa3f987e7a193cc62d`;
  registered OCI digest:
  `sha256:a802c880daa3bdd8df9de9857324ed4771b4b9c559b68b60430d42e8421f15ca`.
- Completion identity: `509a416b37f0c9d4b658bc7f93216641ec6b9cbc`.
- Schema 189, execution topic v17, reply v3, guest/Tool protocol 7,
  completion startup 3, preview 2 and Cube management 7 remain unchanged.

Private evidence is under
`deploy/production/runtime/release-evidence/worker-reply-20261017/`, including
the scanned candidate, `apply-20261018.log`, deployed identities and host receipts.

## Live acceptance

All live model cases use GPT-6 Luna and owned fixtures:

| Maintained check | Result |
| --- | --- |
| Native inputs and live progress | All five cases pass: edit/retry/consume, Stop restoration, Worker replacement, streaming Stop, and simultaneous Worker/Control Plane memory loss. The same logical Run resumes; observed text survives and streaming bodies stay out of PG. |
| Browser/Read | Lost admission reply, draft removal, Stop, returned text/image and resend pass in a real browser. Direct vision passes. Native `@` Read preserves 51,200-byte ASCII and 51,196-byte Unicode prefixes and canonical continuation diagnostics. |
| Tool image attachments | Three actual Bash → Read image replies contain 6,294,492, 6,294,400 and 25,129,533 bytes. Their image-bearing native log records are 596, 596 and 597 bytes. Integrity, overwritten-source preservation and tool-free visual recall after Worker replacement pass. |
| Child/control reply | Compatible Control Plane replacement takes 14,212 ms. The original Worker remains; the child Bash executes once and its parent control Tool reply completes through Kafka. Child identity stays native, without a child cloud Run. |
| Full Cube suite | Pure chat avoids Cube. Multi-round coding, authenticated preview, background-process survival, tenant isolation, persistent Volume attachment to a fresh VM, late-command rejection and confirmed native allocation closure pass. |

The [full Cube report](cubesandbox-production-acceptance-latest.md) and its
[machine-readable evidence](cubesandbox-production-acceptance-latest.json) record
this source revision. Detailed private reports are `native-input-20261018-retry.json`,
`browser-images-20261018.json`, `tool-images-20261018.json` and `child-20261018.json`.
These checks supplement the isolated attachment-failure/race and actual RF3
reassignment tests above; live success alone does not establish those failure cases.

The first native-input run passed its initial three cases, but the streaming
fixture completed normally with only 44 characters before fault injection was
possible. It was not a passing streaming test or a TLS failure. Its report is
retained as `native-input-20261018.json`; repeating the unchanged fixture passed
all five cases. No assertion or product timeout was relaxed.

During the double-crash case a fresh Worker container also exited once with code
1 and the safe `pi_worker_start_failed` diagnostic, then recovered through kubelet.
The generic log does not identify the failed initialization stage, so its precise
cause is not claimed. The extra startup receipt is retained separately; the same-Run
recovery and native-history assertions passed, and all Workers are Ready afterward.

## Cleanup and final state

Normal APIs closed owned work and deleted Workspaces. Positive native checks then
confirmed zero Volumes, attachment holders and open/non-absent allocations before
fixture metadata was removed. Owned temporary tenants were removed with the existing
acceptance helper. The three recorded Tool-image objects were deleted only after
locking their metadata and rechecking native references, uploads and source-Run
settlement. Three physically purged bootstrap-tenant fixture projects/Workspaces
were removed; no ownership guard or original account/configuration row was deleted.

Final checks confirm zero active Runs, writers, bindings, VM lifetimes, terminals
or pending control records; native inventory scans the sole node and finds zero
VMs. No test Sessions, Workspaces, projects, image objects/references or uploads
remain. All serving Pods are Ready. Both Windows and WSL return HTTP 200 from
the local web entry. The seven original account/model/provider/credential
fingerprints match `before.json`; `cleanup-20261018.json` and `after.json` retain
the evidence. This completes ADR-0254 delivery, not a fleet-scale or HA claim.
