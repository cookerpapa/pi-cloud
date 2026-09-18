# Native context-overflow recovery — September 18, 2026

**The previously failing high-density-input boundary now recovers in the same
Run.** Worker `aad78995` was built and deployed; Control Plane stayed `5c9977fa`.
Production context/window settings remain 1,000,000/900,000. No changes to
queueing, ownership, Kafka ACK, PG projection, Tool execution or Cube templates.

## Fix

Pi's character estimate can undercount unseen input. The missing behavior was
in PiCloud's composition of Pi primitives: it had threshold compaction and
transport retries, but not the bounded overflow path in Pi's full AgentSession.
[ADR-0176](../adr/0176-bounded-context-overflow-recovery.md) adopts that behavior.

- Classify explicit errors using Pi's public overflow detector, only for the
  current model/provider. Force native Compaction even below the estimated limit.
- Acknowledge the Compaction through the native append path before continuing.
  Maintenance and subsequent sampling get fresh Steps, not a transport retry
  under the previous context. User input/operation are not resubmitted.
- Permit one recovery until successful sampling; repeated overflow without
  success ends the operation. Successful sampling permits recovery of a later
  distinct request. Cancellation/authority loss/failure cannot silently continue.
- Materialize model-visible interrupted-prefix custom entries for Pi's summary
  input, so compaction summarizes or retains them instead of dropping them.
  This is an in-memory projection, not duplicate history or a new storage format.
- Expose a safe `model_context_limit_exceeded` failure if recovery cannot finish.
  Do not expose upstream bodies or treat quota/authentication errors as overflow.

The original heuristic is intentionally retained. This is error recovery, not a
claim of exact token estimation or support for an irreducibly oversized input.
Failed/empty/truncated summaries preserve the old history. No blanket retries,
silent truncation, custom tokenizer or new middleware were introduced.

## Verification

The initial reproduction failed before the fix. Related suites then passed
**313 tests**, with one existing opt-in real-PG query benchmark skipped; a
subsequently added recovery-bound reset test passed separately, for **314 unique
passing checks**. Full workspace typechecks, formatting, documentation and diff
checks passed. This was not a new whole-repository audit or all-CI execution.

Coverage includes both direct PG and native-writer/projector backends, explicit
overflow below threshold, single retry exhaustion, disabled compaction, foreign
model errors, quota/invalid requests, completed Tool effects exactly once in the
fixture, one accepted input, unaffected sibling Lane, and cold context restore.
Summary failure, cancellation, authority loss and rejected Compaction ACK prevent
further sampling and retain history. These are controlled tests, not new process
crash/failover experiments.

An actual HTTP/SSE integration returns `context_too_large` inside HTTP 200, then
summary and answer. It verifies Step 1 → maintenance Step 2 → agent Step 3,
`reason=overflow`, `willRetry=true`, no transport-retry scheduling and no early
Run failure. Existing retry, Tool, search replay and storage conformance tests
also passed in the related suites.

## Real Luna + Cube acceptance

One new tenant/Session/elastic Workspace, GPT-5.6 Luna, medium, Fast off, original
1M/900k settings. No direct native-history insertion or artificial provider error.
Ordinary user messages grew the context with 92k-character inert fixtures.
One continuous SSE connection served the entire experiment, with no reconnect.

**19/19 Runs completed, 27 provider requests.** On growth Turn 15:

| Boundary | Observation |
| --- | --- |
| Previous successful context usage | 872,543 tokens |
| Pi's new context estimate | 895,559: below the 900k threshold |
| Initial sampling | Actual upstream overflow; failed Step 1 |
| Automatic native Compaction | Maintenance Step 2; 866,347 input tokens |
| Continuation | Fresh Step 3; 68,513 actual input tokens; expected acknowledgement |
| Run persistence | One operation start, one completed finish, one Compaction |

The recovery Run took **24.765s** end to end: **24.502s** in provider-route
requests, about **263ms** elsewhere. Provider routes include CLIProxyAPI.
The 16 ordinary no-compaction chat samples had median **128.272ms** non-provider
first-text time, maximum **332.639ms**. This small uninstrumented sample is not
a controlled speedup claim against the earlier instrumented study, and still
contains the previously observed startup tails. Receipt is at the frontend SSE
client, not browser paint.

Real Tools created insertion sort, binary search and a one-line effect log before
growth. After recovery, the Agent recalled the marker/files, read the programs,
added edge-case tests and ran both successfully. All **11 Tool results** were
non-error. Product file API verified the effect log still had exactly one line.
There were exactly **19 native user messages for 19 submissions**. The same-Run
Tool-before-overflow no-replay case is additionally covered by deterministic tests;
the live coding effects bracketed the overflow Run.

Native usage: **1,823,426 input, 6,149,376 cache-read, 2,239 output tokens** over
26 usage records, including the summary. The rejected request did not supply a
usage record. These are recorded token counts, not independently verified billing.

## Cleanup and limits

All test executions were sealed, released and projected beyond their seal offsets.
Product deletion purged the Workspace Volume and released its Cube before scoped
PG cleanup removed the test account, Session and related history (530 rows).
Original **33 tenants, 35 users and one Session/Workspace** remain unchanged.
Private test scripts, credentials and raw generated evidence were removed after
writing this report. Shared Kafka/WAL/service logs keep their normal retention;
no shared storage or user data was erased. No inspector probes were installed.

The new Worker remains deployed. An oversized current input or a summarization
request that itself cannot fit can still fail explicitly. Exact tokenization,
output-length recovery, transparent Run replay and new distributed crash testing
are outside this patch.
