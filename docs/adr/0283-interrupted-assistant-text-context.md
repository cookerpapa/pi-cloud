# ADR-0283: Preserve cancelled assistant text in model context

Status: deployed as `interrupted-text-jose-20261028`, schema 202 / Helm 119,
2026-10-28. Source, fault, four real GPT/Flash continuation cases, full Cube,
native Worker recovery and large-image cold recall checks pass.

The owner approved the native ContextEdit approach, including its one extra text
copy per cancelled response. A reference-only custom context resolver was discussed
and rejected in favor of native recovery/compaction behavior.

## Intended behavior

After stopping a response, a user can refer to the words already produced and
correct them. The next model request includes that text at its original position,
as assistant text with a short interruption marker. Preserve wording and speaker;
do not summarize it or wrap it in a third-person account of what the assistant said.
The native source Entry and cloud Run retain their true aborted/cancelled outcomes.

This first slice handles a generation that has actually settled as cancelled.
Do not indiscriminately restore all Entries with `stopReason: aborted`: native
recovery and retries also create aborted Entries. For a cancelled GenerationTask,
consider its last persisted assistant Entry, not every earlier failed-attempt draft.
When ownership recovery preserved the latest visible partial but the next request
produced no newer Entry before cancellation, that latest recorded text is eligible.
Confirm this selection with the pinned Harness before integration. No visible
text means no replacement. Commentary and final-answer text are both eligible.
Use a neutral marker such as `[Reply interrupted]` unless user cancellation is
proved; an inferred cause must not become a statement of user intent.

The slice changes context retention, not the Stop/Tool cancellation policy or
the execution lifecycle of a Run. Empty-input continuation remains a separate
product decision.

## Existing authority and chosen native mechanism

ADR-0244 already retains completed/interrupted Assistant Entries in PG, while
ordinary live bodies use Kafka. The missing behavior is context inclusion:
pinned Pi Durable 1.0.0 excludes aborted/error Assistant messages during context
derivation, and pi-ai also filters those messages before provider serialization.

Use Pi's public `ContextEdit` representation through an ordinary
`Conversation.commit()`. Append a code-owned context-only Entry containing an
`edits: [{target: sourceEntryId, action: "replace", messages: [...]}]` contribution.
It must have no new display message or generation/Tool task. The original Entry
remains immutable and aborted. Pi's context derivation substitutes the model-facing
text at that Entry's original position, rather than appending it after the user's
correction. The same derived context drives model requests, token estimation and
native compaction.

The replacement is a new, plain-text model representation. A serializer's normal
message-completion field must never change the original provider receipt, Task,
Run status or usage record. Preserve safe commentary/final-answer phase information
while removing provider response/item identities, signatures and opaque replay
state. Do not replay thinking, unfinished Tool arguments or hosted-tool carriers
as part of this replacement. Completed earlier messages and their valid Tool/
reasoning history keep their existing native handling.

The current writer publishes this Entry through the ordinary Session Kafka path;
Projector materializes it using existing native storage. The proposal adds no
service, PG table, active writer, side queue or per-fragment PG body write. It does
add one context Entry per eligible interruption and stores its cleaned text once
more. This bounded duplication buys native compaction/recovery semantics instead
of a second request-time history builder. No bulk rewriting of old history.

## Admission, ordering and recovery

Implement one Worker-owned policy helper, shared by root and child Conversations.
Its normal admission point is after native abort settlement, while the existing
writer still has authority, before terminal cloud settlement and writer closure.
Check ownership as existing native mutations do; the cancelled user-request signal
must not be confused with revocation of the writer's right to finish settlement.

Identify work by physical Session, Conversation and source Entry, and verify the
source Task/attempt rather than matching text. On the native transaction line,
recognize the already-published context edit and append nothing on a duplicate
invocation. A replacement must never overwrite another applicable native context
edit or cross a Conversation boundary.

If the Worker dies after the aborted source Entry but before this context Entry,
the next authorized owner reconciles missing eligible edits before enabling new
generation or compaction for that Conversation. Inspect only the latest native
compaction and active suffix, using existing task/storage reads; do not scan the
lifetime log or read PG again on every model request. Do not resurrect text already
outside the active context. An uncertain append retains the existing ordered
writer-closure recovery, never an automatic producer retry.

