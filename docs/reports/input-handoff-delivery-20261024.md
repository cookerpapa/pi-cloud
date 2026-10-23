# Initial input handoff and service instructions — 2026-10-24

Release `input-handoff-2a5a2ffd`, source
`2a5a2ffd0f4ab2ef6a0a8ba42f4b02da8c54da08`, is deployed at platform Helm revision 95.
Schema 198, native Pi 1.0.0 and the existing execution/storage protocols are unchanged.
Reload an open browser page to load the corrected presentation code.

## Cause and change

An SSE `turn.started` can arrive before the input POST acknowledgement and the
metadata read. The Web reducer created that unknown Turn with an English
placeholder in its `prompt`, and the renderer displayed it as a user message.
The real prompt subsequently replaced it. This was presentation-only text;
it was not persisted as user input or supplied to the model.

The Web view now represents missing input as `null`. Execution and assistant
activity remain visible; the original user row and copy action appear only when
matching input metadata arrives. Empty text remains distinct, so image-only
messages still render their attachments. Acknowledgement/discovery ordering and
new edits to the composer draft do not replace the wrong content or reset live
execution. No API/schema change, additional query or timer was introduced.

The owner also approved simplifying the Worker instruction for background
services. It retains background execution, standard-IO separation and readiness
evidence, and removes the requirement to verify in a separate Bash Tool call.
No periodic progress-narration requirement was added. Tool process lifetimes,
Pi scheduling, cancellation and queue-consumption boundaries are unchanged.

## Verification

- The early-event regression first failed against the old placeholder behavior.
  Web and Worker type checks pass; 242 tests across 29 relevant Web, native Runner,
  guest Tool and matched-release contract files pass.
- Real-browser fixtures delay both acknowledgement and metadata, exercise either
  completion order and a lost acknowledgement, observe user-bubble DOM mutations,
  and retain the draft typed while sending plus existing assistant output.
  The initial fixture's immediate assertion on animated assistant text was corrected
  to await rendering; it was not an application failure.
- The maintained matched procedure built/scanned all 12 artifacts, passed
  provenance and the existing vulnerability gate, and passed preflight before
  and after application. Only the guest's existing immutable artifact was reused
  according to its unchanged build identity.
- Real GPT-6 Luna/Cube acceptance deliberately holds the browser's accepted POST
  response and metadata GET while execution starts. No invented user content
  appears; releasing them displays the exact submitted input. Follow-up intake,
  SSE queue updates, reconnect, edit/move/removal, steer and Stop-return with a
  concurrent draft pass. The live observer uses the stable chat scroller because
  an empty conversation does not yet have a transcript element.
- The owned acceptance conversation and Workspace are removed through product
  APIs. Physical storage purge and writer closure precede temporary-tenant cleanup.

## Preservation and operation

The existing full-release path requires empty Cube compute inventory even for
this Worker-instruction change. After confirming no active Runs/writers/terminals,
the operator quiesced resource controllers, closed the recorded allocation and
confirmed absence on its original node before clearing the live handle. Logical
machine identity, running intent and Workspace identity were retained. The new
controller recovered generation 4, and the previously running application server
was restarted and checked over HTTP inside its guest.

An initial read-only operator probe used an inventory response without a private
ingress token. It failed before maintenance began; the probe was corrected to use
the allocation's authenticated instance receipt. The failed sample is retained.

All 15 protected PG table snapshots and all 27 credential-file hashes match.
The original 33 Workspace files remain; 31 source/artifact files match exactly.
Only the server PID and appended server log changed during the intentional restart.
Final state has 28 Ready Pods plus the completed migration Pod, HTTP 200, one
ready retained machine and zero unfinished Runs, writers, Tool bindings, elastic
fixtures or terminals. No conversations, project files, accounts or provider/model
configuration were reset. The existing compute-retirement operator backlog remains.

Private evidence and restoration records are under
`deploy/production/runtime/release-evidence/input-handoff-20261023/`; matched image
evidence is under `deploy/production/runtime/releases/input-handoff-2a5a2ffd/evidence/`.
The directory date records when the work began. No transcripts, credentials,
screenshots or user repository files are committed.
