# Run identity diagnosis and message controls

## Reported Run failure

The reported Galgame Run started at 17:51:08 China time on October 31 and ended
at 18:40:52 with `invalid_command / Command identity changed`. These timestamps
precede the `timing-reader-20261031` rollout.

Its persisted Session ownership history shows:

| Time (China) | Event |
| --- | --- |
| 17:51:08 | First Worker admitted the Run under epoch 36. |
| 18:28:06 | Worker retirement recorded a heartbeat timeout; ordered closure began. |
| 18:28:37 | Epoch 36 was sealed; a different Worker resumed the same Run under epoch 37. |
| 18:40:46 | A second ordered recovery closure began. Its initiating error is not retained in the PG closure reference. |
| 18:40:51 | Epoch 37 was sealed; that same Worker boot reclaimed the Run under epoch 38. |
| 18:40:52 | Supervisor admission rejected the resumed command, settling the Run as failed. |

`AgentRunSupervisor.prepare()` first looks up its duplicate cache by logical
Run ID and compares the entire command payload. That payload includes the
execution reference, writer lease ID and next event position. A legitimate
recovery changes these fields. Because the Run remains nonterminal while it is
requeued, the normal terminal-Run reaper cannot discard its old cached execution.
The duplicate check rejects the command before the higher-epoch admission branch.

An isolated reproduction settled a failed epoch-37 execution, retained its
nonterminal Run, then supplied the same Run under epoch 38. Same-epoch retry was
recognized as a duplicate; higher-epoch recovery was rejected with the reported
message. A fresh supervisor accepted the identical epoch-38 command. No database,
Kafka, model or user Workspace mutation was used in this reproduction.

This is a cloud execution-admission defect, not an LLM error or a user command
editing error. Its repair must distinguish logical work from execution incarnation,
retain fencing and same-incarnation payload checks, and cover stale cancellation
and delayed old cleanup. This investigation does not change that runtime code.
The original failed Run was not resubmitted or rewritten.

## Presentation repair

The completed final footer already styled Copy, Fork and prune together. Settled
answer fragments inside an otherwise active Run, earlier follow-up answers and
paged history used a bare copy button. Those fragments now use the same action
container and translated labels. Existing copy eligibility and final-footer
placement are preserved; a split long answer still copies its entire text once.

Entering bounded historical reading conservatively marks a possible later suffix.
The old UI exposed that internal flag as an always-present “Load newer messages”
button, even without confirmed new output. That button is removed. Downward edge
navigation still loads later pages; return-to-latest remains available.

Failures retain the exact query, direction and optional navigation target for
explicit retry. A synchronous failure guard also prevents a pending scroll/RAF
callback from automatically issuing a second failed read before React renders
the first failure. Earlier/target errors display at the upper controls and later
page errors at the tail.

## Verification and publication

The old browser source failed on the unstyled settling-answer copy. The repaired
message-actions check passes at 1280 and 390 pixels, including follow-up, paged
history, complete multi-fragment copying and final Copy/Fork alignment. A real
wheel gesture enters history without a newer-page notice or query; downward
navigation performs one read, and explicit retry repeats precisely that failed
query. Web types and 222 existing tests passed.

The browser fixture initially included nested human-message copies in its
assistant selector and assumed an inline-flex element would not be blockified
inside a flex row; those test assumptions were corrected. Its paging assertion
also exposed and verified the immediate-failure double-read race above.

Presentation-only Web publication and deployed checks are pending. The Run
identity diagnosis is recorded separately and is not advertised as repaired.
Private reproduction and browser evidence are under
`deploy/production/runtime/work-evidence/command-identity-20261031/`.