Native startup/rebind, input admission and manual compaction must all honor this
preparation boundary. There is no best-effort repair after a model request or
compaction has already captured its context cutoff. Ordinary current-only state,
Tool dispatch and existing human Inbox ownership are unchanged.

## Provider contract gate

First prove the exact assistant-text representation with the installed GPT-6 Luna
and DeepSeek Flash routes, including thinking enabled and Tools advertised. Plain
text support alone is not evidence that a malformed replayed assistant response
will be accepted. DeepSeek documents additional reasoning-field requirements for
thinking/tool histories. Do not invent reasoning or claim an untested combination
works. Valid provider-specific serialization belongs in the existing Models adapter.
Do not silently switch the agreed assistant text to a user/system quotation scheme.

Capture the outgoing request and confirm the interrupted text precedes the actual
new user message, keeps its assistant attribution, occurs once and contains no
partial Tool/reasoning structures. Confirm the model can identify the exact claim
being corrected. Verify both a warm request and a fresh provider connection;
connection-scoped continuation cannot be the only source of retained context.

The October 28 preflight passes the installed GPT-6 Luna and DeepSeek Flash
Responses routes with thinking enabled, Tools advertised and a preceding completed
Tool call/result. Both recall a unique identifier supplied only in the interrupted
assistant representation and follow the subsequent correction. The initial Flash
probe used a forced Tool choice unsupported in thinking mode; changing only that
probe to `auto` passes. The original failed sample is retained separately.

## Implementation and acceptance

1. A small pinned-Harness contract probe validates ContextEdit substitution,
   raw aborted history, token/usage accounting and native compaction selection.
   Validate actual provider encoding before completing runtime integration.
2. Add the Worker policy helper, authorized Stop settlement and bounded cold
   preparation. Keep this logic out of Projector, Gateway and browser rendering.
3. Cover text-only and mixed text/Tool drafts; reasoning-only cancellation;
   multiple text phases; completed-response/Stop races; repeated cancellation;
   retries before cancellation; and a reply that completes normally.
4. Force failure before/after the context-edit commit, including lost ACK and
   owner replacement. A cold owner produces one representation at the right
   position and does not replay an unsafe Tool. Verify root, child and fork
   context isolation, including a fork taken before the context edit existed.
5. Exercise normal continuation, Worker replacement, manual/automatic compaction
   and GPT/DeepSeek switching. Once summarized, the old partial must not also be
   reinserted. Existing Tool results, queue editing/Stop return and `/usage` stay
   correct; the browser does not gain a second assistant bubble.
6. Update current architecture/acceptance docs after implementation, run the
   relevant native/storage/model checks and maintained matched release gates,
   then deploy with writer draining and original conversation/image/Workspace
   preservation. A Worker semantic change is not a Web-only release.

## Evidence and alternatives

Pinned Pi exports context-only edits in
[types](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/types.ts),
applies them before filtering in
[context](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/context.ts),
and uses the same contributions in
[compaction](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/compaction.ts).
Prefer these public mechanisms over a Pi-core patch, altered committed Storage
batches, browser-fed transcript repair, or a request-only injection that native
compaction would miss.

[OpenAI conversation-state guidance](https://developers.openai.com/api/docs/guides/conversation-state)
and [DeepSeek Responses input](https://api-docs.deepseek.com/api/create-response/)
support manual text context; [DeepSeek thinking/tool requirements](https://api-docs.deepseek.com/guides/thinking_mode/)
remain part of the actual provider gate.

The October 28 isolated experiment ran real Codex 0.164.0 and latest-published
0.165.0 against a deterministic Responses SSE provider. In both, uncompleted
assistant deltas appeared on the client stream but not in persisted history or
the next request, with and without process replacement. Completed output-item
controls survived both. Latest inspected source was `c0e88f3c04219aaa032aaf4b20a8c3284cc81449`.
This is an observed behavior, not a rationale to discard user-visible text or a
claim about every desktop/provider path. Private reproducible evidence is under
`deploy/production/runtime/release-evidence/codex-interrupt-20261028/`.
