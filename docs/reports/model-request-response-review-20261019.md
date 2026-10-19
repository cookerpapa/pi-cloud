# Native model request / response review

Reviewed source: `3625350fe9c1f7434ac2bb94341e1923ebff8867`.
Serving runtime: `native-recovery-8c00826a`, schema 191, unchanged by this review.
Pinned Pi AI/Durable: 1.0.0. CLIProxyAPI source:
`48549e65b86d17648029190331807b89e7fd65f4`, matching the provider image Dockerfile
and the clean local checkout used for source inspection and focused tests.

Scope: Pi/public Models admission → Worker-local Model Gateway → CLIProxyAPI/
provider forwarding → streaming response/native settlement. This closes the
remaining main-message walkthrough branch. Four confirmed findings require
repair; the existing whole-Run time policy is a separate discussion item.
No runtime implementation, deployment or provider/account configuration changed.

## Confirmed findings

### MR-01 — P2: gateway error normalization loses native retry classification

`model-gateway.ts:833` replaces a connection reset with HTTP 502 or an in-stream
error whose code is `provider_gateway_unavailable` and whose message is
`Provider Gateway request failed`. The pinned native retry classifier matches
specific transient-error text. That generic message does not match it.

The two public Pi provider adapters expose the error differently:

| Failure | Codex route | DeepSeek Responses route |
| --- | --- | --- |
| Connection reset before response headers | Non-retryable; HTTP status is lost in the assistant error text | Retryable; assistant error retains 502 |
| Reset after partial text | Non-retryable | Non-retryable |

The full native Harness experiment allows one retry and supplies a successful
second response. Codex sends once, leaves the Submission `unanswered` and records
one error Assistant message. DeepSeek sends twice and finishes the Submission
`done`, recording error then success. This is an adapter-boundary defect, not an
argument for another retry loop. Partial text is retained in the streaming-reset
cases, and model permits release once.

Direction: preserve a stable, sanitized transient-error meaning across the HTTP
and Models boundaries that the pinned public Pi retry policy recognizes. Add
whole-Harness tests for both routes, before/after headers, plus terminal quota/
protocol failures and user cancellation. Keep Durable as the retry owner; keep
one Gateway send per admitted request. Do not expose arbitrary exception bodies.

Source: [Gateway normalization](../../packages/supervisor-host/src/model-gateway.ts),
[Models adapter](../../packages/sandbox-supervisor/src/durable/scoped-models.ts).
Pinned evidence: `pi-ai/dist/utils/retry.js`,
`api/openai-codex-responses.js`, `api/openai-responses.js`,
and `pi-durable/dist/harness/generation.js`.

### MR-02 — P2: early text phases use a different index from native content

The Gateway's `ResponsesHostedActivityObserver` numbers only message items
(`responses-hosted-activity.ts:124`). `DurableTextPresentation` asks for the phase
using the index in Pi's entire content array (`text-presentation.ts:139`), which
also includes reasoning and Tool blocks. These indexes coincide only for some
response shapes.

With `[reasoning, commentary]`, the early commentary phase is stored at zero
but requested at one, so it is absent. With `[reasoning, commentary, final]`,
the commentary receives the final item's `final_answer` phase and the final
item receives no phase. Completed native text signatures eventually restore
the right labels; that does not make the earlier streamed display correct.

Direction: correlate by stable response/item identity and one explicit mapping
to native content. Cover reasoning, local Tool placeholders, multiple message
items, correction at settlement and concurrent Conversations. Do not assume
provider `output_index`, text ordinal and native content index are identical.

Source: [response observer](../../packages/supervisor-host/src/responses-hosted-activity.ts),
[text presentation](../../packages/sandbox-supervisor/src/durable/text-presentation.ts).

### MR-03 — P2: interrupted replies lose already-completed hosted search items

The observer sees `response.output_item.done` for a completed Web Search and
publishes its activity, but only emits the canonical transcript at the later
whole-response `completed`/`incomplete` event. The Runner's final decorator
therefore receives no transcript when the subsequent answer is interrupted.

The controlled stream completes a search, emits answer text, then either finishes,
loses its connection or is cancelled. The final model result contains one hosted
item on success and zero on either interruption, although completed activity was
observed in all three. Native Pi can retain interrupted assistant text, but the
omitted hosted item cannot be recovered from that text. ADR-0143's settled activity
reconstruction uses the native Assistant message, not permanent live-event tails.

Direction: keep already-completed provider items in the request's bounded state
and merge them through the trusted Models/native-message boundary, including
interrupted results and the progress that native abort may retain. Test native
abort, cold replay and citations before claiming the repair complete. Preserve
ADR-0230: incomplete **local** Tool calls still never enter native persistence.
Do not create a second hosted-transcript store or make late physical/provider
replies overwrite a settled native abort.

The exact visible reload behavior also depends on live-tail coverage; the probe
establishes missing canonical hosted content, not that every immediate refresh
must lose its temporary activity row. It uses a synthetic valid search event,
not a claim that the current Flash route has restored hosted search.

Source: [observer](../../packages/supervisor-host/src/responses-hosted-activity.ts),
[final decoration](../../packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts),
[transcript adapter](../../packages/sandbox-supervisor/src/provider-hosted-transcript.ts).
Contract: [ADR-0143](../adr/0143-hosted-search-activity-and-stable-markdown.md).

