# Pi Durable 1.0 migration and release

The native runtime and matched artifacts are deployed under
[ADR-0229](../adr/0229-native-durable-runtime.md). The
[machine-readable verification record](pi-durable-acceptance-20261006.json)
contains scoped evidence without conversation transcripts or credentials.
Deployment, live acceptance and final verification are complete.

## Result

Pi AI, Durable and Chord are pinned to 1.0.0. The public Harness replaces
CloudAgentRuntime, including scheduling, retry, foreground Compaction and abort.
The public Storage adapter replaces the old SessionStorage/writer/backend. The
CLI package is retained only for public fixed-Tool truncation helpers.

PostgreSQL still owns cloud admission, Session leases and VM lifecycle. There is
one physical Session writer, ingress and Projector. A native batch is prepared,
acknowledged through RF3 Kafka, then adopted by the Worker. PostgreSQL stores each
native write once as JSON text, with derived current-record/document indexes.
Cold reads use native head markers and the active suffix. Images remain immutable
S3 references; Workspace bytes remain on Cube Volumes.

Recoverable Worker loss retains the logical Run, Turn and native submission.
Ordered old-writer closure and a new PG lease precede resume. Unsafe Tools are
not replayed. Stop follows native abort; late physical replies cannot overwrite
it. Unconsumed queued text and attachments return to the composer in order,
preserving its draft. Consumed Steer stays in history.

## Compatibility findings resolved during verification

- Pi's legacy Codex Provider exposes OAuth; the cloud Models facade now resolves
  explicit live Run capabilities through the public API-key method. Credentials
  remain outside native state, including Compaction requests.
- A child owned by its delegation Tool held that Tool in `completing`, preventing
  the parent from replying to the child's question. Ownership now belongs to the
  requesting native generation. Deterministic reply/parent-abort regressions and
  real Luna supervisor interaction pass; no second scheduler was introduced.
- Plain active-conversation reads now project an executing native Tool checkpoint
  before its final result exists. The stable task ID merges with SSE. No Tool
  receipt table or copied transcript was added.
- Overflow display recovery includes Tool results, and native completed-attempt
  retry numbering is translated correctly. Independent forks preserve native
  document policies without copying execution grants. Verification reminders
  read committed progress at yield, so delayed display callbacks cannot decide them.
- The guest bundle's `createRequire` banner collided with a new SDK import.
  The shim is now named independently; every built guest entry point is syntax
  checked, and the actual guest-template contract passes.

## Verification

The full workspace pass contained 1,578 passing tests and nine optional integration
skips. After the supervision correction, all 157 supervisor tests pass. The active
Tool reader change passes 35 projection/UI tests and 20 real-PG tree/seal cases.
All 186 cases in the maintained fault manifest pass. Fresh source-export `npm ci`, build, type checks, 53 acceptance
helpers, dependency audit, Helm/install/runtime/observation checks, image dependency
closure and isolated Cube admission/allocation contracts pass. The audit verifies
the installed shrinkwrapped brace-expansion correction and reports no remaining
vulnerabilities.

Real isolated RF3 Kafka + PG: two integration cases pass on the new topic. Twelve
private HTTP-to-commit samples measured p50 47.27 ms / p95 87.10 ms with zero SQL on
ordinary append. Fixture stop calls exceeded their cleanup deadline; all three
containers were subsequently confirmed absent and their isolated network removed.
This is transport evidence, not production capacity or physical multi-node HA.

Real GPT-6 Luna evidence includes:

- Native foreground Compaction followed by sampling, preserving a marker and Fast
  tier, with a deliberately small 4,096-token component fixture window.
- File/shell Tools, bounded large output, symlinks, and continuing after a real
  application error. The large-output fixture uses a here-document to avoid the
  model copying JSON quoting into Bash; raw-response/Harness comparison confirmed
  that the provider arguments reach the native Tool unchanged.
- Shared/ephemeral Subagent compute, parallel worktrees and nested compute paths.
  A long broad suite also encountered model planning/path ambiguities and one
  provider HTTP 500. It is not reported as a wholly passing suite. Fresh final
  sessions independently verify supervisor reply, messaging, parallel children,
  child cancellation, and guest script credential/environment boundaries.
- Browser upload of six files totaling about 60 MB, including a roughly 24 MB
  image; direct vision without a read Tool; refresh previews; immutable image
  retention after changing its Workspace file; correct visual recall after a
  different Worker takes over.
- Tool-read images of about 6.3, 6.3 and 25.1 MB. Native image entries contain
  roughly 600-byte references. All three images remain readable after source
  overwrite and Worker boot replacement.
- An active Worker loss with acknowledged but unconsumed Steer: the same logical
  Run completes, the input is consumed once, and the Bash witness remains one
  execution. A separate Stop returns the unconsumed Steer and preserves retry identity.
- Shared-VM Stop: normal cancellation settled in 541 ms. With Cube API paused it
  settled in 18.393 s without claiming physical termination. Sibling work, completed
  background work and independent process groups survive; late replies do not
  overwrite native abort. These are individual observations, not latency SLOs.
- Real browser queue editing, ordering, deletion and immediate Steer; queued image
  edits preserve attachments and consume visual input exactly once. The separate
  browser fixture covers 45 returned inputs, draft retention and lost acknowledgements.

## Cutover and operations

Schema 176 returns stopped input. Schemas 177–180 add native Storage, numeric
Conversation bindings, recoverable execution ownership and the Pi 1.0 revision.
Schema 178 checks quiescence and empty old Session data under locks; it never
silently drops newly-created conversations. The pre-cutover product/native Session,
active Run, live lease, Tool binding and pending Outbox counts were all zero. A
private PG archive and workload/template configurations were saved before cutover.

The private native format uses `pi-cloud.execution-log.v14`; old envelopes are not
read through compatibility code. The Control Plane, Workers, Cube completion adapter
and guest/templates were rebuilt and reconciled through the maintained Helm path.
Both Workers advertise `@earendil-works/pi-durable` 1.0.0 and schema 180 is installed.
The application is served at `http://127.0.0.1:8080`.

K3s lost previously imported images while the external registry path used an
unavailable proxy. Its base Pod image and current release images were reimported
with the standard CRI pin; `ImageStatus` confirms pinning. The importer now preserves
that label. Retired release pins require deliberate housekeeping after rollout and
rollback requirements are satisfied; see [configuration](../CONFIGURATION.md).

Two historical UNKNOWN runtime rows were preserved; no destruction or quota
release was inferred from missing evidence. Cube also deferred cleanup of old
Template replicas after RPC timeouts. Newly registered templates work; the old
locator/cleanup path remains a tracked operational issue. Only acceptance-owned
Sessions and Workspaces were cleaned up. Unreferenced image objects follow normal GC.

## Deliberate limits

Automatic background Compaction is disabled through Pi's public setting because
PiCloud has no independent background admission lifetime. Foreground Compaction
remains native. Provider requests can repeat after interruption; arbitrary shell
effects are not exactly once. Native abort or a transport ACK does not prove a
remote process stopped. Local RF3 brokers share one host; process tests do not
establish power-loss or multi-node disaster-recovery guarantees.
