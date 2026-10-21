# Subagent wait investigation and Ultra collaboration proposal

Date: 2026-10-21. Source baseline: `d46c0543`; serving application base
`component-release-ad5fc83c`, schema 196. This is investigation and a proposal,
not an implemented runtime change. The owner authorized stopping the affected
Run and requested a consolidated proposal after comparing Codex's single effort
picker, prompt-based delegation policy and Pi's native instruction interfaces.
The plan below keeps tool availability separate from permission to delegate
proactively; it does not add a separate collaboration selector or hide otherwise
available tools merely because a non-Ultra effort was selected.
The owner's later clarification prioritizes a simple, provider-independent tool
catalog over prompt-cache reuse. The proposed model requests use the full effective
tool list; cache-preserving additions, tool search and a separate callable subset
are not delivery requirements. Parent progress stays compact and collapsed.

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

1. Current delegation instructions do not distinguish explicit-request-only
   behavior from proactive behavior by effort. Worker offering uses tool
   applicability and optional depth, while the runtime prompt permits delegation.
   Children inherit the root's model/effort and can delegate again.
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

## Consolidated proposal

### 1. One effort picker and one profile resolver

Offer **Ultra in the existing thinking-effort picker** for validated model/profile
combinations, retaining existing defaults. Resolve the selected Agent profile in
one place:

| Selected effort | Provider/Pi model effort | Delegation instruction |
| --- | --- | --- |
| Existing non-Ultra choice | Existing supported value | Explicit request only |
| Ultra | `max` | Proactive when it materially helps the task |

Available tools remain available in both cases, subject to existing actual tool
grants, role applicability and installed execution capabilities. Selecting a
non-Ultra effort does not cause the backend to reject an explicitly requested
delegation. Avoid keyword parsing to decide whether a user has authorized one.
The instruction controls model behavior; it is not a hard execution prohibition.
Apply it consistently to direct `subagent` and `workflow`/`runs.run` delegation.

Keep the user's selected profile distinct from the provider effort: both Max and
Ultra send `max`, so recovery and children must not infer the delegation policy
from that wire value alone. Use Session desired settings and the existing Run
configuration snapshot. Queued work and recovery keep their accepted profile;
later selections apply to the next new Run. Follow-up/steer still belong to the
current Run and do not silently change its model policy.

Ultra is a PiCloud runtime profile built from supported inference and local
delegation. Its availability must be declared and validated in the existing
catalog, not inferred from an unverified provider `ultra` parameter or from
Codex's product availability alone. Keep native model adapters on supported values.

### 2. Native Pi instruction sections and task scope

Use Pi Durable 1.0's public instruction/section mechanism. Keep a single named
delegation-policy section in the trusted Runner, selected from the accepted
profile. Pi creates the positional `system` entries and the provider adapter
translates them. Replace the current unconditional delegation encouragement;
do not leave contradictory rules in different prompt fragments. Stable sections
produce no repeated instruction bodies when unchanged.

- Non-Ultra: delegate only when the user, or instructions already explicitly
  adopted for the task, request Agent delegation/parallel Agent work.
- Ultra: allow proactive delegation when concrete independent work benefits from
  it; describe the scope, deliverable and completion conditions.

Preserve the existing parent/child model and effective-policy inheritance.
Do not silently downgrade children or add a root-only creation restriction.
Further delegation must follow the same effective instruction and task scope.
This does not introduce automatic loading of project extensions or skills.

Clarify completion: do the assigned work and necessary validation, return useful
results promptly, and disclose unavailable checks. Building a replacement test
framework or adding another review stage should have a concrete task benefit.
The observed reviewer found candidate issues; its existence alone does not prove
that nesting is a defect. Keep the current direct `subagent` wait/result contract
and native recovery behavior; asynchronous spawn/explicit wait would be a separate
Tool-contract change, not an incident fix.

### 3. Restore this deployment's intended network access and explain capabilities

The setting is global to Cube egress, not a child-only policy. The investigation
observed it disabled at revision 6 since October 7. As an implementation step,
check the configured upstream proxy and enable this development installation's
public egress through the maintained administration path. Use small read-only
npm/PyPI requests in an owned Sandbox to validate the actual guest route. Model
gateway connectivity is a separate path and is not evidence of guest access.
Keep the administrator's global switch and preserve unrelated credentials/settings.

