# Scheduled Agent inputs

Deployed under ADR-0281 as `schedules-08063299`, schema 202/tool catalog version 3.
[Delivery evidence](reports/scheduled-inputs-delivery-20261026.md) records source,
load, live acceptance and original-asset preservation.

A plan belongs to a root conversation. Each eligible occurrence creates a new
Run in that same Session, using its current model and resource settings. Existing
work finishes and closes its writer before the new Run can start. This is separate
from steer/follow-up, which enter the currently running Pi Inbox.

## Creating and managing plans

Ask the Agent to use `schedule`, for example “Tomorrow at 8 am, summarize this
project” or “Every weekday at 9 am, check the project status.” The tool supports
create/list/get/update/pause/resume/delete. It needs no Workspace or device, and
is exposed only in the root conversation. Children cannot create independent
persistent automation through this tool.

Timing accepts:

- `{"kind":"after","seconds":60}`: compute one absolute deadline from PG time.
- `{"kind":"once","at":"2026-10-27T08:00:00+08:00"}`: a future instant with an offset.
- `{"kind":"cron","expression":"0 9 * * 1-5","timezone":"Asia/Shanghai"}`:
  five-field, minute-level cron in an explicit IANA timezone.

Relative timing is normalized once and stored as an absolute instant. The adopted
`cron-parser` 5.10.2 adapter calculates timezone/DST transitions. Asia/Shanghai is
the conversational default; an explicitly requested timezone takes precedence.
The browser's conversation schedule list shows current plans, next time, errors
and the last Run, with edit/pause/resume/delete controls. Lists are paginated and
omit instruction bodies; details load separately. There is no automatic polling
of the open list. Use Refresh to see changes from another client or the Agent.

Default `missed: latest` admits the most recent overdue occurrence once after an
outage. `missed: skip` ignores an occurrence more than 60 seconds late. Neither
policy replays all missed intervals. A plan skips a new occurrence while its last
Run is queued, running, recovering or settling. Resuming a paused plan starts at
the next future occurrence. A finished/past one-off needs a new future time before
it can be resumed. These policies do not limit Agent execution duration.

Pausing/deleting a plan prevents future admissions. An already admitted Run is
independent; deletion reports its identity and offers the existing Stop action.
Deleting a plan does not remove its prior conversation history. Scheduled Runs
have a source badge and do not appear as editable follow-up drafts.

## Data flow and authority

```text
Agent schedule Tool -> Session Kafka -> Projector -> schedule service -> PG
Browser edit/delete -------------------------> same schedule service -> PG

PG due plan -> one transaction: normal Run admission + plan advancement
            -> existing Run queue -> Worker -> native Pi execution
```

`session_schedules` holds only current configuration and timing/admission state.
It links the last Run instead of duplicating its execution lifecycle. Run origin
contains the plan ID/revision/name/planned time/timezone. Admission time is the
Run's existing creation time. Native history stores actual Agent input, tool calls
and results, including Agent-originated plan management. Web mutations and clock
wakeups do not manufacture Tool calls or append configuration versions to history.

The controller uses one nearest-deadline timer, PG LISTEN/NOTIFY hints, and a
60-second fallback. Startup and listener reconnection rescan. Name-only edits do
not wake the timer. Hints coalesce; PG locks/time/revisions remain authoritative.
Due work uses batches of 32 and at most two concurrent Session groups. A Session
lock precedes the plan lock, matching edit/delete ordering. Run creation and plan
advancement commit together. A pre-commit crash leaves the plan due; a post-commit
crash leaves exactly one accepted occurrence for the normal queue to execute.
This is not an exactly-once guarantee for arbitrary Agent effects.

Unavailable transient admission uses capped retry delays; permanently missing
resources block the plan visibly. User-paused machines are not resumed. No model
or executor request runs inside the transaction. The ordinary management Tool is
non-replayable: after an uncertain reply the Agent inspects current plans instead
of automatically repeating a mutation. Existing dispatch fencing prevents replay
from resurrecting a deleted plan; row idempotency alone is not that guarantee.

## Public management API

Authenticated, tenant-scoped routes:

- `GET /v1/conversations/:sessionId/schedules?cursor=<uuid>`: bounded summaries.
- `GET /v1/conversations/:sessionId/schedules/:id`: current details.
- `PATCH .../:id`: `{action:"update", revision, patch}` or `{action:"pause"|"resume",revision}`.
- `DELETE .../:id`: `{revision}`. Returns the already admitted Run, if any.

Creation in this slice is conversational through the Tool. Revisions prevent stale
editing. Tool `get` returns bounded prompt pages with `nextPromptOffset`; the Web
details route returns one instruction using the existing input-size budget.

## Verification and limits

Run `npm run browser:schedules:check` for the component interaction test and
`npm run eval:schedules` for isolated real-PG admission load. The latter creates
10,000 sparse plans and two 10,000-occurrence bursts (100 Sessions and one hot
Session), then removes its database. It measures actual normal Run admission,
not Agent execution or production Projector traffic. The first local sample
admitted about 121/s distributed and 64/s in one Session, without duplicate Runs;
the co-located read API p99 remained below 16 ms. A large simultaneous burst is
queued and may take minutes to admit. This is not a 10,000-Agent capacity claim.

Matched publication must drain writers, retain user Volumes/configuration and
run real Luna one-off, busy-Session, direct deletion and Control Plane recovery
acceptance, plus workspace-scoped Subagent and existing Cube/device checks.

```sh
PI_CLOUD_LIVE_SCHEDULES_CHECK=1 PI_CLOUD_SCHEDULES_RESTART_CHECK=1 node --import tsx scripts/run-live-schedules-check.mjs /private/schedules
PI_CLOUD_LIVE_ANDROID_CHECK=1 PI_CLOUD_LIVE_SUBAGENT_WORKSPACE=1 node --import tsx scripts/run-live-android-check.mjs <unbound-target-uuid> /private/mixed-workspace.json
```

The first script creates an owned tenant and cleans its plans, Runs and physical
Workspace through normal APIs. Control Plane interruption requires no unrelated
unfinished work. The second extends the existing owned Android Session fixture
with null-workspace and separate Linux child checks; it refuses a bound device.
