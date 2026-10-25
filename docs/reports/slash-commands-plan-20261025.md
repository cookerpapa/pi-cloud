# Revised plan: model waits and input commands — 2026-10-25

Status: revised for owner review after the implementation request and subsequent
architecture discussion. No feature code has been changed. The deployed
[240/270-second header budget](model-header-budget-delivery-20261025.md) remains
in effect. This document replaces the earlier idle-only compaction proposal;
that proposal remains in Git history.

## Scope and ownership

Implement three complete slices: model-event waiting, read-only `/usage`, and
input-driven `/compact`. Preserve Pi 1.0.0 public APIs, the physical-Session
writer, native Task continuation, PG execution authority and Kafka publication.
Record protocol/ownership decisions in an ADR before feature implementation.

| Operation | Active physical Session | Quiescent physical Session |
| --- | --- | --- |
| `/usage` | Read committed usage and available context estimates | Read the PG materialization without starting an Agent |
| `/compact` | Deliver to the current Worker; create a Pi Task inside the current cloud Run | Acquire a Worker and the existing Session lease before native compaction |
| Automatic compaction | Native Pi Task within the current Run | No independent background scheduling |

A running `/compact` never creates another cloud Run. A native Compaction Task
is distinct from the cloud work/lease record. Command input is not ordinary model
input and neither command is offered as an LLM Tool.

For cold admission, the proposed bounded choice is an explicitly typed maintenance
Run in the existing queue. It is an internal execution record, not a fabricated
chat Turn. This choice is described separately below; it must not be silently
presented as eliminating every Run record for manual compaction. Decoupling all
Worker/Session ownership from Run records would be a larger architectural change.

## Model waiting

Replace the overlapping 240-second Gateway header deadline, 270-second Pi header
deadline and byte-based stream-idle interpretation with clearly separate concerns:

- Retain an actual bounded connection-establishment timeout, initially 15 seconds
  for the Worker Gateway's outbound connection. A timer around the whole `fetch()`
  is not a connect-only timeout. Existing provider relay connection bounds remain.
- At the trusted Models adapter, allow 300 seconds without a valid provider event.
  Start after authority/model-permit admission when the provider request begins;
  permit-queue waiting does not consume that budget. The initial wait is included,
  even while CLIProxyAPI withholds response headers until its first data frame.
- Restart the inactivity deadline when Pi exposes a valid provider event through
  its existing public callback. Visible text is not required. Transport comments,
  TCP keepalive and arbitrary bytes alone do not count as model progress.
- Use the public SDK settings to disable the competing header deadline for the
  fixed adapters. Verify both GPT and DeepSeek routes; do not assume every SDK
  interprets zero identically. The Gateway remains a transport adapter and does
  not gain another SSE interpreter.
- Keep no overall Agent duration limit. Stop, authority loss, Worker retirement
  and native cancellation still abort a pending request immediately.
- Classify an inactivity timeout as a retryable model transport error, preserving
  committed partial-text policy. An actual user Stop remains native cancellation,
  not a retry. Late completion cannot overwrite either terminal decision.
- Let Pi Durable alone own bounded generation/compaction retries. Set its public
  retry policy to five retries, keep provider/SDK extra retry loops disabled, and
  derive displayed retry counts from that policy rather than a hard-coded four
  attempts. Infinite connection-only retry is outside this slice.

Including the initial no-event wait is an explicit cloud policy. It approximates
Codex's event-idle behavior but is not a claim that Codex's HTTP response-header
phase has this same bound. Do not label the implementation an exact copy of every
Codex transport/reconnection rule.

Reuse operational timing output with native Task/attempt/purpose, first provider
event and a specific terminal cause. Timing must be per model request, including
simultaneous generation and compaction. No prompt/image/credential logging or
new Kafka/PG observation history. The separate CLIProxyAPI upstream phase-timing
proposal remains a follow-up; local activity timing cannot prove whether the
provider was internally queueing or computing.

## Input interaction

The composer is the primary entry, with a small completion menu after a leading
`/`. Support `/usage` and `/compact [optional summary instructions]`. No dedicated
compact-launch button or browser update prompt is added.

- Only exact command tokens are intercepted. `/home/user/project`, slash-containing
  prose and code remain ordinary input. Invalid command arguments keep the draft.
- Enter executes the recognized command; IME composition never executes it.
  Escape closes completion while retaining input. Ordinary messages retain the
  account's Enter follow-up/steer preference.
