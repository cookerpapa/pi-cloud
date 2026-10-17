# Worker reply delivery repair

Date: 2026-10-17. Plan: [ADR-0254](../adr/0254-worker-reply-admission-and-settlement.md).
Source implementation is complete; repository gates, scanned matched release
and live acceptance are being completed. The serving release is still
`tool-unknown-791a6ed0` until the rollout below is recorded.

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

## Verification in progress

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

Final repository, artifact and live results will be recorded here before marking
the delivery complete. Accounts, model/provider configuration and credentials
must remain unchanged, and all owned acceptance resources must be cleaned up.
