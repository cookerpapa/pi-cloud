# Log-driven Subagents — 2026-09-13

Implementation/acceptance worktree based on `ba3a4bc`; reports intentionally
identify the tested dirty worktree rather than claiming its parent commit alone
contains this change.

## Delivered contract

The Worker appends Subagent commands to the existing physical-Session Kafka log.
Projector admits/delegates through PG; the same owning Worker creates native
Lanes and runs Child Agent Loops. Admission never waits for a later native
projection on the Kafka consumer stack. Requests and notifications are retried
idempotently, not model calls or arbitrary shell effects.

Direct task delegation is lazy. Model-generated workflow JavaScript executes
inside Cube, with its source saved in the Workspace. A bounded duplex bridge
returns `runs.*` requests to the owning Worker writer. Only the script's explicit
return value becomes the outer Tool Result. The old CLI shim, Worker-local
script evaluator and `pi-subagents` runtime dependency are removed; community
workflow semantics are retained behind PiCloud-owned ports.

## Evidence

- [Paid Subagent acceptance](subagent-production-acceptance-latest.json): eleven
  parent Turns, thirteen child Runs, DeepSeek V4 Flash; parallel insertion-sort
  and binary-search implementations with executable tests, re-run by the parent.
  Also covers fresh/branch context, shared/isolated directories, two-level
  recursion, steering, supervisor decisions, cancellation and guest execution.
- Two research-only Turns created no Workspace runtime. Child history occupies
  native Lanes of the parent physical Session, with no inherited-entry copy rows.
  Successive parent Turns ran on both Workers and cold-restored successfully.
- Exactly one accepted Agent message became exactly one native input Entry.
  Supervisor reply completed its original child; cancellation did not start a
  replacement task. Guest execution reported uid 1000 and no checked platform
  credential environment variables.
- Recorded model usage for the post-deployment eleven-Turn case: 13,610 input,
  196,992 cache-read and 6,066 output tokens. This is provider-reported usage,
  not a cost estimate; debugging runs consumed additional tokens.
- Admission ranged 23.1–40.6 ms; first durable visible activity 1.17–3.20 s.
  These are whole-request observations, not isolated transport throughput or
  provider TTFT. First final text can follow child work and must not be confused
  with initial model activity.
- [Real Snake preview](snake-preview-acceptance-latest.json): hosted preview HTTP
  200 and browser start/movement/pause/reset passed after real model-generated
  code, with live write-preparation UI observed. The temporary machine was released.
- Full workspace tests passed (790 tests, seven pre-existing opt-in skips);
  changed-package reruns include two added transport/pending-page regressions,
  bringing the verified current suite to 792 tests. [26 deterministic fault cases](fault-eval-latest.md)
  passed, including closure, stale authority, projection recovery and ambiguous
  Tool transport. These are not all live process faults.

## Faults found and fixed

Internal management RPC inherited the model HTTP proxy; it now uses a private
direct pool. The workflow WebSocket route was registered before its plugin hook;
it now upgrades correctly, with a real socket contract test. Agent inputs during
`provisioning`/`restoring` were incorrectly treated as missed; startup states now
wait for readiness. Bounded control scans advance past pending inbox rows instead
of starving later requests. Completed duplex responses are released rather than
accumulating for the lifetime of a workflow.

The live test originally inspected ephemeral binding/operation rows after
cleanup, and compared PostgreSQL boolean text with `t`; that was invalid test
evidence. It now verifies durable native Tool Results and separately checks zero
physical activation during research. The Snake test no longer requires a model
to spend three seconds generating write arguments to observe its preparation UI.

## Boundaries

Finished foreground children are not automatically resurrected by `send`.
Scripts, process memory and uncertain shell effects are not replayed on failure.
Workspace isolation uses an ordinary file copy, not an atomic snapshot of live
background writers. Same-Session Agent Loops remain on one Worker; this release
does not add multi-node live Lane migration or raise default recursive capacity.

Acceptance-only Sessions, Workspaces, development machines and test accounts
were removed. PG returned to its initial inventory: 35 users, one Session,
six Runs, one Workspace and one development-machine record; no active Runs.
Aggregate reports are retained, not transcripts. Kafka records expire through
the normal safe-retention policy; no shared topic was reset to erase fixtures.

The original development-machine record is `unknown`, and its native
Cube runtime was not found. Its record and Volume were deliberately preserved;
this change does not claim to reconstruct an absent full VM.

High-severity dependency audit passed. Two existing moderate findings in the
Vitest development dependency graph remain; this report does not claim zero
dependency advisories.

## Approved follow-up cleanup — 2026-09-14

The user subsequently approved deleting the original failed machine, its Volume
and associated old history. Release and conversation deletion used the normal
API. Cube still held one node reference for the Volume despite zero instances,
zero active snapshot bindings and no matching mount or guest hypervisor process.
Only that Volume's stale count was corrected, then Cube's native Volume API/plugin
removed its files. PG confirmed storage purge before related history was removed.
This was scoped maintenance, not a new compatibility or recovery code path.

Final inventory: zero Sessions, Runs, Projects, Workspaces, development machines
and native Session-log rows. All 35 users remain. User/password, model-profile
and platform-configuration fingerprints are unchanged. Configured Code Host
connections, current Cube templates and provider credentials were preserved.
The temporary maintenance credential was revoked and removed. Deleted history
and Volume files have no application-level undo; Kafka follows existing safe
retention rather than a shared-topic reset. Worker slot semantics were not changed.
