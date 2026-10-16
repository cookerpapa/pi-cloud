# ADR-0253: Tool reply uncertainty and bounded continuation

Status: implemented, deployed and verified, 2026-10-17.
[Verification record](../reports/tool-reply-continuation-20261016.md) distinguishes
passing Tool/Worker cases from the conservative Volume cleanup limit and its
operator-confirmed fixture cleanup. Baseline: `03c3a7ec`; serving release:
`tool-unknown-791a6ed0`.

The owner accepted retaining Pi's final-result Tool contract, bounded remote
waiting and a small internal probe after an unconfirmed result. A usable path
may let the Agent inspect effects; an unavailable or unconfirmed path interrupts
execution. Probe traffic must never enter native history or model context.

This narrowly amends ADR-0227's unconditional sampling stop on infrastructure
UNKNOWN, using ADR-0201/0211's existing probes and ADR-0247's current ownership.
It does not change Pi's loop, writer fencing or Control Plane lifecycle authority.

The first live injection found an adjacent recovery gap: after the idle completion
child exits, only capability discovery or delivery of an already accepted result
calls `EnsureReady`. A reused VM's next Submit/async probe simply refuses the
unready adapter, so the intended lost-result scenario was never admitted. The
fixture restored the adapter and removed its tenant/VM; no original command ran.
Extend the existing three-second readiness recovery to Submit and async-probe
admission. Healthy requests retain their memory-only readiness check; failed or
cancelled recovery still refuses before execution. Direct physical guest probes
remain independent of Kafka/adapter availability. This reuses ProcessDelivery's
existing process owner and does not retry an execution, introduce a supervisor,
change the wire or relax node/position/VM fencing. Add native child-exit/recovery
and cancellation tests, then repeat the matched artifact release and live checks.

The repeated live fixture subsequently exposed a pre-existing startup/Stop race.
Stop aborted Kafka producer preparation before a publication finalizer existed;
ordered recovery requeued the same Run and redelivered Stop into preparation,
repeating without ever opening Pi for cancellation. Retain the Stop intent while
the bounded, authorized writer bootstrap completes. Open the native runner in
its existing `stopOnResume` mode, which blocks model/Tool effects, then deliver
the acknowledged Stop through normal Pi abort settlement. Startup failure still
uses ordered closure/recovery; neither Stop nor an operator bypasses producer
authorization or fencing. Add real-PG startup/cancel/recovery coverage. Remove
the unrelated 128-item Run-transition response validation cap: legitimate Run
recovery history must remain readable, without truncating its records. The API
shape and durable schema do not change. The fixture must tolerate a newly
accepted Turn whose transcript has not yet materialized.

The owned failed fixture's claim policy is disabled while this repair is verified;
its records and immutable cleanup targets remain intact. If normal draining is
blocked by that pending Stop, a scanned Worker image with the same wire/schema
may settle only the isolated fixture before the full matched cutover. Record the
temporary rollout, writer closure and physical cleanup, then reconcile the whole
matched release. Never patch live source or discard the pending Run to pass a
deployment gate.

The scanned recovery ended the loop but exposed an older preparation shortcut:
the claimed Workspace seed descriptor converted an already delivered Stop into
`workspace_seed_cancelled` before Pi opened. Seed resolution is pure immutable
metadata construction and performs no guest/filesystem effect. Remove that
cancellation parameter/check, and let the original Stop signal reach native Pi
bootstrap/abort. The production native-session opener already retains authority
checks independently of the user Stop signal. Cover the actual remote runner,
real seed resolver and pinned Harness with Stop already signalled, proving zero
model requests, zero Cube activation and native cancellation settlement.

## Review recap and accepted limits

The preceding guest-to-Cubelet findings are already repaired under
[ADR-0252](0252-tool-receipt-and-ephemeral-preview.md), with
[deployed acceptance](../reports/tool-receipt-preview-repair-20261016.md). They
are not outstanding work in this plan. The current walkthrough covers the
trusted Cube completion adapter, Kafka reply publication and the adjacent
Worker wait/failure boundary. Findings below come from source inspection and
discussion, not a newly completed live fault review.

- Cubelet keeps an immutable result in memory while its completion adapter
  externalizes images and publishes to the original Worker boot's Kafka topic.
  Kafka publication ACK precedes `delivered:true`. The existing bounded delivery
  retry sends the result again, never the shell command.
- Whole-Cubelet/node loss before reply publication can lose that result. The
  owner accepts UNKNOWN and subsequent inspection; add no disk/PG result outbox,
  raw-result GET/cache, guest Kafka producer or operation ledger.
- `trusted-remote-tools.ts` currently bounds every fixed Tool wait with
  `MAX_TOOL_EXECUTION_TIMEOUT_MS + 120_000`, even when that invocation's execution
  budget is shorter. File Tools use 60 seconds; Bash uses its requested timeout
  or the current 300-second default/maximum.
