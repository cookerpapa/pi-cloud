# ADR-0254: Worker reply admission, receipt and local replay

Status: accepted; implemented, deployed and verified, 2026-10-18. The owner approved
the repair plan and implementation following the
[Kafka → Worker review](../reports/kafka-worker-reply-review-20261017.md).
[Verification and delivery](../reports/worker-reply-repair-20261017.md) record the
resolved host KVM blocker, `worker-reply-b1f67dba` matched release, live acceptance
and confirmed fixture cleanup separately from isolated source tests.

## Scope and existing authorities

Repair KWR-01/02/03 in the existing boot mailbox, Worker composition and remote
Tool adapter. Reuse the pinned Kafka consumer and Pi Durable public Tool/Storage
contracts. This is a bounded adapter repair, not adoption of another scheduler,
broker, result store or workflow history.

PG continues to own Run claims and Session grants. Kafka transaction ACK is the
native write boundary; Pi owns Tool settlement and canonical history. A mailbox
receipt only describes what this Worker observed. It neither proves native
commit nor grants execution authority. Control Plane retains VM lifecycle.

## W1. Thin admission checks

Retain existing Worker lifecycle/management connection checks, local capacity
and memory admission, and the cached usable Session-log partition mask. The
Kafka mask keeps its current background cadence and freshness bound; new claims
read the cached result, outside the PG claim transaction.

Expose the boot reply consumer's existing local health through the mailbox.
Compose it into HTTP readiness and new-Run claim admission. Read the current
local state at the admission boundary, so an old successful background sample
does not hide a consumer which has already lost assignment or failed. This adds
no probe message, network request or database query. A failed local check leaves
new work in the PG queue; healthy reassignment automatically reopens admission.

Remove CLIProxyAPI `HEAD /healthz` as a Worker startup and periodic admission
prerequisite. Keep starting the local Model Gateway itself and preserve actual
provider requests' timeout/retry/error behavior. Provider deployment health
remains its own operational concern. Delete `checkProviderHealth` when its two
production callers are removed, including tests which only assert that obsolete
admission requirement. Move startup-failure/Stop resource-joining tests to a
required initialization boundary rather than losing that lifecycle coverage.

Tradeoff: a Run may now be claimed while CLIProxyAPI is unavailable, then surface
the real model request's failure through existing handling. `/healthz` never
proved a particular model, credential or upstream call would succeed. Actual
Kafka initialization and commits still decide whether native state can advance.

An admission failure does not abort already claimed Runs. Retain the existing
fixed-Tool reply deadline, ADR-0253's eligible UNKNOWN/readiness behavior, outer
Run budget, user Stop and ownership-loss handling. Control Tool waits keep their
existing caller cancellation/outer Run bounds; do not apply Bash's duration to
a Subagent. This resolves the review's pending-wait policy question without a
second Worker-wide outage timer or an independent execution authority.

Primary files: `event-log/src/tool-replies.ts`,
`supervisor-host/src/runtime.ts`, `run-claim-readiness.ts`, `model-gateway.ts`
and the existing Worker claim/readiness tests.

## W2. Resume the same boot's delivered suffix

Keep the reply topic, single consumer and `commitMessages:false`. Add an explicit
volatile-resume mode for this consumer, using the reader's existing processed
position. Do not duplicate that position in a new mailbox store. The generic
consumer's durable Projector replay behavior remains the default.

Rules for each reply partition:

1. First assignment starts at Kafka's retained low watermark.
2. A record advances progress only after decoding and completed callback
   delivery/retirement; retain the reader's assignment-generation and in-flight
   handler checks. Failed decoding or incomplete handling cannot advance it.
3. Reassignment within this boot resumes from completed local progress. If
   retention has advanced past it, resume at the new low watermark without
   pretending a missing reply was delivered. Existing wait bounds still apply.
4. A position above Kafka's high watermark is inconsistent: report unhealthy
   and refuse admission rather than silently resetting the position.
5. A new Worker boot creates its own topic and callbacks. No file, PG row or
   previous boot's consumer state is restored into it.

Reject combinations which could accidentally enable volatile resume for the
durable Projector recovery/effect-dispatch path. Image downloads remain outside
the Kafka handler; the consumption cursor means callback delivery, not image
availability or canonical Pi commit.

Primary files: `event-log/src/kafka-log-consumer.ts`, `tool-replies.ts` and their
reader/reassignment tests. No per-reply Kafka offset commit or PG receipt is added.

## W3. Separate execution receipt from attachment availability

Replace the combined-Promise contract at the internal reply port with a small
invocation-owned wait handle: an eventual result plus a read-only indication
that execution settlement is known. The mailbox updates that indication before
resolving/rejecting its registered waiter. Image restoration preserves the same
handle's indication while producing the eventual native Tool content.