- A running `/compact` is a typed control operation delivered to the current
  owner, not a steer prompt containing the literal text `/compact`. It does not
  wait for the entire original cloud Run to finish.
- Preserve uploads and any unsent/restorable input. Attachments are not silently
  sent, discarded or counted as inputs to either command.
- `/usage` opens a small statistics view, without a user/assistant bubble or Run.
- `/compact` has a brief inline action status. Distinguish accepted, summarizing,
  awaiting native placement, applied, no-op/stale, cancelled and failed internally;
  show concise user wording and keep technical identifiers out of the main flow.
- During compaction in an existing chat Run, ordinary follow-up/steer continues
  through native admission. During a cold maintenance execution, preserve draft
  editing and Stop, but hold ordinary message submission until maintenance settles;
  do not accidentally start tool-capable generation under a maintenance grant.
- Read-only child views retain usage access without acquiring mutation rights.
  The first mutation scope is the currently writable conversation.

## `/usage`

Use the committed native `pi.usage` document as the cumulative source, grouped by
provider/model. Do not scan lifetime assistant history or add a competing counter
or billing table. Use a PiCloud-owned public response schema; no Harness runs in
the Control Plane.

Show model, input total, output, cache-read input, cache-write input when present,
current estimated context, total window, automatic-compaction threshold and
snapshot freshness. Input total includes uncached input plus cache-read/write
input; cached input is a subset and is never added twice to a grand total.
Compaction model usage remains included. Missing provider usage and an in-flight
request are not precise billing. Unreported image-generation service cost is not
invented from the chat model's counters.

Default scope is the selected native Conversation. A separate child breakdown
uses existing delegation relationships and batched document reads; unrelated forks
and inherited spend are excluded. Context windows are per Conversation, not a
sum across children.

Context occupancy is separate from cumulative spend. Reuse native estimation
conventions and the latest applicable compaction plus active suffix, including
model-visible system/tool definitions. Read metadata without hydrating image
bytes. Use the active Run's frozen model/window while running and the selected
next model while idle; mark stale, estimated or unavailable values accurately.
A fresh compaction or model change invalidates a prior usage baseline when needed.

Open/manual refresh and relevant committed model/compaction changes refresh the
visible panel. No per-token SQL writes or permanent hidden poller. Cold queries
read PG without waking Cube or a Worker; fresher active information uses the
existing authorized Worker connection. Snapshot positions prevent an older PG
read from replacing a newer active result.

## `/compact` during an existing Run

```text
Composer control input → Control Plane → current Worker / current Run
    → public Pi manual-compaction admission
    → same Session Storage commit → Kafka → Projector / PG
    → native summary-write placement → updated context / inline status
```

The Control Plane validates writable scope and routes to the current Session
owner. It does not create a claimable Run or enqueue a second copy of the command
body. Use the existing management route and native-writer acknowledgement model.

Pi's public `Conversation.compact()` creates a conversation-owned foreground
Compaction Task. It selects a stable old prefix, generates a summary and submits
that summary as a native write. On an active conversation, Pi places the write at
its own boundary or settles it stale. The in-flight model request's context is
not rewritten halfway through. The next request that follows actual placement
uses the compacted view. Summary generation can overlap ordinary work, subject
to the existing fair model permits; do not promise placement at the very next
Tool completion if the summary is not ready.

The cloud work must retain ownership until both the native compaction Task and
its summary-write submission settle, including when the original Agent finishes
first. Read the native result rather than treating Task completion alone as
successful application. No-op/stale results do not claim that context shrank.

Each command has a stable request identity and fingerprint. Native task creation
and that receipt must be acknowledged together under the existing writer. Use
public native transactions or publication metadata with an indexed projection;
prove the precise seam before implementation. Do not fabricate/strip committed
Storage writes, copy private Pi compaction internals, or add an independent command
queue/result ledger. Lost acknowledgement and Worker replacement must find the
same admitted Task. A changed payload cannot reuse its idempotency key.

If an active owner is unavailable, retain the unconfirmed command in the composer
and retry its identity. If Run retirement races with admission, either the old
owner commits it and keeps it within that Run, or it refuses before acceptance.
An uncertain reply must be resolved before routing it through cold admission.
Never create a second compression job simply because the old Worker cannot reply.
While one manual compact is outstanding for the Conversation, a repeated request
with the same identity returns its status; a distinct command is refused as busy
and retained for editing rather than silently ignoring different instructions.