- `tool-execution-outcome.ts` blocks sampling on every typed unknown effect.
  `remote-tool-sandbox-turn-runner.ts` records an unavailable world state and
  retires the activation on unwind. A lost result alone does not establish that
  new inspection is impossible.
- `tool-result-outcome.ts` recognizes six historical names. Current production
  searches find no producers for `subagent_result_unknown`, `tool_result_released`
  or `tool_command_delivery_unknown`; remove those orphaned recognizers and
  interruption mappings rather than preserving development compatibility.

## Reuse rather than change the execution model

Pinned [Pi Durable 1.0 ToolTask](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/harness/tool.ts)
awaits `execute`, then applies native result/error settlement. Its
[Bash Tool](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/tools/bash.ts)
has an optional timeout without a default. PiCloud retains explicit cloud
execution budgets; it must not present those limits as upstream Pi requirements.

The inspected [Codex command manager](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs)
supports returning an active process and collecting later output. That is a
different Tool interface and process-management contract, not a remedy for a
lost final reply. Do not add that interface in this slice.

Reuse the fixed guest echo, Session publication path, Projector binding view and
boot-scoped reply mailbox already adopted in
[ADR-0211](0211-execution-path-and-runtime-probes.md). No additional infrastructure,
consumer group, scheduler, durable health table or checkpoint authority is needed.

## U1. Separate effect certainty from permission and readiness

Keep `effect: not_started | unknown` as execution evidence. A failure's source
must provide trusted classification; never infer continuation from arbitrary
Tool output or an error message's substring. Review generic transport catches
so protocol/identity failures are not silently downgraded to ordinary lost replies.

The eligible case is an unconfirmed final result or handoff for a fixed
`tool.execute` operation, with no evidence requiring interruption. Before and
after any probe, preserve the existing current-owner and cancellation checks.
These conditions always take precedence over successful probing:

- user Stop, native abort, Worker shutdown or loss of the Session grant;
- uncertain native-log publication, writer fencing or closure;
- closed/revoked binding, executor replacement or controller quarantine;
- identity/protocol inconsistency or unconfirmed unsafe cleanup.

Workflow/control-channel failures retain their current interruption policy. A
guest echo cannot establish that an interactive hostcall or child orchestration
channel can resume. Ordinary native Tool errors and confirmed-before-start
refusals retain their existing Pi/error and availability semantics.

Implementation classification is deliberately narrow: `tool_reply_timeout`
means the Worker's own deadline expired; `tool_handoff_unconfirmed` means a
transport failure/temporary HTTP error prevented trustworthy Cube takeover
confirmation. Only these enter readiness. Generic native execution UNKNOWN and
arbitrary adapter exceptions retain interruption. Known malformed completions
publish `tool_reply_protocol_error` instead of disappearing into a later timeout.

## U2. Use a fresh bounded probe only on the eligible failure path

Expose one small PiCloud-owned readiness port to the cloud Tool adapter. The
Worker runtime publishes an on-demand probe through its existing Session writer,
Projector routes from the current binding view, and the fixed guest echo returns
through Cube completion and the original boot's Kafka mailbox.

- Reuse the existing 10-second probe budget, including any local scheduling;
  no unbounded probe queue, repeated probe loop or per-Tool database query.
- Require a fresh outstanding nonce sent after the uncertain failure, the same
  Worker/Session ownership, binding, physical target and executor boot. Reuse
  partition-owner binding validation and current closure admission. An HTTP
  observation report is not an execution grant, and an old dashboard sample is
  not a continuation decision.
- Bring the validated outcome back to the Tool adapter through the runtime port;
  do not add Cube management SDKs/credentials to the Worker. Check cancellation
  and current authority again before normal Pi settlement/continuation. Every
  subsequent Tool still passes ordinary admission; a successful probe cannot
  authorize a later effect after revocation.
- Coalesce concurrent uncertainty checks for the same current binding/owner;
  never borrow another Worker's successful reply path. Explicitly distinguish
  confirmed readiness, confirmed unavailability and readiness not confirmed.
- Do not allocate or wake a VM for this test. Probe packets carry no Workspace
  contents, become no Pi task/entry/Tool result, consume no model request or Tool
  call budget and create no PG health/history rows. They remain disposable Kafka
  transport records under the existing retention policy.

The original Worker confirms its returned nonce at
`POST /internal/v1/execution-readiness`, using the existing bounded observation
body and Worker management credential. The partition owner checks the outstanding
probe and re-reads current binding/target/boot admission from memory. It returns
204 when confirmed, 409 otherwise, or the existing 307 owner redirect. The Worker
allows one bounded HTTP retry within the same overall ten seconds. A lost HTTP
confirmation remains unconfirmed. This adds no Kafka reply fields or PG query;
normal observation delivery retains its existing separate, disposable semantics.

Probe success establishes a recent small round trip only. It does not prove the
old command completed, that all Tool/storage services work, or that a large image
reply will succeed. Probe failure is not proof of a dead VM and never authorizes
destruction, quota release, command replay or reopening an old owner.