Known settlement means a validated final `tool_result`, including a native Tool
error, or trusted `execution_failure` with `effect:not_started`. UNKNOWN,
malformed/mismatched replies and cancellation without a prior receipt do not
become known settlement. Duplicate or late replies cannot change a retired
handle. This is bounded state attached to the existing invocation, not a result
cache, durable receipt or second operation registry.

Update all current callers together: fixed Tools, control Tools and workflow
hostcalls. Pi's `execute()` still awaits the result. Use the receipt indication
for the existing `completed()` cancellation decision; never derive physical
completion from whether S3 decoding finished. Remove the old booleans and Promise
branches that conflate those stages rather than supporting both contracts.
Registration and rejection observation still precede intent publication. Observe
both the raw and image-restoring Promises immediately, and dispose the handle on
failed publication, uncertain writer closure, cancellation and terminal cleanup.
A fast receipt does not bypass the original native commit's ACK requirement.
The receipt deadline bounds waiting for that receipt. Image restoration uses
the existing attachment-read budget plus the caller's cancellation/ownership
signal; expiration of an already-satisfied receipt deadline cannot relabel the
subsequent image read as missing execution evidence.

Classify failed attachment restoration as `tool_result_attachment_unavailable`
at the Worker adapter. Preserve this reason through the existing Run interruption
and UI/context explanation path; do not convert it to execution UNKNOWN. Update
any affected parser/reason mappings as one matched change. A readable error
should say that the Tool replied but its attachment could not be restored.
Do not expose object-store credentials or private transport details.

For this repair, retain interruption of the current Run after a non-cancellation
attachment failure. Pi may settle the diagnostic through its normal Tool error
mechanism, and the existing pre-model interruption boundary prevents another
model request. Separate that interruption from marking sandbox world state
unavailable or setting cancellation-unknown cleanup intent for this already
settled operation. Other genuinely unfinished operations retain their own
cancellation/cleanup requirements.

Stop during attachment download cancels the download and lets Pi settle native
abort. A known-completed Tool is not cancelled retroactively; late image bytes
cannot overwrite abort. Stop/lease/fencing failure takes precedence over an
attachment diagnostic. An image restoration error alone grants no Tool replay
or VM destruction. Whether a future release should let Pi continue after this
error is outside this conservative repair.

Primary files: `event-log/src/tool-replies.ts`, `supervisor-host/src/runtime.ts`,
`supervisor-host/src/tools/worker-tool-runtime.ts`,
`sandbox-supervisor/src/trusted-remote-tools.ts`, `durable/remote-tools.ts`,
`subagent-control-client.ts`, `remote-tool-sandbox-turn-runner.ts` and the existing
Run interruption mapping. Image scope and integrity checks remain enforced.

## Verification and delivery

Implement W1, then W2, then W3; release the complete slice after verification.

- W1: actual Worker composition shows unready/no new PG claims on reply-consumer
  failure and ready/claims restored after reassignment. Kafka healthy-partition
  filtering and local capacity remain effective. Provider HEAD failure does not
  block Worker startup/admission; a real model request still has bounded failure.
  An existing Run is not aborted by an admission observation alone. Preserve
  startup Stop and failed-initialization cleanup coverage.
- W2: use an isolated RF3 fixture to consume 100 replies, reconnect/reassign in
  the same boot and receive the next reply without replaying the delivered 100.
  Cover in-flight handlers, revocation, duplicates, decoding failure, retention
  movement, impossible high-watermark positions and fresh boots. Existing
  Projector recovery and monotonic effect-dispatch tests must still pass.
- W3: compose actual mailbox, image codec, remote adapter and pinned Harness.
  Cover successful image restoration, an injected S3/metadata/integrity failure
  after receipt, Stop during decoding, trusted `not_started`, true UNKNOWN,
  malformed identity, fast replies/early decode rejection before publication ACK
  and late replies. Assert accurate canonical diagnostic/
  interruption, no next model request after attachment failure, and no false
  sandbox-unavailable or cancellation-unknown state for a completed operation.
  Neither callback receipt nor image restoration may replace Pi's commit.
- Move the review's baseline characterizations into maintained regression tests
  with repaired expectations. Keep the published baseline evidence in Git, not
  parallel tests which require the old bug to remain.
- Run affected package tests/types, the transport and fault suites, then required
  repository checks. Build/scan the maintained matched release. No PG migration
  or Cube guest/native wire change is expected; source and protocol validation
  decide the final release identities, without compatibility branches.
- Deploy through the existing drain/fencing procedure. Relevant live acceptance
  uses GPT-6 Luna and covers ordinary Bash/Read, image results, Stop, native input,
  child/control replies and Worker recovery. Inject faults only into owned test
  resources, verify physical cleanup, and preserve accounts/configuration/credentials.

The proposal does not change the accepted crash boundary: a Worker can still
lose a result received before its canonical Pi commit. Native unsafe recovery
handles that uncertainty without automatically repeating shell effects.
