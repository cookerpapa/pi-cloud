# Proposal: `/usage` and manual `/compact` — 2026-10-25

Status: proposed for owner review; no runtime implementation or deployment.

## First slice

Add a small composer command menu with `/usage` and
`/compact [optional summary instructions]`. These are user operations handled by
the application. They do not become model-offered Tools or ordinary prompt text.
No command plugin system, scheduler, new event broker or usage accounting service
is proposed. The owner's decision against browser update notifications remains.

`/usage` is available while idle or running. The proposed first manual-compaction
slice requires physical-Session quiescence: no queued/executing root work or active
native family. A busy Session reports that compact is unavailable and preserves
the draft. Native automatic compaction continues unchanged. Supporting concurrent
manual compaction during generation is explicitly outside this first slice.

This restriction belongs to the proposed cloud integration, not Pi itself.
Pinned Pi 1.0 supports manual compaction alongside generation and places the
summary at a native boundary. A manual compaction is a foreground native task.
PiCloud currently keeps one request-context pointer per Conversation and shared
sampling state; enabling overlapping requests requires separate task/request
binding and recovery validation before removing the restriction.

## Composer behavior

- Typing `/` at the start offers the two commands, with filtering, keyboard and
  pointer selection. Enter executes a selected command; Escape closes the menu
  while retaining input. Composition/IME Enter never submits.
- Only exact registered command tokens are intercepted. Paths such as
  `/home/user/project`, prose containing a slash and code remain ordinary text.
  Normal messages keep the existing Enter follow-up/steer preference.
- `/usage` opens a compact panel with a refresh action, without a chat bubble or
  a new Run. It does not consume attached uploads or unrelated draft content.
- `/compact` creates a small action/status row, with technical details expandable.
  It is not rendered as a fabricated user message or generated assistant reply.
- While manual compact is active, allow draft editing and existing Stop, with
  ordinary message submission temporarily disabled. Backend admission enforces
  the same rule across tabs and retains rejected drafts. This avoids launching a
  GenerationTask alongside the maintenance task in this slice.
- File attachments are not inputs to these commands. Preserve them; do not clear
  or send them implicitly. Existing read-only child views permit usage queries,
  not new mutation privileges.

## Usage contract

The panel shows the selected/executing model, cumulative model input/output,
cache-read input, optional cache-write input when relevant, current estimated
context, total context window, automatic-compaction threshold and an update marker.

The canonical source for spend is Pi's committed `pi.usage` document, grouped by
provider/model. Reuse that cumulative state rather than rescanning lifetime
assistant messages or maintaining another authoritative counter table. Active
Worker snapshots may supply fresher committed information; PG remains the cold
read path. Return a PiCloud-owned schema with its snapshot position/freshness.

Pi's OpenAI adapter separates uncached input, cache reads and cache writes.
Display input total as their sum, with cache reads shown as a subset; do not add
cache reads twice when presenting a grand total. Compaction use remains in the
native model totals. Generation-in-progress or missing provider usage must not
be presented as precise final billing. This feature is not a subscription-quota
or CLIProxyAPI-account dashboard. Tool-side model use is included only where it
reports native Tool usage; unreported image-service use is not invented.

Default scope is the current native Conversation's generated spend. Native forks
initialize usage separately, so inherited context does not imply inherited spend.
An optional child breakdown/total follows this Conversation's Subagent relations,
excluding unrelated forks. Context windows remain per Conversation and are never
summed across agents. Batch child-document reads instead of one database round trip
per child or reopening every historical Harness.

Context usage is separate from cumulative spend. Reuse Pi's estimate conventions:
the latest applicable model usage plus new effective context, with a structural
estimate when a fresh compaction/configuration invalidates that baseline. Include
system/tool definitions and model-visible messages; inspect the latest compaction
and active suffix, not lifetime history. Keep image bytes out of a statistics query.
Use the active Run's frozen model/window while it runs, and the selected next model
when idle; label estimates and stale/unavailable values honestly. Compression lowers
context occupancy, not cumulative usage; cached input still occupies context.

Refresh on panel open/manual refresh and relevant committed response/compaction
changes while visible. No per-token database writes or always-running counter poller.

## Manual compaction path

1. The browser assigns an idempotency key. Control Plane validates writable scope,
   physical-Session quiescence and a usable model, then durably admits a typed
   maintenance Run through the existing PG queue. Keep payloads in existing input
   storage and queue rows bounded. A queued acknowledgement does not claim that
   compression has completed.
2. A Worker claims the existing Session lease/writer, opens the native Session and
   calls public `Conversation.compact(instructions, context)`. It does not submit
   a fake user prompt, start an ordinary answer generation or activate Cube.
   Missing/paused compute does not block maintenance of retained conversation data.
3. Associate the cloud command ID with the native compaction Task in the same
   Session publication commit. Validate this at the current storage-publication
   adapter; do not call compact and persist its receipt as two independent durable
   steps. Indexed command lookup belongs to existing native metadata, not a new
   command queue or operation-result ledger.
4. Pi selects the old prefix, generates the summary and admits its native summary
   write. The Worker waits for actual placement, not just summary generation, then
   finishes the maintenance Run and retires its writer through the existing path.
   Result states distinguish applied, nothing-to-compact, cancelled and failed.
5. Show a concise result, with before/after context estimates when available. The
   normal chat transcript and retained images remain stored. Optional instructions
   guide the summarizer, e.g. retaining API decisions and unfinished work.

Concurrent normal-message admission must serialize with the idle check. If a
message wins first, reject compact as busy; if maintenance wins, later submissions
remain drafts until it finishes. Do not turn them into a second follow-up queue.
Use the Conversation's selected model, frozen on admission, without silently
switching to a cheaper model.

Lost replies return the same command/task on retry. Worker failure follows existing
ordered old-writer closure and same-Run recovery; Durable resumes the original Task.
The existing Stop aborts this maintenance work. It does not stop VM background
processes. Never report a changed context unless the summary write is committed;
provider failure or no compactable range must leave usable prior context intact.

## Implementation and acceptance

First validate the public SDK/native publication join: one compact admission,
lost-ACK deduplication, summary placement, Stop and recovery under the existing
Session writer. Record the accepted work-kind/protocol decision in an ADR before
runtime changes. Do not alter Pi Core or introduce a parallel compaction scheduler.

Then implement the read-only usage API and menu, followed by the maintenance Run,
Worker control path and action presentation. This spans Web, Control Plane, Worker
and protocol/storage metadata, so its initial publication is matched; it is not
eligible for the ordinary-Control-Tool-only release path.

Acceptance must cover:

- Both commands, paths/prose containing slashes, IME, Enter/steer preference,
  Escape, attachments and draft retention.
- Input/cache arithmetic, multiple models, native compaction spend, fork and
  child scoping, stale/missing usage and no lifetime transcript replay.
- Current-window estimates after new Tool results, compaction and model changes;
  a statistics query performs no model request or VM activation.
- Idle/normal-message races, duplicate requests and lost acknowledgement, Stop,
  Worker recovery, genuine summary placement, no-op and provider failure.
- Real Luna maintenance of an existing conversation, followed by continuation;
  no extra user/assistant prompt bubble, preserved queued drafts/history/images,
  normal writer retirement and confirmed owned fixture cleanup.
