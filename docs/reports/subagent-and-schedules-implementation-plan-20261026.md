# Subagent workspace and scheduled-input implementation plan

Status: implementation plan requested and approved in direction, 2026-10-26.
No runtime implementation or rollout has occurred. Follow
[ADR-0280](../adr/0280-workspace-scoped-subagent-contract.md) and
[ADR-0281](../adr/0281-scheduled-session-inputs.md) in the order below.

## 1. Complete the subagent workspace slice

Change the protocol schema/type and descriptions in `control-tools.ts`, the
workflow helper arguments, controller parsing and child resource resolution.
Remove old flat argument support. Keep current internal shared/ephemeral/none
compute ownership and native child lifecycle where they already express the
required behavior.

Resolve one effective environment description for model-facing tools, ordinary
Tool eligibility, dispatch and child prompt assembly. Null workspace must remove
workspace-dependent Preview/image tools as well as fixed read/write/edit/bash,
and must not allocate a VM through an indirect path. Branching history does not
supply device control. Keep device coordination with Agents; add no reservation
or occupancy API.

Acceptance: direct/workflow parity, omitted/null/object cases, invalid/expanded
capabilities, shared/ephemeral storage semantics, nested and recovered children,
public-Pi catalog contracts, and owned mixed Android/Linux model scenarios.

## 2. Implement the authoritative schedule service and due-to-Run transaction

Add a current-value `session_schedules` configuration table and database types.
Group its fields into identity/Session scope, instruction reference and timing,
configuration revision/enabled state, next due/check eligibility and last admitted
Run/error. Actual execution state is read from the linked Run, not copied into
another lifecycle table. Freeze bounded scheduled-source metadata on the Run.
Retain existing instruction/attachment ownership and budgets.

Validate one-time timestamps, explicit timezone, supported five-field cron and
pause/resume/update behavior using a pinned calendar parser. Confirm dependency
license/release and add clock-contract cases before integration. Schedule creation
and mutation identities must survive ambiguous replies; use existing native
command/dispatch identities and revision checks, with tests proving stale work
cannot recreate a deleted plan. Do not add an unbounded per-occurrence result log.

Implement a bounded due controller in the Control Plane. Reuse existing input
admission in its PG transaction; atomically link the Run and advance/finish the
plan. Use PG time, an enabled/due index and stable per-occurrence keys. One-off
plans stop scheduling after admission; their actual result still comes from the
Run. A busy Session queues the new Run under existing readiness rules. Same-plan
overlap skips and outage catch-up follows ADR-0281. Paused intervals are not replayed.
Transient admission failures use bounded retry eligibility; deleted/permanently
unavailable resources produce visible attention instead of a hot retry loop.

Acceptance: concurrent due workers, transactional rollback/commit crash windows,
no duplicate Run, Session deletion/clock/edit races, lock ordering, clock shifts,
timezone/DST, overlap/catch-up, paused resources and idle indexed query behavior.
No timing scan enters Kafka or scans the native transcript.

Use the existing PostgreSQL notification wake helper: one nearest-deadline timer,
committed plan-change hints, startup/reconnect scans and a low-frequency fallback
(initial proposal: 60 seconds). Idle controllers should not query once per second.
Test earlier-plan insertion, moving/deleting the nearest plan, changes while a
scan is running, missed hints, reconnect and clock jumps. Every wake still admits
through PG; never hold a transaction open while waiting or spin on contended rows.

## 3. Connect the schedule Tool and direct Web management

Register an environment-independent ordinary Tool in the execution-owned registry.
Use generic root-Conversation availability metadata throughout catalog publication
and Worker exposure; a child must not gain persistent main-Session management by
accident. The Tool is scoped to its authorized current root Session, not a
model-supplied endpoint, tenant or arbitrary Session.

Suggested creation shape:

```json
{
  "action": "create",
  "name": "Daily project summary",
  "prompt": "Summarize yesterday's project progress.",
  "timing": {
    "kind": "cron",
    "expression": "0 8 * * *",
    "timezone": "Asia/Shanghai"
  }
}
```

One-time timing uses `{ "kind": "once", "at": "2026-10-27T08:00:00+08:00" }`.
Return stable plan id, configuration revision, normalized timing and next time.
List/get return current state; updates use revision checks. Pause/resume/delete
return concise outcomes and the already-admitted Run reference when relevant.
Avoid returning a complete historical plan snapshot on every action.

The browser's conversation task list offers inspect/edit/pause/resume/delete,
next local execution time and a link to the most recent Run. Direct mutations use
the same service through normal authenticated APIs. Direct deletion does not
create a Tool call, wake Pi or publish to Kafka. Use concise status/error UI.
Provide the existing Stop action for an already-admitted queued/running occurrence.

Acceptance: real browser management plus Tool paths, identical validation,
revision conflicts, duplicate/late requests, delete-versus-fire ordering,
root/child scope and no Sandbox activation to manage a schedule.

## 4. Preserve native history and presentation semantics

Carry scheduled origin through existing Run/view schemas and show one correctly
identified input in the live stream/history window. Ordinary Tool invocation and
canonical final results retain native logging. Do not erase historic creation
messages when a plan is deleted, inject fake Tool results for Web actions, keep
periodic polling logs in PG/Kafka, or replay old management calls while rebuilding
history. A timer-created Run is distinct from Pi's steer/follow-up inbox.

Acceptance: source badges, late planned-versus-actual time, stream/history dedup,
refresh and recovery, deleted-plan historical readability, and independently
stopping a Run without accidentally changing a recurring plan.

## 5. Integrated verification and matched publication

Run the changed protocol/Control Plane/Worker/SDK/Web tests, real PG/Kafka and
relevant fault checks, required build/documentation/dependency/release gates.
Use fake clocks for deterministic timing cases and owned real Luna fixtures for
short one-off scheduling, busy-Session waiting, deletion and CP restart catch-up.
Verify null-workspace delegation and existing Cube/Android/input recovery.
Do not repeatedly run unchanged broad suites without a new failure or concern.

After both complete slices pass, publish their matching schema, API, Worker,
Tool/guest and Web artifacts through the maintained release procedure. Drain
writers; preserve accounts, model/provider configuration, credentials, Sessions,
images and Workspace bytes. Retire compute only through confirmed cleanup and
restore existing applications when required. Remove obsolete parameter paths
and own test resources; retain no development-era compatibility implementation.
Update delivery evidence, README/architecture/roadmap/backlog after live checks.

## Completion criteria

A user can create a plan conversationally, inspect/change/delete it directly,
close the page, and later find exactly one admitted occurrence for a given
logical firing identity. Its Agent execution uses the ordinary Session pipeline.
No early/busy/duplicate trigger can create a competing Session writer. Deletion
prevents later admission without falsifying history or cancelling already
accepted work implicitly. The subagent parameter structure unambiguously describes
Linux workspace compute and grants no phone by changing context or compute mode.
