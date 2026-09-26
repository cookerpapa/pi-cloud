# ADR-0195: Final Tool reply lifetime

Status: implemented and validated, 2026-09-27, under the owner's repository
review and obsolete-code cleanup request. See the
[repository review](../reports/repository-review-20260927.md) for regression,
matched local rollout and real Luna/Cube/browser acceptance.

## Decision

Enforce ADR-0184's existing transport split: Kafka Tool replies carry one final
native result per operation. Guest progress remains lossy Broker HTTP / Projector
SSE. Remove Kafka update events and Worker progress-callback plumbing from this
reply path; retain Pi's native update APIs where guest and trusted tools use them.
The existing final reply has sequence 1. Reject non-final or differently sequenced
replies rather than retaining an obsolete incremental-result compatibility path.

Remove the retired per-operation guest commands (`bash.exec`, `file.read`,
`file.read_range`, `file.write`, `file.mkdir`, `file.access`) and the unused
SandboxProvider readFile/writeFile port. Production Agent callers already send
whole `tool.execute` or scoped `workflow.exec` commands under ADR-0183. Human
Workspace browsing and environment credentials use their separate current ports;
local helpers still used by native Tools remain. Update executor/security fixtures
to exercise the real whole-Tool path, retaining their fencing/failure assertions.

Register the waiting callback before publishing a command, observe rejection
immediately, and retire that callback when the operation leaves. A Worker adapter
may asynchronously decode image attachments after mailbox completion; suppressing
only the mailbox's original Promise rejection does not protect that outer Promise.
Publication failure and cancellation must remain handled failures of the current
Tool, never an unhandled rejection that stops unrelated Worker families.

Preserve operation identity, native Tool IDs, canonical after-hook processing,
Kafka replication acknowledgements, commit-before-dispatch, seals and UNKNOWN.
There is no effect retry, completed-result cache, new scheduler, or second writer.
Use the existing Pi Tool async callback and AbortSignal interfaces.

## Acceptance

Cover publication failure, reply rejection before publication acknowledgement,
cancellation, duplicate/late replies, wrong identity, rejected progress replies,
image decoding and ordinary completion. A strict Node child-process probe must
survive an adapter publication failure after the Tool caller catches it. Deploy
matched Broker and Worker builds with no active work; no old transport branch is
kept for rolling mixed-version execution.
