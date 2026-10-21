# Subagent wait investigation and Ultra collaboration proposal

Date: 2026-10-21. Source baseline: `d46c0543`; serving application base
`component-release-ad5fc83c`, schema 196. This is investigation and a proposal,
not an implemented runtime change. The owner authorized stopping the affected
Run and requested Ultra-gated delegation. The later clarification points to
Codex's single thinking-effort picker. The initial independent collaboration
selector proposal is withdrawn after inspecting Codex's actual request mapping
and proactive-delegation policy; the corrected proposal is below.

## Observed behavior

The affected frontend task used GPT-6.1 Sol with `xhigh`. The parent delegated a
rendering module; that child later delegated a read-only review. Native history,
current records and Worker model timings establish this local timeline:

| Event (Asia/Shanghai) | Observation |
| --- | --- |
| 13:46:59 | Root work starts. |
| 13:56:26 | Parent issues the blocking direct-delegation Tool. |
| 14:09:32 | Child creates a reviewer grandchild. |
| 14:11:50 | Reviewer completes; its response reaches the child. |
| 14:18:52.239 | Child final answer is materialized. |
| 14:18:52.366 | Parent's successful native `subagent` Tool Result is materialized. |
| 14:18:52.499 | Parent starts its next model request. |
| 14:18:53.202 | Owner-authorized Stop is accepted. |
| 14:18:53.527 | Root is cancelled and sealed. |

The child takes about **22 minutes 25 seconds**. It makes **22 completed model
requests**, totalling about **18 minutes 35 seconds** of measured model-request
wall time. One request generating about 43,000 source characters takes about
433 seconds. This is request duration, not an isolated model-compute measurement.
The child also performs additional review, drawing checks and corrections.

Two package-install operations fail: npm receives 503/Forbidden, and pip cannot
establish its proxy tunnel. Matching egress observations say `proxy_disabled`;
the platform's public-egress setting is disabled. The child then constructs an
offline drawing/checking substitute. The evidence does not establish an upstream
model TLS failure or a lost Tool reply in this Run.

The 127 ms difference between the two materialization timestamps is not a general
transport latency benchmark. It does establish that this child's completed result
was already in the parent's native context before Stop. All native tasks are now
terminal and the physical Session has no active writer. Stop used the same
`ControlPlaneStore.acceptTurnCancellation` transaction as the chat endpoint; no
manual terminal-state rewrite or VM destruction was performed.

## Design findings

1. Delegation currently has no user collaboration-mode gate. Worker offering uses
   tool applicability and optional depth, while the runtime prompt permits
   delegation. Children inherit the root's model/effort and can delegate again.
2. Direct `subagent` intentionally waits for a result or a supervisor decision.
   A single direct call does not keep the parent generating other work. The
   observed extra level adds review and coordination; it is not automatically
   faster parallel execution.
3. Parent Working can say it is waiting for an Agent. The tree offers child
   navigation and lifecycle state, but the ordinary parent Tool card lacks the
   child's current work phase. A functioning long child consequently looks idle.
4. The sampled model context distinguishes real browser validation from syntax
   checks, but does not announce the known disabled public-egress policy. Missing
   browser dependencies plus failed installation lead to extra unrequested
   verification infrastructure. The final child answer correctly discloses the
   absence of actual browser interaction testing.

Relevant source: `supervisor-host/src/tools/worker-tool-runtime.ts`,
`sandbox-supervisor/src/remote-tool-sandbox-turn-runner.ts`,
`sandbox-supervisor/src/pi-run-activity.ts`,
`subagent-control/src/postgres-subagent-conversations.ts`, and the Web
`ToolActivity`/`ConversationTreeNavigator` components.

## Proposed implementation

### One explicit collaboration policy

Offer **Ultra in the existing thinking-effort picker** for explicitly supported
model/profile combinations. Preserve existing defaults; do not introduce a second
independent user-facing collaboration switch. Resolve one selected Agent profile
into provider effort and tool policy: Ultra sends `max` to the model and enables
delegation; other choices keep their existing provider effort. Do not send an
unverified raw `ultra` value to CLIProxyAPI or Pi's model adapter. Max support alone
does not establish official Codex Ultra availability for every model.

Persist desired selection with Session settings, and freeze the accepted selection
and resolved policy with the existing Run configuration. Queued work and crash
recovery use that snapshot. A later selection applies to the next new Run, not
native follow-up messages inside already accepted work.

