# Conversation commands and model waiting — 2026-10-26

Serving release: `commands-514e2b0f`, application revision
`514e2b0f52be358d64206c2b1c7a72faa7a3fe6b`, schema 199, Helm 106.
Pi remains pinned to 1.0.0. The matched manifest retains the exact reused guest
artifact and records all twelve scanned images. No native Pi source was patched.

## Behavior and ownership

- `/usage` reads committed native usage and the current context head/suffix from
  PostgreSQL. It reports input, output, cache input, per-model/child totals and
  estimated context/window/threshold. Cache input is included in input; in-flight
  output is not silently counted as committed usage. It admits no work or VM.
- `/compact [instructions]` is an input command. During a Run, the existing Worker
  commits the exported native CompactionTask and an idempotent command receipt
  together. Pi decides summary selection, retries and placement at a native
  boundary. Completion of summary generation alone is not reported as application.
- When idle, `runs.operation_kind=compact` reuses PG claim, the Session lease,
  transactional Kafka writer and native continuation. It creates no user prompt
  or Tool Sandbox. Stop before claim atomically cancels that queue row with an
  existing control receipt; after claim, ordinary native cancellation applies.
- The composer preserves drafts/uploads, Enter preferences and IME behavior.
  Cold compact defers ordinary sending; active compact retains native input
  semantics. A command whose delivery is unconfirmed stays retryable with the
  same identity. Read-only command status follows native Tasks/Submissions.
- The Gateway bounds connection establishment at 15 seconds. The Models adapter
  bounds valid-event inactivity at 300 seconds, including the initial wait after
  model-permit admission. Non-text model events renew it; transport comments do
  not. Pi owns five retries, SDK retries are disabled, and no overall Agent
  duration limit is added. Stop/lease loss cancel immediately.

The public registry phase boundary supplies task-scoped model provenance for both
generation and compaction, including restored phases. Concurrent requests retain
their own sampling context and permit. There is still one physical-Session writer,
one native execution authority and no separate compaction queue or scheduler.
The OpenAI SDK's header-only fallback is 30 seconds beyond the initial event
deadline because it interprets zero as immediate expiry; Codex SSE disables its
header timer. This does not implement Codex's infinite connection-only retry.

## Validation

Source evidence includes workspace types/tests, both model adapters' inactivity
contracts, native concurrent compaction/Stop/recovery, PG command admission and
usage, complete browser presentation checks, Kafka transport, 375 existing fault
cases, Cube allocation/admission contracts and the maintained build/Helm/install/
image-closure/dependency gates. Fault evaluation ran on the implementation tree
before the focused live corrections; its private report retains that provenance.
The final composed Worker test crosses protocol parsing, AgentRunSupervisor,
RemoteToolSandboxTurnRunner, PiCloudTurnRunner and the native Harness with an HTTP
test model. It covers a non-reserved Conversation ID, complete summary placement,
duplicate control delivery, Stop, and no VM/Workspace-seed activation.

Real Luna and browser command acceptance passed on the serving release:

| Case | Observed result |
| --- | --- |
| Live `/usage` and cold `/compact` | Real page/API/SSE; estimated context 67,928 → 34,164 tokens; no Cube activation |
| Summary accounting | 24,380 input + 161 output tokens recorded for the first summary |
| Compact while Bash waits | Same Run, summary waits for native placement, then original work continues and recalls the retained fact |
| Worker crash during compact | Confirmed exit 137, successor lease, same Run and native Task, summary applied |
| Owned resource cleanup | Conversation, Workspace and fixture tenant removed after physical cleanup |

The ordinary real-Luna Cube gate also passed: chat without VM activation, coding,
authenticated Preview, background process continuity across Runs, and restoration
of a 1,024-file Workspace on a fresh VM. This gate exercised the unchanged normal
path on the preceding `commands-c9b2b547` deployment; the command/Worker recovery
gate above exercised the final deployment.

Live validation found three integration omissions that are now regression-tested:
SQL grouping in the command-history filter, compact classification in the wire
validator, and the outer Supervisor's prompt-only admission. The SQL correction
retains tenant and conversation predicates for every history row. The initial
failed fixtures were cleaned; they are not counted as accepted runs. Unclaimed
Stop also gained atomic PG settlement and an immediate page snapshot refresh.

The final native-input live gate passed on `commands-514e2b0f`: consume, Stop,
Worker recovery, streaming Stop and simultaneous Worker/Control Plane failure.
All retained the same Run, persisted the appropriate native partial state and
kept streaming bodies out of PG. Its stale schema-197 precondition was updated to
the maintained schema 199 before this run. That earlier precondition-only failure
created no fixture resources and is not counted as acceptance.

## Preservation and limits

The original dedicated machine's logical identity, desired running state and
Workspace Volume were retained. Compute retirement required positive absence on
the recorded node; public Release was not used. The original applications on
ports 3000, 8080 and 4188 were restarted from retained files and their served HTML
hashes checked. Process memory is not preserved by this cold replacement.

Preservation evidence covers 15 account/configuration/native-history tables,
5,700 Workspace files and 27 configuration files. Process logs, PID files and
SQLite WAL/SHM journals are explicitly mutable across restart; the SQLite main
file remains hash-protected and the game's five-table logical snapshot is checked
separately. All 37 originally referenced image objects are checked by length and
SHA-256. Private evidence, failed samples and owned cleanup receipts are under
`deploy/production/runtime/release-evidence/commands-20261025/`; no transcripts or
credentials are committed.

Final reconciliation passed: all protected rows match with no added fixture rows,
all 27 configuration hashes match, all protected Workspace files match, the game's
logical snapshot matches, and all 37 image hashes match. All 28 Pods are ready.
There are no active Runs, Session writers, Tool bindings or elastic VMs; the retained
dedicated machine is ready and all three original application bodies match.

Worker and read-only Control Plane changes still require the maintained matched
release path. The narrower component procedure currently covers ordinary Tools,
Web presentation, provider images and catalogs. This delivery does not claim
zero-downtime Worker replacement or broaden that procedure.