Use the active Run's frozen model and reasoning policy. Manual summarization does
not activate a VM, add guest Tools or require a running development machine.
Stop keeps its native scope and aborts the admitted foreground compaction; no
unrelated VM-process policy is added. A failed summary leaves prior usable context
intact and is shown as an action failure, without pretending the original chat
Run necessarily failed too. Normal native settlement decides the latter.

## Cold admission: proposed reuse of existing cloud work

When no live root work/Session owner exists, calling the API cannot make the
Control Plane run Pi or write active native Storage itself. The recommended
bounded implementation uses one typed `maintenance/compact` Run solely to reuse
PG admission, claim, the physical-Session lease, Kafka fencing and recovery.

This path needs a schema/dispatch distinction rather than a synthetic prompt:
no user input or fake assistant answer, no Cube preparation, and no
requirement that a machine be running. Freeze the selected model on admission.
The maintenance worker runs the same native compaction implementation and retires
through ordinary ownership closure after placement/no-op/failure.

Serialize cold compact admission and ordinary message admission under the existing
Session lock. If a chat Run wins, route to that owner after resolving request
identity. If maintenance wins, a concurrent ordinary send remains an unaccepted
browser draft until maintenance finishes; never create a duplicate input queue.
Never reopen a terminal Run or reuse its old writer identity to avoid creating a
properly authorized work record.

The UI contains no new chat turn for this execution. Nonetheless a maintenance
row really exists in `runs`; this tradeoff is explicit. Eliminating even this row
would require separating queue/lease/model-grant/settlement ownership from Run
throughout the runtime, not merely renaming a field or adding an out-of-band RPC.
That broader ownership refactor is not recommended for these commands.

## Required adapter repair and implementation order

1. Prove the fixed Pi public seams with controlled fixtures: simultaneous
   generation/manual compaction, immutable source selection, summary placement,
   command/task deduplication and recovery. Current `DurableAgentSession.#requests`
   stores one context per Conversation, and `DurableSampling` is shared by the Run;
   both can misattribute overlapping calls. Bind identity, purpose, retry attempt,
   payload/headers, model permits and timing per native Task/request, including
   reopened compaction that does not repeat `beforeCompact`.
2. If the fixed public SDK cannot express an unambiguous identity/atomic receipt
   seam, document the exact missing API and the smallest public extension before
   shipping. Do not infer identity from the summary prompt, touch private scheduler
   state, or silently fall back to idle-only manual compaction.
3. Record the approved protocol/work-kind decision, then implement model-event
   waiting with native cancellation/retry contracts. Keep its tests separate from
   the command UI so failures are attributable.
4. Implement the native usage read adapter, PiCloud-owned API and input menu.
5. Implement current-owner compact admission, canonical action view and recovery;
   then the separately typed cold work path and its admission races.
6. Complete source/fault/browser/native acceptance and a matched publication,
   preserving existing conversations, Workspace volumes, accounts, provider/model
   configuration and credentials. This is not an ordinary-Control-Tool-only release.

## Acceptance

- Delayed first response, no first event, non-text provider events, comment-only
  traffic, progressing responses beyond five minutes, idle streams and bounded
  native retries on GPT and DeepSeek. Stop/authority loss during wait or retry
  must terminate cleanly without another provider send or a model-permit leak.
- Command completion, exact parsing, IME, Enter preference, Escape, uploads and
  failed-admission draft retention; no fabricated model prompt or compact button.
- Native usage arithmetic, compaction spend, several models, child/fork scope,
  cold reads, stale snapshots and estimates after compaction/model changes.
- Active compaction creates no extra cloud Run/lease; overlapping requests keep
  distinct Task/purpose/attempt identities. Normal text and Tool completion survive.
- Task-generated versus actually placed summary, stale/no-op/provider failure,
  duplicate submit, lost ACK, Run-ending admission and simultaneous automatic
  compaction. Earlier history/images and queued human inputs remain correct.
- Worker loss during summary or pending placement resumes the admitted native
  task/submission under ordered new ownership; Stop does not restart compaction.
- Cold admission races, paused/unavailable compute, maintenance cancellation and
  subsequent normal chat; no sandbox is activated by either command.
- Owned real Luna/browser fixtures exercise both active and cold compaction,
  usage changes and post-compaction continuation. Verify physical cleanup before
  removing fixture ownership; never use the original user conversation as a probe.
