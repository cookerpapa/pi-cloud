# Scheduled Agent inputs

Date: 2026-10-26. Proposal and adopt-before-build research; no scheduler, schema,
Tool or deployed runtime has been changed.

The owner clarified that Agents coordinate device sharing themselves. Do not add
platform occupancy registration, shared/exclusive reservations or device-use
scheduling. The subagent workspace-parameter direction is approved separately.
This note concerns time-triggered Agent work only.

## Recommended boundary

Persist schedules in PostgreSQL and translate a due occurrence into a normal
PiCloud Run through the existing admission service. The schedule controller owns
calendar evaluation and input delivery. The existing PostgreSQL Run queue owns
Worker assignment; Pi owns the Agent loop and its continuation. Kafka retains its
current Session log/Tool-routing role after Worker execution starts.

A schedule selects a durable target Session and a bounded instruction/reference.
It does not keep a Worker, Agent loop or VM running until its due time. Existing
Session model/resource settings are resolved and frozen by normal Run admission.
An optional dedicated recurring-task Session can avoid waiting behind an unrelated
conversation; it is not a new Session on every occurrence.

Current implementation seams:

- `ControlPlaneStore.acceptTurn(..., existingTransaction)` admits a normal input
  inside an existing PostgreSQL transaction. Source-control Issue automation
  already uses this to commit an external trigger and its Run association together.
- `runs_session_idempotency_unique` makes the Session/idempotency-key admission
  repeatable, and `laneDependenciesReady` requires idle/cold state, prior Run
  completion and ordered closure before another Run becomes ready.
- Ordinary active-chat follow-up/steer remains Pi Inbox work. A scheduled occurrence
  is an explicitly new logical task/Run, with its own origin, and does not silently
  become steering input to an existing Run.

## Candidate comparison

**Kubernetes CronJob** already exists in the deployment platform and provides
periodic Job creation, timezone and missed-start controls. Its documentation
explicitly allows duplicate/missed Job creation, so application admission must
still be idempotent. A CronJob/Job/Pod per user timer adds cluster lifecycle and
configuration reconciliation for what is currently an application input. It is a
good operator-job primitive, but is not the preferred first user-timer adapter.
[Official behavior](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/).

