# Native model request / response repair plan

Status: proposed, 2026-10-19; implementation has not started.
Baseline: `4cb3440b`. Findings: [combined review](model-request-response-review-20261019.md).
Serving runtime remains `native-recovery-8c00826a`, schema 191.

## Objective and authority boundaries

Repair MR-01–04 as one response-adapter slice. Keep native Pi's scheduling,
retry, cancellation, Storage commits and Tool execution semantics. Continue to
use one physical-Session writer and the existing Kafka/PG recovery path.

| Component | Responsibility after the repair |
| --- | --- |
| Pi Harness | Agent scheduling, bounded sampling retry, Compaction, abort and native persistence |
| Trusted Models adapter in Worker | Per-request provider-event interpretation, text/item identity, completed hosted content, native-message decoration and semantic model outcome |
| Worker-local Model Gateway | Existing capability/model admission, byte budgets, HTTP forwarding, cancellation and transport timing/errors |
| CLIProxyAPI | Existing provider credential/account selection and upstream protocol handling |

Use Pi 1.0's public, read-only `onProviderStreamEvent` and normalized model stream
events. Reuse existing hosted-action normalization, transcript replay and native
Storage facilities. Add no service, scheduler, sidecar store, provider SDK fork,
second parser in the Gateway, separate retry owner or compatibility path.

Before production edits, record the accepted ownership/metadata/metric decisions
in a current ADR. This plan proposes changes; it does not mark them implemented.

## 1. Establish the native progress and cancellation contract first

Turn the review's characterization cases into expected-behavior regression tests.
Use the real pinned Models adapters and native Harness with an instrumented
Storage commit boundary, then reopen the acknowledged prefix.

Establish these constraints before replacing the Gateway observer:

- Provider callbacks are read-only observations of adapter-owned objects. Keep
  detached per-request state; never mutate the provider's stream objects.
- Correlate by response/item identity and explicitly map normalized native
  content positions. A provider output index, message ordinal and content index
  are not interchangeable.
- Complete hosted operations are distinct from incomplete local Tool drafts.
  Local Tool names/IDs/arguments remain excluded until a successful complete
  model response under ADR-0230.
- Decorated partials and terminal messages preserve stable text identity and
  ordering as hosted items appear. Source buffers cannot later mutate a submitted
  snapshot. Include search-only output and searches between two text items.
- Stop uses Pi's committed partial, not a late final decorator. Verify native
  abort and cold reopen, with a commit held before acknowledgement and again
  after acknowledgement. An already-committed hosted item must survive with the
  interrupted text. Cancellation/worker loss must not manufacture uncommitted
  history or admit a late completion over native abort.

The durability boundary remains Pi's acknowledged commit. The plan does not
promise zero loss of provider events that arrived before a crash but never reached
that boundary. For the search-completes-with-no-further-text case, explicitly
establish what public model progress can carry before claiming Stop preservation;
do not simulate a local Tool call, invent visible text, mutate `pi.live` behind
the Harness, or add a second recovery record to bypass a failing contract test.
Any genuine public-API gap must remain explicit rather than being declared fixed.

## 2. Consolidate response semantics at the Models boundary — MR-02 / MR-03

Give each admitted model request a small state object owned by its existing
Models invocation. It observes parsed provider events and normalized Pi events,
and produces detached message/progress views. State is scoped to the actual
request, including Conversation, native task and sampling attempt; it is disposed
on every completion/error/cancellation path. There is no shared mutable response
map across retries or Conversations.

### Early phases

- Bind provider message IDs to the native text positions established by actual
  normalized stream events. Apply the provider's early phase to that text only.
- Let completed native signatures supply the final authoritative phase, including
  late provider revisions. Do not guess `final_answer` from an absent phase.
- Keep the existing text publication/coverage path and browser correction behavior.
  Adding hosted content must not shift a displayed text identity into another item.

Acceptance: `[reasoning, commentary, final]`, text-only, local Tool placeholders,
multiple searches, empty text, late correction, retries and concurrent children
all preserve the expected text/phase association through settlement and reload.

### Completed hosted content

- Capture an actual completed hosted item when its completion event arrives,
  rather than waiting only for `response.completed`. Retain complete item fields
  and known citations; do not retain unrelated raw SSE traffic.
- Make those completed facts available to valid native progress and terminal
  messages through the contract established in step 1. If new completed content
  arrives after the last text delta, verify the public progress boundary explicitly.
- Merge normal/error/length-truncated outcomes without duplicating completed
  items. Native abort retains its acknowledged progress; later provider output
  cannot rewrite the abort outcome.
- Preserve provider/API/model-scoped replay and portable display fields. Local
  Tool drafts remain private, including drafts carried in another text event.
- Retain ADR-0143's small durable start/completion activity path and native settled
  reconstruction. Activity alone is not a new durable hosted-result store or an
  acknowledgement that a native progress body has committed.

Acceptance: success, disconnect after completed search, native Stop, Worker
replacement, search-only response, multiple searches/citations, same-provider
replay and provider/model switch. Confirm completed items survive an acknowledged
partial and local drafts never enter Kafka/PG. A synthetic Flash search event
does not establish actual hosted-search availability on that provider route.

