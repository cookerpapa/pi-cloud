# Worker reply delivery repair

Date: 2026-10-17. Plan: [ADR-0254](../adr/0254-worker-reply-admission-and-settlement.md).
Implementation `0afcad85` passes the required source/repository gates. Matched
deployment and live acceptance are blocked before draining by the host's missing
KVM device. The serving release remains `tool-unknown-791a6ed0`. Candidate artifact
preparation can proceed independently; its signed-off image IDs/checksums are
recorded by the existing private matched-release evidence, not inferred from
these source tests.

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

## Host blocker before deployment

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

No Windows update removal, host restart or application drain was performed.
Restore and verify host KVM before applying the matched candidate and running
Luna/Cube/browser/child recovery acceptance. Do not bypass the preflight or
substitute another sandbox runtime. Private `before.json` records zero active
work/writers/VMs and the seven configuration fingerprints: 32 tenants/users/API
credentials, five password credentials and 35 model profiles/credential bindings.
Accounts/configuration must remain intact and owned acceptance resources must be
physically cleaned before this delivery is marked complete.
