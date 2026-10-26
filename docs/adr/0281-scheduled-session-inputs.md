# ADR-0281: Scheduled inputs reuse normal Run admission

Status: accepted for implementation on 2026-10-26; not deployed.

## Decision and authorities

PostgreSQL owns current schedule configurations. A bounded Control Plane due-time
controller converts an occurrence into a normal queued Run through the existing
`ControlPlaneStore.acceptTurn(..., transaction)` boundary. PostgreSQL's existing
Run queue owns Worker assignment and Pi owns execution/continuation. No second
Agent queue, execution lease, scheduler service or Run history is introduced.

Adopt and pin a maintained calendar parser for cron/timezone/DST calculation. The
[build-versus-adopt comparison](../research/scheduled-agent-inputs-20261026.md)
reviews Kubernetes CronJob, pg_cron and pg-boss. The retained custom code is the
small transactional bridge into the existing queue, not another calendar library
or workflow engine. Reassess that choice before expanding the requirement.

## Product semantics

Support one-time instants and recurring minute-level cron with an explicit IANA
timezone. A due occurrence may be admitted while its target root Session is busy;
its Run stays queued until existing readiness and writer-closure rules allow
execution. This satisfies time eligibility plus idle-session execution. It is a
new logical task, not an implicit steer/follow-up into an active native Run.

Do not overlap occurrences of the same plan: skip a new occurrence while its
previous Run is queued, running, recovering or settling. Default outage handling
admits the most recent missed occurrence once; support explicit skip. Resume of
a paused plan computes its next future occurrence and does not replay the paused
interval. These policies do not impose an Agent runtime limit.

Freeze normal Session model/resource settings at admission. Keep a bounded Run
origin snapshot identifying the plan, revision, planned time and admission time.
The browser labels scheduled input; it does not impersonate a freshly typed
human message. Results remain in the conversation.

## Commands, deletion and logs

A code-owned ordinary `schedule` Tool manages create/list/get/update/pause/resume/
delete actions without a Workspace. In the first slice, management targets a
human-facing root Conversation. Expose it to root Agents with generic catalog
scope metadata and enforce that scope in the handler, not a Worker tool-name
special case. Direct Web management calls the same service.

Agent management calls and native final results follow the existing Session
Kafka/Projector/Worker Tool path. Web deletion calls the Control Plane and commits
in PG directly; it does not require Kafka, a native writer or an invented Tool
call. Clock polling and configuration row updates are not native conversation
history. Actual scheduled executions have ordinary native input/execution history.

The firing transaction and edit/delete transactions lock the same plan identity.
Delete first means no new Run can be admitted. Fire first means the accepted Run
remains independently queued/running. Deleting or pausing the plan affects future
admissions; use the existing Stop flow to cancel an already admitted occurrence.
Deleting a plan removes its current configuration, not old Tool/result history.
Old/retried commands must not resurrect a deleted plan.

## Failure behavior

Select indexed due rows using PG time and bounded `FOR UPDATE SKIP LOCKED` work.
Use a stable occurrence key from plan id, revision and planned instant. Run
admission, last-Run association and next-time advancement commit atomically.
No model or executor network operation runs inside this transaction. Keep lock
ordering consistent with Session deletion and existing input/resource admission;
retry transactional deadlocks without duplicating admission.

A crash before commit leaves the occurrence due; after commit the normal Run
queue resumes it. Once admitted, a Run failure does not cause the calendar
controller to create a replacement Run or replay Tools. Missing/deleted resources
are surfaced; user-paused machines are not resumed by the timer. Clock wake-ups
may be lossy because persistent due state is authoritative.

Use one nearest-deadline wait per controller, interrupted by PostgreSQL
LISTEN/NOTIFY hints for committed schedule changes. Reuse the existing
PostgresNotificationWake generation/reconnection behavior and rescan on startup
and listener establishment/reconnection. Read only the next effective eligibility
time rather than loading every plan into memory. Retain a low-frequency fallback
check (initial proposal: 60 seconds), which bounds discovery delay when a hint is
missed; normal known deadlines wake at their own time. Validate and tune that
interval against acceptable lateness. Notifications/timers carry no execution
authority and do not replace the firing transaction. Avoid zero-delay spinning
when another controller holds a due row or admission needs backoff.

## Acceptance and publication

Cover duplicate/multi-instance fire, before/after-commit crash, timezones/DST,
clock jumps, downtime/overlap/resume, edits/deletion racing admission, queued-Run
cancellation, unavailable resources, root/child visibility and source rendering.
Use real Luna for short one-off and busy-Session cases; retain failed samples and
clean owned fixtures. Separately test at least 10,000 synthetic plans with sparse
and simultaneous deadlines through actual Run admission, not only an indexed
lookup. Measure admission latency separately from Worker start, and preserve
API/Projector responsiveness with bounded batches/concurrency. Notifications are
coalesced; one wait per controller never becomes one timer per plan. Schema/protocol/Web changes require a drained matched
release, preserving existing user assets and credentials.
