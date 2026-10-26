# Scheduled inputs and workspace-scoped Subagent delivery

Deployed on 2026-10-26 as `schedules-08063299`, source
`08063299d8e209aaab451a1a7e1fd03ab070820d`, schema 202, tool catalog v3 and Helm
revision 111. The guest identity is `40ac4b3d5e32c4949c76b554482fa98240e79664`.
The existing Android executor remains on its separately published version.
ADRs [0280](../adr/0280-workspace-scoped-subagent-contract.md) and
[0281](../adr/0281-scheduled-session-inputs.md) are implemented and accepted live.

## Delivered behavior

The root Agent can create and manage one-time or timezone-aware recurring plans
through `schedule`. Relative timing resolves once against PG time. The browser
offers current-plan inspection, editing, pause/resume/deletion and navigation to
the last executed Run. Every occurrence enters the existing queue as a new Run in
the same Session; busy Sessions wait for their current native family and ordered
writer closure. Steer/follow-up continue to target the active Run. Scheduled
queued work is not an editable human draft, and can be stopped independently.

PG plan advancement and Run admission share one transaction. One nearest-deadline
timer, committed PG notification hints and a 60-second fallback wake bounded
admission batches. A duplicate wake cannot create another Run for the same
occurrence. The adopted calendar parser is `cron-parser` 5.10.2. The plan's current
configuration lives in PG; actual execution and Agent-originated management use
the existing native history. Web edits/deletion do not invent Tool calls or need
a Worker. Deleted plans remain identifiable in previous Runs through their frozen
origin metadata. [Behavior, API and reproduction](../SCHEDULES.md).

Subagent parameters now separate task/context from `workspace`. Omission inherits
access, null disables workspace-dependent tools and compute, and ephemeral means
separate Linux compute on the same Volume. Direct and workflow delegation use the
same contract, without old flat parameter aliases. Children do not acquire the
parent's phone grant. Device-use coordination remains with Agents.

The implementation also fixed current-Run lookup when a later scheduled Run is
queued, and uses cloud Session kind rather than a magic native Conversation ID
for root-management authority. A forked root can have a native ID other than 1.

## Verification

Source checks cover protocol, native/Worker capability resolution, PG admission,
calendar/DST, controller wakeups, queue coexistence, direct API management and Web
presentation. Whole-workspace typechecks and tests ran. The only failure in the
initial workspace test run was the old schema-count assertion; its schema 202
repair passed with the focused PG/Worker regression (21 tests). Acceptance helpers
passed 115 tests. The complete browser presentation rerun and the new schedule
component interaction test pass. Build, documentation, formatting, dependency,
installer, runtime policy, Helm, observability and image-closure checks pass.

The real Kafka/PG transport suite passes 9 tests, the fault evaluation passes all
375 cases, and Cube admission/allocation contracts pass. The twelve matched
artifacts pass provenance, SBOM and the maintained vulnerability gate. The
pre-commit fault worktree was subsequently committed in the deployed source;
its report retains that original revision/dirty-worktree provenance.

Real GPT-6 Luna checks pass:

- Agent creation of two plans, a new same-Session one-off Run, unchanged canonical
  instruction text and no VM for pure text scheduling.
- Deployed browser origin rendering and direct edit/pause/resume, preserving an
  unchanged calendar when only the name changes.
- A due time crossed during a real Control Plane interruption, followed by one
  admitted Run and successful model execution after restart.
- A scheduled Run queued behind an active Bash; human steer remained in the
  active Run. Direct plan deletion retained the accepted occurrence, which later
  completed and remained readable in cold history.
- Native input editing/ordering/Stop and Worker recovery, plus streaming Stop
  and simultaneous Worker/Control Plane interruption. Recovery retained the same
  Run and native partial output without PG streaming bodies.
- All six phone operations, retained screenshot bytes and deployed browser
  rendering/binding. In the same mixed phone/Linux Session, a null-workspace
  child used no workspace tools or VM; an ephemeral child wrote a file that the
  parent read from their shared Volume. Neither child received phone tools.
- Ordinary Cube coding, authenticated Preview, a background service across Runs,
  and a 1,024-file fixture retained across confirmed VM removal and replacement.

## Admission load, not Agent capacity

The committed-source benchmark uses an isolated real PG database with 2 CPU /
768 MiB, actual normal Run admission and a co-located read API. Each scenario has
10,000 plans. The final sample ran alongside image preparation on the WSL host.

| Due distribution | Admission duration | Admissions/s | API p99 | Duplicate Runs |
| --- | ---: | ---: | ---: | ---: |
| 100 Sessions, simultaneous | 107.24 s | 93.25 | 17.40 ms | 0 |
| One Session, simultaneous | 191.49 s | 52.22 | 15.33 ms | 0 |

The sparse sample uses the due index, with two startup/idle reads, zero wake-query
increase from 100 name-only edits and successful wakeup after an earlier deadline
edit. Controller errors were zero. The earlier standalone sample reached about
121/s and 64/s respectively; these are local samples, not latency guarantees.
The test executes no Agents and does not measure production Kafka/Projector
saturation. Large simultaneous bursts can take minutes to admit. Fleet execution
capacity and mixed Projector load remain in the existing measurement backlog.

## Publication, preservation and retained failures

Writers and external-effect bindings were drained. The old dedicated allocation
was closed and confirmed physically absent before clearing its live handle; its
Workspace Volume and running intent were retained. The new controller recovered
the machine at generation 16, and its three existing application endpoints serve
the same response hashes as before publication.

All three original Sessions and their native rows/checksums match the baseline.
All 37 retained images pass byte-count and SHA-256 checks. The 5,701-file workspace
inventory matches apart from expected process PID/log artifacts, and all 27
secret/configuration file digests match. Accounts/model/provider configuration
are retained. Owned test tenants and physical Workspaces are cleaned; final
inventory has no active Run, writer, Tool binding or elastic test VM. All 29
serving Pods are ready.

The private evidence directory is
`deploy/production/runtime/release-evidence/schedules-20261026/`. It retains the
first browser fixture's identity-reload timeout (unchanged rerun passed; cause
not established), an overlong schedule-test tenant slug rejected before any
resource creation, and two incomplete phone samples. In those phone samples the
device retained the previous search text and the model skipped tap/input without
a Tool error. The maintained fixture now uses a unique text marker and explicitly
requires fresh actions; all six original Tool assertions then pass. The input
fault fixture also retains the expected dropped exec connection during process
termination; kubelet restart evidence and recovery assertions pass.

Fixture-only diagnostics and setup fixes do not change the deployed application
artifacts. There is no compatible old-parameter path, second scheduler or new
device reservation service.
