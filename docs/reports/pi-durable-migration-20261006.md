# Pi Durable 1.0 migration — verification and cutover

Status: source migration verified; matched production cutover and live product
acceptance are in progress. Do not interpret the component evidence below as a
completed deployment. The implementation follows [ADR-0229](../adr/0229-native-durable-runtime.md).

## Change

PiCloud now pins Pi AI, Durable and Chord to 1.0.0. The public Harness replaces
CloudAgentRuntime; its Storage port replaces the old SessionStorage/writer/backend.
The CLI package is retained only for public fixed-Tool truncation helpers.
Native Conversations, tasks, submissions and documents own Agent progress.
PG still owns admission, Session leases and VM lifecycle. There is one Session
writer, ingress and Projector, not a second scheduler or broker.

A native batch is prepared without changing committed state, acknowledged by
RF3 Kafka, then adopted in memory. PG stores each native body once as JSON text,
with current-record pointers and derived document checkpoints. Cold reads use
head markers and the active suffix. Images in records and documents remain S3
references; Workspace files remain on Cube Volumes.

Recoverable Worker loss retains the logical Run, Turn and native input. Old-writer
closure and a new PG lease precede native resume. Unsafe Tools are not replayed.
Stop adopts native abort semantics: late physical results cannot overwrite it.
Fixed Tool and Workflow operation cancellation use the ordered Session path.
Unconsumed queued human text and uploads return to the composer in order while
its existing draft remains. Consumed Steer stays in history.

Independent human forks copy native entries, images and conversation documents
according to as-of/current fork policies. Execution grants and task/Session
state do not copy. Verification reminders use committed native progress at yield,
not asynchronous display callbacks. Configured finite budgets preserve a
conservative intent floor on recovery; they are not a provider billing ledger.

## Verified before deployment

- Complete workspace build and TypeScript checks; a final workspace regression is
  running after the last boundary fixes.
- 183 deterministic fault cases pass. Twenty-nine old-loop/old-cancellation cases
  were retired with that contract; 26 explicit Durable/storage/recovery/queue
  cases replace them in the maintained manifest. This is not a claim that their
  former semantics remain in effect.
- Official Storage conformance passes in both acknowledged-overlay and cold-PG
  modes. Owned cases cover ambiguous ACK, proved refusal, atomic conflict,
  bounded document tails, image locations, origin recovery and budget floors.
- Real isolated RF3 Kafka + PG: 2 integration cases pass on the new topic. Twelve
  private HTTP-to-commit samples measured p50 47.27 ms / p95 87.10 ms with zero SQL
  on ordinary append. Tests are transport evidence, not production capacity or HA.
  Fixture container-stop calls exceeded their timeout; all three were subsequently
  confirmed absent and their isolated network was removed. No production resource
  was touched by fixture cleanup.
- Real GPT-6 Luna component acceptance: native foreground Compaction followed by
  sampling retained the fixture marker; both requests kept Fast tier. This uses a
  4096-token fixture window and does not claim a million-token capacity result.
- Fresh source export `npm ci` succeeds. The dependency audit verifies the installed
  shrinkwrapped brace-expansion correction and reports no remaining vulnerabilities.
- Helm/distributed rendering, installation, observation rules, runtime policy and
  image dependency closure checks pass. Cube contract checks run from isolated
  exports, never by modifying the operator's Cube checkout.

## Cutover contract and pending evidence

Schema 176 returns stopped input. Schemas 177–180 introduce native Storage,
numeric Conversation bindings, recoverable execution ownership and the Pi 1.0
runtime revision. Schema 178 checks for an empty, drained Session store under
locks; it never silently drops newly-created conversations. The private native
format moves to `pi-cloud.execution-log.v14`; old envelopes are not read through
a compatibility branch. Matching Control Plane, Worker, Cube completion adapter
and guest/template artifacts are required.

The pre-cutover inventory had zero product/native Sessions, active Runs, live
leases, Tool bindings and pending Outbox records. There are two historical UNKNOWN
Workspace runtime rows; no deletion or quota release is authorized by that state.
Their cleanup remains subject to recorded-node evidence. Existing image inventory
was already empty after normal unreferenced-object cleanup.

Pending: final workspace results, matched artifact deployment, real Luna/Cube
file/shell and image/upload paths, queue/browser acceptance, Subagent behavior,
Worker replacement and scoped cleanup. Append concrete release evidence here
before marking ADR/roadmap/backlog complete.

## Deliberate limits

Automatic background Compaction is disabled through Pi's public setting because
PiCloud has no independent background admission lifetime. Foreground Compaction
remains native. Provider requests can repeat after interruption; arbitrary shell
side effects are not exactly once. A native abort or transport ACK does not prove
that a remote process has stopped. Local RF3 brokers share the deployment host;
process tests do not establish physical multi-node or power-loss durability.