Make known public-egress state and relevant validation capabilities available
through the existing context/World State boundary. Reuse configuration revisions
and bounded cached delivery to Worker; no per-Tool PG read is needed. Distinguish
known disabled state from unknown connectivity. Exclude proxy endpoints and
credentials from model context. Failed package installation should not cause
repeated equivalent attempts without new evidence.

Capture the approved target setting before acceptance tests; restore temporary
test changes to that value and verify it afterward. Do not restore the old
disabled setting after intentionally enabling the environment.
Browser availability must remain a real environment fact. A maintained browser
guest profile can follow as its own measured image/capability slice; the first
repair exposes current limitations rather than claiming browser checks happened.

### 4. Parent-visible child progress

Show each pending child task's description, lifecycle/current phase and an action
to open its conversation in the parent Tool card. Reuse the existing parent Tool
identity and child relationship so concurrent children cannot overwrite each
other. Useful states include generating code, running a Tool, waiting for a
reviewer/parent decision, completed and interrupted.
Keep the default display to one compact summary line and a View action. Details
remain collapsed unless the user opens them; progress updates never expand the
card or force scrolling. Do not mirror the child's streaming transcript into the
parent. Multiple child summaries retain their own identities and user expansion
state.

Reuse disposable HTTP/SSE observations and existing child views. Coalesce updates
in memory; no per-update PG polling, copied progress in native context or new
heartbeat table. A stale observation becomes unconfirmed rather than an invented
failure. Reconnect restores relationships and refreshes observations, while the
native terminal state wins over late progress. Transport diagnostic ages stay
collapsed as in the preceding UI change.

### 5. Execution-owned tool catalog, as a separate vertical slice

Complete the earlier tool-decoupling discussion after the behavior/visibility
repairs. The acceptance target is that a compatible ordinary tool becomes visible
or disappears on a subsequent model request without rebuilding Worker. Cache-hit
rates are not an acceptance target. GPT and DeepSeek use the same full effective
tool-list policy through their existing native adapters.

Current source is not yet dynamic: `fixedRemoteToolDefinitions()` and
`infrastructureToolDefinitions()` supply definitions to Worker startup;
`DurableRemoteTools` captures a fixed name set, and `DurableAgentSession` tracks
installed names. Adding only a Projector handler consequently does not change
what the model sees. The first catalog slice must update these PiCloud adapters,
not just add a catalog endpoint. The pinned native Registry already supports
install/uninstall and immutable snapshots; native `configure()` selects a
Conversation's tools. No Pi core patch is required for these primitives.

Control Plane exposes one versioned catalog of ready, code-owned tool definitions:
name, description, parameter schema, applicability and the existing execution/
recovery contract. Implementation owners supply declarative metadata. Projector
routes admitted commands and keeps the implementation's admission check; it does
not become a plugin manager or a second Agent scheduler. Do not serialize
executable callbacks into the catalog or execute Pi core in Control Plane.

Worker receives the catalog through its existing management/configuration channel,
including initial registration and reconnect. Deliver a complete snapshot on
change; no delta protocol, per-Tool fetch or per-model-request SQL. Worker keeps
one validated in-memory catalog and combines it with each Conversation's existing
grants and role applicability. A globally added tool does not silently broaden
accepted file/shell grants. Invalid updates retain the last valid catalog, and
reconnect reconciles with the currently served snapshot.

The active Session owner uses Pi's public registry/configuration APIs to apply
changed effective selections. Only that writer commits native configuration;
unchanged selections cause no new commits. Once an update is applied, the next
prepared model request sends the complete effective `tools[]`. An already
prepared request keeps its original list. No fabricated user message, new
control-history table or second writer is needed. Native positional system/tool
entries remain Pi's change record; full `tools[]` on the provider request does
not mean storing a new full tool-list history on every request.

For example, adding preview changes the next request from `[read, bash]` to
`[read, bash, preview]`; withdrawing bash changes it to `[read, preview]`. Let
ordinary provider caching operate without special tuning. This slice adds no
`tool_search`, `additional_tools`, `allowed_tools` or custom request-history
rewriting to preserve a prefix. Do not delete old native Tool calls or results
when a tool is withdrawn.

Add an implementation before advertising it. On withdrawal, stop new admission
and remove the tool from future offers; finish already accepted operations through
their existing lifetimes before deleting the implementation. A call generated
from an older model request but not yet accepted gets an explicit unavailable
Tool error through normal Pi settlement. Do not cancel accepted calls merely
because the catalog changed, silently reroute them or replay effects. Keep only
the definitions/adapters needed by existing admitted/recoverable work until it
settles. After owner restart, use native task identity and existing recovery
contracts, without inventing success or restoring withdrawn new-call admission.
Incompatible schema/recovery changes still require matched, drained upgrades;
there is no general multiversion plugin runtime or independent operation ledger.