Define one code-owned tool-exposure policy. Non-Ultra omits creation/delegation
tools from native Agent configuration and omits delegation instructions. Ultra
offers them. Cover both direct `subagent` and `workflow`/`runs.run` creation;
hiding one tool name must not leave another equivalent entry available.
Reuse existing Control Plane child-admission checks to enforce the frozen policy,
without adding a new per-Tool lease query or separate permission authority.

Keep native tool registrations needed to settle/recover already admitted work;
model visibility and executor lifetime are separate. This slice can use the
current registry/filtering boundary and does not require a dynamic plugin catalog.

**Recommended child default, pending owner agreement:** an Ultra parent may
delegate, while children complete their assigned work without further delegation
by default. Parent communication and supervisor answers remain available. This
does not silently reduce the selected provider's reasoning effort. It is an
explicit capability policy, not a new duration/concurrency quota. If nested
delegation is wanted, make that a deliberate policy decision instead of silently
inheriting unlimited proactive delegation.

### Bounded task scope and meaningful progress

Clarify child instructions around the assigned deliverable, necessary validation
and prompt return of findings/results. Additional delegation or construction of
new validation infrastructure should follow a task requirement. Missing browser
tools must be reported accurately, without treating drawing stubs as browser tests.

Show a pending child task's description, lifecycle/current phase and a link to its
conversation in the parent Tool card. Reuse existing child relationships and
disposable HTTP/SSE observations; do not copy progress into native context, add
durable heartbeat samples, or poll PG for each display update. Keep diagnostic
transport ages collapsed, as agreed in the preceding UI change.

Expose known environment capabilities, beginning with disabled public egress, via
the existing context/World State boundary. Do not include proxy URLs or credentials.
Browser availability remains a real environment fact, not an assumed capability.
A maintained browser-capable guest profile can be a later independent slice;
this investigation does not enable the proxy or install packages in the user's VM.

### Acceptance and release

- Non-Ultra model requests lack every child-creation entry, including
  indirect workflow creation. Ordinary file/command/preview tools still work.
- Ultra resolves to provider `max` and the delegation policy; Max resolves to
  provider `max` without automatic delegation. Reject unsupported profile/model
  combinations. Conversation changes cannot leak a previous Run's offered tools.
- Exercise the chosen child default, parent questions, Stop, lost admission/reply
  and Worker recovery with the same accepted Run policy and native identities.
- Queue acceptance, mode edits and resume use the original snapshot, rather than
  mutable Session defaults. Check existing admission-query counts.
- Browser verifies the single effort picker, next-Run semantics, meaningful waiting status,
  child navigation, completion and interrupted/reconnected observations.
- Keep routine Luna checks for ordinary regression. Real Ultra acceptance uses
  an explicitly supported model/profile and verifies the effective request effort
  and child policy; record outcomes rather than promising automatic speedup.
- Record an ADR before changing persistence/public/internal contracts, then use
  the required matched release and owned-fixture cleanup. No total Run duration
  ceiling, new scheduler, Tool-result ledger or mailbox replay is proposed.

## Codex comparison

The official [Models documentation](https://learn.chatgpt.com/docs/models?surface=cli)
places Max and Ultra under `/model`'s reasoning selection. The
[Subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
distinguishes proactive Ultra delegation from explicit requests at other levels.
The clean relevant files in the local Codex checkout (`40e5de94e9`) confirm:

- `codex-rs/core/src/client.rs:175`, `reasoning_effort_for_request`: Ultra maps to
  Max before inference requests.
- `codex-rs/core/src/session/multi_agents.rs:39`, `effective_multi_agent_mode`:
  with Multi-agent V2 enabled and no custom hint policy, Ultra selects Proactive;
  other efforts select ExplicitRequestOnly.
- `codex-rs/tui/src/chatwidget/model_popups.rs:569` presents Max/Ultra effort choices.

This is source evidence for the stated implementation, not a claim about private
desktop internals. Non-Ultra Codex can still support explicitly requested subagents.
PiCloud's requested hiding of creation tools outside Ultra is a stricter product
policy. Child delegation inheritance remains a separate proposal to agree.

Private investigation evidence is under
`deploy/production/runtime/review-evidence/subagent-bicycle-20261021/`.
Session identities, transcripts, generated project contents and credentials are
not included in this report. No runtime implementation or rollout was performed.