### Remove the replaced path

After tests exercise the replacement end to end, remove the Gateway SSE observer,
its response-phase maps and hosted-activity/transcript subscriptions, the lease
interfaces exposing those semantics, and Runner plumbing used only to reconnect
that split state. Keep transport grants, model settings, hosted Tool declarations
and transcript replay. Do not ship both implementations or a fallback switch.
Update existing tests and delete obsolete defect-asserting probes once their
maintained regressions cover the accepted behavior.

## 3. Preserve native retry classification — MR-01

Keep one Gateway send per admitted request and native Durable as the retry owner.
Map known connection/header/stream failures to stable sanitized errors whose
meaning survives both Codex and generic Responses adapters. Use existing Gateway
error categories; avoid a new independent error/retry ledger.

- Before headers, return the appropriate HTTP status plus a clear transient
  connection/timeout meaning. Do not depend on the Codex adapter retaining status.
- After headers, preserve partial text and emit a protocol-visible error with
  the same transient classification. Do not convert a broken response into success.
- User Stop, revoked ownership, invalid model/protocol/body and terminal quota or
  billing failures stay distinct. Do not label every thrown exception retryable.
- Retain bounded local admission refusal as such. A later native retry must not
  bypass capability, byte or request-budget checks.
- Keep lower Pi transport retries and CLIProxyAPI additional retry rounds disabled
  under the maintained policy. Credential selection/failover remains CLIProxyAPI's
  responsibility. Release the model permit before native backoff/Tool/child waits.

Acceptance: both model routes, header reset, stream reset after partial text,
header/idle timeout, recovery on the next native attempt, exhausted native retries,
Stop during backoff, quota/configuration failure and preserved Tool non-replay.
Assert actual upstream send count and native Submission outcome, not only strings.

## 4. Separate transport and model outcomes — MR-04

The Gateway continues to report bytes, response-header timing, EOF/disconnection
and cancellation. An HTTP 200 or EOF alone does not decide model success.

Move semantic request outcome/duration measurement to the Models invocation,
after parsing and the cloud completion policy. Define completed, error, aborted
and any supported deferred outcome explicitly. Queue/permit wait and HTTP timing
remain separately named observations. Every admitted invocation settles its
semantic measurement at most once; refused admission cannot count as provider work.

Replace the old metric writer and update its name/help/labels or dashboards as
needed so one metric does not mix Gateway duration with Models duration. Remove
the obsolete interpretation without a compatibility alias or double counting.
Keep the existing native sampling identity for correlation; add no Run/Step rows.

Acceptance: completed response before HTTP EOF, HTTP 200 with provider error,
truncated response, genuine disconnect, Stop, pre-send refusal and parsing/decorator
failure. Metrics/logging failure must not change model execution or native settlement.

## 5. Verification, cutover and documentation

Implementation order: native contract tests → request-local semantic adapter and
MR-02/03 → MR-01 → MR-04 → remove old plumbing → required repository checks →
drained matched release → relevant live acceptance and owned-fixture cleanup.
These are internal implementation stages of one slice, not parallel live paths.

Required verification includes the existing model/Runner suites, new full-Harness
and PG/Kafka cold-recovery cases, faulty-stream contracts and the repository's
type/build/format/docs/native/fault/transport checks. Record protocol or native
metadata changes in the ADR and matched release requirements before rollout.
No new database table or separate checkpoint is planned. If an unavoidable stored
format change is found, use a matched development cutover, not dual readers.

Live acceptance uses `gpt-6-luna`: ordinary text/Tools, commentary/final phases,
Stop and pending input, native child concurrency, Worker recovery, image cold
recall and relevant Cube/Control Plane recovery gates. Real hosted search is
tested only on a route that actually supports it; deterministic interruption
experiments provide the reproducible failure boundaries. Failed upstream samples
remain separate from implementation failures; do not alter deadlines or weaken
payloads just to obtain a green result.

After the required checks, use the already-authorized routine matched deployment.
Drain/fence writers, preserve original accounts/model/provider configuration and
credentials, and confirm physical owned-fixture deletion before discarding their
ownership records. Update architecture, reading progress, backlog and a release
report with source and live acceptance separately identified.

## Separate discussion: ten-minute Runner policy — MR-D1

This four-defect repair keeps the current time budgets. The 600-second timer is
a whole Runner invocation, including progressing output, Tools and follow-ups;
it is not a network-idle timeout.

If long-running Agent work is the intended next slice, the recommended direction
is an explicit optional whole-work budget plus independently bounded network and
Tool operations. Current Session ownership remains the execution authority.
Model capability expiry/renewal and revocation must fit that ownership, while
deployment draining/recovery must not require waiting for an unlimited Run to
finish. Preserve ordered writer closure and same-Run recovery.

That decision needs its own complete lifetime/recovery plan and tests. It does
not follow from removing one `setTimeout`, increasing a TTL or removing all
request-idle bounds; no such change is included implicitly in MR-01–04.