## U3. Settle once, then either inspect or interrupt

On confirmed readiness with all ownership/closure guards still satisfied,
return the unconfirmed operation through Pi's native error-result path. Preserve
UNKNOWN in live and restored views. The bounded model-visible explanation says
the operation may have executed or may still be running and asks the Agent to
inspect effects before deciding to repeat it. It contains no probe packet,
nonce, stage telemetry or copied health history.

Pi must commit that result through its normal Storage before another model
request. A publication failure still enters ordered writer recovery. Do not
mark the world state unavailable or retire the whole binding solely for the
eligible result loss. Cube retains accepted operation lifetime/timeout cleanup;
no automatic original-command resend or whole-VM cleanup is introduced.

If readiness is unavailable/unconfirmed, retain the existing interruption and
controller recovery path. This slice adds no automatic resume scheduler and
does not promise that a failed probe identifies the broken component.

Permit at most one continuation after UNKNOWN without an intervening confirmed
Tool result in the affected Conversation/binding. If the subsequent inspection
also becomes UNKNOWN, interrupt instead of repeatedly probing and sampling.
This is a transient guard in the existing Worker runtime, not a durable queue.
Concurrent failures share their in-flight check. Stop always wins permission to
continue; native Pi still owns cancellation and result-settlement races.

Retain one terminal outcome per original mailbox wait. Duplicate/late replies
cannot revive a retired waiter or replace a canonical UNKNOWN/abort result.
An Agent's later inspection is a new ordinary Tool call, not a replacement
result for the old operation.

## U4. Bound waiting by this invocation and remove obsolete branches

Replace the global maximum in the fixed Tool reply deadline with the validated
invocation's `timeoutMs`, initially retaining the existing 120-second transport
allowance. Keep the origin at waiter registration, before dispatch publication;
never start another full execution budget after each progress frame or retry.
Check the native execution/settlement allowance, 30-second result delivery window
and compatible Control Plane outage tests before reducing that allowance.

Initial examples, excluding the additional bounded readiness check:

| Invocation | Reply wait budget |
| --- | --- |
| File Tool, current 60-second execution budget | 180 seconds |
| Bash with `timeout: 30` | 150 seconds |
| Bash with the current default 300-second budget | 420 seconds |

This does not change the current guest execution limits or make a Worker wait
timeout proof that a process stopped. Remove the three orphaned error names above
and update the maintained tests/docs without compatibility decoding.

## Implementation order, acceptance and release

1. **U1:** characterize current deadline/UNKNOWN behavior and implement trusted
   failure classification and hard-stop precedence using the pinned native Harness.
2. **U2:** expose the existing probe path through the runtime readiness port;
   test fresh identities, closure races, duplicates, coalescing and bounded waits.
3. **U3:** implement native UNKNOWN settlement with conditional continuation and
   the repeated-uncertainty guard; preserve Stop, Workflow and cleanup behavior.
4. **U4:** apply invocation-specific deadlines and remove orphaned branches;
   run source, runtime-budget, real PG/RF3 transport and deterministic fault gates.
5. **U5:** build/scans and the maintained drained matched release, followed by
   relevant real GPT-6 Luna/Cube/browser, native-input and recovery acceptance.

Required evidence:

- Execute a file append once, deliberately lose its reply, pass a fresh probe,
  and inspect the file in the same Run. Prove one original execution and one
  canonical UNKNOWN result, plus a distinct subsequent inspection result.
- Lose the result and the probe: bounded interruption, no subsequent sampling
  and no inferred VM destruction/replay. Exercise real owned Cubelet loss as
  well as adapter failures; isolate faults from unrelated users/resources.
- Stop, shutdown, fenced writer, uncertain log commit, closed/replaced binding,
  quarantine and protocol mismatch cannot be overridden by a successful probe.
- Reply/deadline/probe/Stop races, late and duplicate Kafka replies, publication
  failure during settlement, Worker replacement and sibling Conversations retain
  native cancellation, fencing and single-result behavior.
- A successful small probe followed by another lost Tool result interrupts;
  image/storage or Workflow failure cannot cause an endless successful-probe loop.
- Inspect actual provider requests, native Entries/docs and PG state: no probe
  payload/context, no health sample rows, no new result ledger and no query on
  ordinary Tool/probe routing. Measure healthy-path overhead and added fault delay.
- Browser/history agree on UNKNOWN while successful inspection can continue;
  no synthetic probe Tool row. Existing receipt-only/background preservation,
  native input/Stop and required Cube suites remain green.

Keep schema 189, Session topic v17 and the current reply/guest contracts if their
shapes remain unchanged. If implementation needs new wire evidence, version that
contract and replace all participants together; no old-wire fallback. No schema
or business-data deletion is planned merely for this behavior change. Preserve
accounts, provider/model settings and credentials; drain writers and confirm
physical cleanup before retiring ownership. Record source checks, deployment,
live evidence, failed samples and cleanup separately. Rollback uses a drained
matched artifact set, never mixed protocol readers.