**pg_cron** is a PostgreSQL extension for scheduled SQL. It requires preload/
installation configuration. Running PiCloud's TypeScript admission logic would
still need a delivery bridge; directly inserting arbitrary Run rows would bypass
that existing admission boundary. Prefer it for database maintenance rather than
moving this application protocol into SQL callbacks.
[Official repository](https://github.com/citusdata/pg_cron).

**pg-boss** is a viable PostgreSQL/Node scheduling and job-queue implementation.
Its documented scheduling includes cron/RRULE, timezone and missed-occurrence
policies; the observed documentation version is 12.38.0. If adopted, its jobs must
end at Run admission rather than own the long-running Agent lifecycle. It would
add a persisted trigger-job stage to an application that already has transactional
Run admission. Its documented `missed: once` payload does not identify the original
missed occurrence, which requires care for our planned-time provenance.
[Scheduling and catch-up](https://pgboss.io/api/scheduling),
[job delivery](https://pgboss.io/api/jobs).

**Bounded existing-PG adapter plus an adopted calendar parser** is the preferred
first slice. Reuse the existing row locks, transaction adapter, Run queue and
maintenance-loop conventions. Adopt a pinned calendar parser for expression,
timezone and DST calculation; do not implement those algorithms ourselves.
[cron-parser](https://github.com/harrisiirak/cron-parser) documents timezone support
and forward/backward occurrence calculation.

This is a fit judgment for the current narrow requirement, not a claim that the
other schedulers are unsuitable in general. The bounded code bridges a calendar
occurrence into the existing queue; it must not grow a second set of Agent jobs,
leases, retries, output storage or workflow states. If broader calendar/trigger
requirements make that adapter large, reassess pg-boss before expanding it.
No dependency version is selected or installed by this research; pin and verify
the adopted parser during implementation and record the decision in an ADR.

## Suggested first product semantics

- One-time timestamp and recurring, minute-level cron in an explicit IANA timezone
  (the owner's default is Asia/Shanghai). Persist UTC instants; display local time.
- A due occurrence enters normal Run admission. If the Session is already busy,
  its accepted Run waits for existing readiness/ownership rules; it does not
  automatically steer or start a competing Session writer.
- Do not accumulate overlapping Runs from the same recurring plan. Default to
  skipping an occurrence while that plan's preceding Run is queued/running or
  still requires ordered settlement. This is a recurrence policy, not a Run
  runtime limit.
- After downtime, propose one catch-up for the most recent missed occurrence,
  clearly marked late, with an explicit skip option for time-sensitive tasks.
  Do not replay every missed occurrence by default.
- Editing/pausing/deleting a plan affects future admissions. An already admitted
  Run retains its accepted input; stopping it is the existing explicit Stop flow.
- Permanent missing/deleted targets need visible attention. A timer must not
  recreate deleted resources, resume a user-paused machine or clone a phone.
- Results remain in the target conversation. Separate push/email/notification
  delivery is a later product capability, not implied by successful Agent work.

These are proposed defaults for review, not implemented behavior.

## Storage and failure design

Use one current-value schedule configuration with tenant/Session identity,
instruction reference, timing kind/expression/timezone, enabled state, revision,
next logical occurrence and last admitted Run identity. Large instructions and
attachments use existing command/content ownership; queue rows do not become a
second transcript or attachment store. Actual occurrences use existing Run/native
history with an explicit scheduled origin and planned versus admitted timestamps.
Do not log empty clock ticks or retain every intermediate schedule edit.

A short due pass selects an indexed bounded batch using PostgreSQL time and
`FOR UPDATE SKIP LOCKED`. For each occurrence, call existing Run admission with a
stable key derived from schedule id, revision and logical planned time; link the
Run and advance/finish the schedule in the same transaction. Do not perform model
or executor network work while holding that transaction. The inherited Session
locks settle races with interactive input, resource changes and other timers.

Before commit, a crash rolls back both the Run and clock advancement. After
commit, both exist and normal Worker claiming continues. Duplicate callbacks use
the same admission identity. Revisions/row locks order edits against a due pass.
The controller may retry transient *admission* failures, but once a Run exists,
Agent execution recovery belongs to PiCloud/Pi. A failed/unknown Tool is not a
reason for the calendar controller to create another Run with the same input.

Wake-up refinement after the owner's database-load question: use one wait for the
nearest effective eligibility time plus committed-change LISTEN/NOTIFY hints,
reusing `packages/database/src/postgres-queue-wake.ts`. Rescan on startup/listener
reconnect and keep a low-frequency fallback (initial proposal: 60 seconds), rather
than fixed one-second idle polling. Notifications arriving during a scan must
advance the wake generation so the change is not lost before the next wait.

An index on due enabled rows and the nearest-time lookup avoid scanning Session
logs or all schedules. A timer wake always rechecks authoritative PG state before
admission, including deletion/revision and clock changes. Readiness notifications
are not a durable queue; missing one can delay discovery until the fallback but
cannot authorize an obsolete plan. Measure cadence/batch size and ensure contended
or failed work cannot cause a zero-delay query loop. A due timestamp remains an
eligibility time rather than a guarantee of instant model output.

## Management and acceptance

A future ordinary platform Tool can create/list/update/pause/delete plans. Its
creation intent uses the existing Worker/Kafka/Projector Tool path. The due-time
controller calls normal Run admission directly; it does not publish a future
Kafka record and hold a partition until its clock time arrives.

Before implementation acceptance, verify duplicate/concurrent due passes,
transaction failures before/after commit, CP/Worker restarts, timezone/DST and
clock jumps, catch-up/overlap policy, edits/deletion racing a fire, active-Session
queueing, paused/deleted resources, input origin rendering and physical cleanup
of owned live fixtures. The owner should be able to tell whether a plan is
waiting, admitted, completed, failed, paused or skipped without a second copy of
Run execution state.
