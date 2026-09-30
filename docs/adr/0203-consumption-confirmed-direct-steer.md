# ADR-0203: Consumption-confirmed direct Steer

Status: implemented and locally validated, 2026-09-30, after the owner approved
closing the Worker-loss gap discussed while reviewing input and sandbox recovery.
Matched deployment and real Luna process-fault acceptance remain the release gate.

## Decision

Direct human Steer uses ADR-0194's existing pending-input lifecycle. Accept its
source Turn/Run and queue/steer control request in one PostgreSQL transaction,
holding that source out of execution until consumption or definitive closure.
Text and uploads belong to the source Turn; the control row contains bounded
references. Reserve its ordinary mailbox position at acceptance. No second
queue, recovery scheduler or Pi Agent Loop modification is introduced.

The source inherits the active target's frozen model, credentials, environment,
Tool grant and execution directory. A later fallback therefore preserves the
execution settings under which the human submitted the instruction, even if
the Session's desired settings change. Existing upload validation and the
64-pending-input limit apply. Only an active, authorized ordinary conversation
can accept a new direct Steer; replay of the same accepted request is valid
after the target closes. Request identity includes its target and attachments.

Both direct Steer and queue promotion use the same HTTP delivery and native
input ID. HTTP success records acknowledgement, not consumption. Only the
canonical user Entry confirms consumption and retires the held source. A target
seal plus absent Entry restores the source to its reserved queue position.
Unknown delivery or projection lag cannot release it. A stopped/failed target
does not cancel unrelated pending inputs. The recovered source executes only
when existing Lane readiness and Session recovery permit it; the target Run
and arbitrary Tool effects are never replayed.

Acceptance locks the Session without changing referenced keys and takes target
Run locks with NOWAIT. This avoids a cycle with admission/settlement and remains
compatible with Tool-binding foreign-key KEY SHARE locks. No network call is
made while holding a database transaction. Late transport outcomes cannot
overwrite a canonical consumption or restoration decision.

## Product and protocol

POST /v1/sessions/:sessionId/turns/:turnId/steers returns HTTP 202 with
state `accepted`, target Run/Turn IDs, source Run/Turn IDs, control request ID,
acceptance time and replay status. Remove the old `delivered`/`deliveredAt`
response; it incorrectly implied more than memory-queue delivery. The accepted
source appears as `steering` in the existing pending-input view. It disappears
on consumption or becomes an editable ordinary queued input after restoration.
The browser preserves submission identity when retrying a lost acceptance reply.

Native in-Run Subagent messages and settlement reminders retain their existing
contracts. This decision covers human conversation input, not autonomous task
wake-up or recall of already-delivered native input.

## Adoption and acceptance

Reuse the maintained PG queue/locking and public Pi input adapters evaluated in
ADRs 0179, 0193 and 0194. A separate queue package would add another authority
without making PG-to-Worker delivery atomic. Remove the old direct delivery
implementation rather than retaining two recovery paths. No schema change is
needed; historical completed control rows remain historical evidence.

Require real-PG tests for atomic acceptance, same-key races, target/FK lock
compatibility, consumption versus seal, acknowledged-but-unconsumed Worker loss,
lost HTTP replies, delayed projection, cancellation and source queue ordering.
Cover attachment and frozen-setting preservation, queue limits, tenant/viewer
isolation, late outcomes, browser retry identity and pending presentation. Run
the relevant native input tests and a real GPT-6 Luna recovery check. Deploy
matching API/Web only after old active inputs have drained; preserve native
history and use no compatibility response or Run replay.