### MR-04 — P3: a successful native response can count as a model failure

The pinned Codex adapter ends when it receives the terminal response event and
cancels its SSE reader. If HTTP EOF has not yet reached the Gateway, that normal
close enters `downstream_disconnected`; the Gateway records
`modelDuration{outcome="failed"}` (`model-gateway.ts:468`).

The loopback case leaves the HTTP tail open after a valid completed response.
Pi returns `stop` with the correct answer while the Gateway records `failed`.
The request permit is released. This affects diagnostics, not the canonical Run
outcome. `transportCompleted=false` is valid byte-stream evidence but is not proof
that the model answer failed.

Direction: distinguish transport EOF/disconnection from model terminal outcome.
Record semantic success/error/abort at the Models boundary; keep transport timing
and disconnect cause in the Gateway. Test terminal-before-EOF, user Stop, real
mid-stream failure and HTTP 200 containing a provider failure. Do not suppress
all disconnect errors to make the metric green.

Source: [Gateway outcome](../../packages/supervisor-host/src/model-gateway.ts).
Pinned evidence: Codex `mapCodexEvents` returns after a terminal event and
`parseSSE` cancels its reader in `finally`.

## Architecture assessment and improvement direction

Keep the overall topology and authorities. Native Pi schedules/retries and
settles the Agent; the Worker binds current execution/model grants and local
permits; the local Gateway handles HTTP transport; CLIProxyAPI owns provider
credentials/account selection. Tools continue through the existing durable
dispatch path. A model payload is not another Projector job.

The main avoidable coupling is response semantics spread between the Gateway's
second SSE parser and the Runner's native-message decoration. Pi 1.0 publicly
exposes `onProviderStreamEvent`; both maintained native adapters pass it through.
The probe confirms the hook receives completed search items before either
interruption. A good repair direction is to consume that hook at the trusted
Models adapter for phase identity, completed hosted items and semantic outcomes,
keeping Gateway transport concerns separate. This can remove the duplicate byte
parser and cross-layer transcript/phase plumbing without patching Pi.

This is a feasibility result, not an implemented migration. Native partial
index stability, hosted-item ordering, abort persistence and hook failure isolation
still need repair tests. Existing hosted start/completion events intentionally use
the durable small-event path under ADR-0143/0245; they must not be silently deleted
as if they were ordinary disposable guest Tool previews.

### MR-D1 — existing ten-minute execution policy needs an explicit product decision

The deployed Worker uses a 600,000 ms Pi Turn timeout, a 900,000 ms model capability
TTL, a 120,000 ms upstream header wait, a 150,000 ms native header wait and a
300,000 ms stream-idle wait. CLIProxyAPI retry rounds, streaming bootstrap retries
and keepalives are zero; Codex bootstrap buffering is false. Model concurrency
is unlimited by default. These are read-only configuration observations.

`PiCloudTurnRunner.run()` starts its timer once, before native startup. Continuous
output, successive model calls, Tool waits and follow-up processing do not refresh
it. Thus the ten-minute setting bounds one Runner invocation, not only a stuck
request. An uninterrupted Run cannot execute for hours under this policy. A
replacement invocation receives a new local timer; this review does not claim
that the timer is a single durable wall-clock budget across all recoveries.

This policy is documented in [configuration](../CONFIGURATION.md#safety-coupled-one-host-budgets)
and was explicitly left outside quota removal in ADR-0215. It is not newly
introduced by the recovery repair. Decide the desired long-work behavior before
changing it: capability lifetime and deployment shutdown budgets must also fit.
Do not simply remove network-idle limits or extend one timer independently.

## Verification and boundaries

- **92 existing Node test cases in 16 files pass**: Gateway, local permits,
  observation/transcript adapters, Models authority, Tool-draft persistence,
  native retry/Compaction, text projection, Runner Stop and fake-provider contracts.
- **12 new characterization cases pass** with real loopback Gateway HTTP, pinned
  native Models adapters, and two full native MemoryStorage Harness cases. They
  deliberately reproduce reviewed behavior and are not post-fix regression claims.
- CLIProxyAPI: **12 selected top-level tests, 30 test/subtest pass events**, across
  executor, HTTP-handler and credential-conductor packages. They cover terminal
  failure, missing completion, post-completion transport failure, Responses error
  shapes and credential retry rounds. Local Go toolchain is 1.26.0; production
  builds use the separately pinned Dockerfile toolchain/dependency updates.
- No real model, production Run, PG/Kafka write or VM fault was used for this
  review. The previous release's paid/live acceptance remains separate evidence.
  Earlier 120-second waits and TLS EOF are not diagnosed by these local cases.

The first Harness-probe extension omitted its required registry, then assumed
native Entry pages were chronological. Both fixture mistakes were corrected;
the final probe sorts by native Entry ID and retains the original expected behavior.
Private failure logs remain available and are not counted as runtime defects.

[Reproduction instructions](../../scripts/experiments/review-model-branch-20261019/README.md)
and [aggregate evidence](model-request-response-review-20261019.json) are maintained
in the repository. Private execution output is under
`deploy/production/runtime/review-evidence/model-branch-20261019/`.

The main-message walkthrough is complete. The next work is resolving these
findings and the explicit policy discussion, rather than inventing more mandatory
hops. Optional Workspace/Subagent/upload/preview walkthroughs remain separate scope.