Start with ordinary remote tools that fit the existing transport and grants.
Native lifecycle/child adapters, different guest protocols and new capability
types can still require Worker or guest changes. Provider-hosted search remains
the model adapter's concern, separate from Projector-executed tools. Record the
protocol/ownership ADR and native SDK build-versus-adopt evidence before this
slice. The goal is ordinary tool decoupling, not arbitrary executable plugins.

## Delivery order and acceptance

Implement one complete slice at a time: network/capability correction, effort and
native delegation instructions, parent-visible progress, then tool-catalog delivery.
The child-scope instruction changes belong with the delegation slice. Check:

1. **Profiles:** the actual non-Ultra request still offers applicable delegation
   tools but includes explicit-request-only instructions; Ultra sends `max` with
   proactive instructions. Unsupported combinations fail before model invocation.
2. **Behavior:** real simple work, an explicit non-Ultra delegation and a divisible
   Ultra task demonstrate the intended instructions. These samples are behavior
   evidence, not a guarantee that a prompt can hard-disable a callable tool.
3. **Persistence:** queued work, retry, child inheritance and Worker recovery keep
   the original selected profile and effective instructions. Max/Ultra must not
   collapse into indistinguishable recovery metadata. Unchanged sections stay stable.
4. **Lifetimes:** Stop, supervisor questions, lost admission/reply and native safe/
   unsafe recovery retain existing identity and settlement contracts. Do not add
   an overall Run deadline to mask lengthy but active work.
5. **Environment:** guest npm/PyPI access, disabled-state reporting, configuration
   restoration and absence of proxy credentials in context are demonstrated.
6. **Browser:** the single picker, next-Run semantics, simultaneous children,
   compact progress, opt-in details, navigation, terminal precedence and reconnect
   are checked. Updates never auto-expand or force scrolling.
7. **Catalog:** add an ordinary tool without rebuilding Worker, remove it from
   future requests, handle an in-flight call and a late unaccepted call, survive
   owner restart/reassignment, and reject an unavailable/version-incompatible
   target without replaying effects. Inspect full tool declarations on GPT and
   DeepSeek requests; do not require prefix-cache preservation. Check unchanged
   snapshots, retained grant boundaries, invalid updates and management reconnect.
   Warm lookup adds no SQL/fetch, and only changed effective selections commit.

Routine regression uses Luna. Validate any offered Ultra profile with provider
Max plus the local policy, recording actual selected/effective values; do not claim
that Codex exposes the same product profile for Luna. Keep real-model failure
samples and physically clean owned fixtures. Record ADRs before changing storage,
public/internal schemas or tool-catalog protocols, then run the applicable matched
release/acceptance. Existing PG ownership, one physical-Session writer, Kafka
dispatch ordering, Cube execution and canonical Worker Tool results remain.
Keep validation scoped to the delivered slice: the catalog comparison needs real
text/Tool calls on Luna and the enabled DeepSeek route, not a new large-image or
hosted-search campaign. The initial protocol cutover still follows the repository's
applicable required release gates. This revision changes the proposal only.

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
- `codex-rs/core/src/tools/spec_plan.rs:478`/`:985` gates registration through
  multi-agent availability, not an Ultra-only test.
- `codex-rs/core/src/context/multi_agent_mode_instructions.rs` renders the explicit/
  proactive policy as a developer message; its World State section emits changes.

This is source evidence for the stated implementation, not a claim about private
desktop internals. Non-Ultra Codex can still support explicitly requested subagents.
The consolidated proposal follows that distinction instead of hiding tools solely
by effort. Pi Durable 1.0 exposes `SystemMessage.sections`, Agent `instructions`
and extension prompt sections. Its public `configure()` and provider adapters
supply the equivalent application-instruction path without adding a native
`developer` role or patching Pi core. The installed package README's System Prompt
and Per-Conversation Agent sections define the request-boundary behavior.

Private investigation evidence is under
`deploy/production/runtime/review-evidence/subagent-bicycle-20261021/`.
Session identities, transcripts, generated project contents and credentials are
not included in this report. No runtime implementation or rollout was performed.
