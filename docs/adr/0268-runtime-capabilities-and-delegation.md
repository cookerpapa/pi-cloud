# ADR-0268: Runtime capabilities, delegation profiles and child observations

Status: implemented and deployed in `runtime-capabilities-5d39828d`, schema 197.
Date: 2026-10-21.

## Context and decision

The owner approved the [consolidated proposal](../reports/subagent-wait-review-20261021.md).
The observed child completed and delivered its result; missing parent visibility,
unconditional delegation instructions and disabled guest egress made useful work
look stalled. Tool changes must be visible within an existing Agent loop at the
next prepared model request. Cache preservation is not a requirement.

1. Send credential-free runtime capability snapshots over the existing Worker
   management WebSocket on registration, change and reconnect. The initial
   capability is the PG-owned guest public-egress setting: enabled, disabled or
   unknown, with its configuration revision. It describes policy, not proof of
   working internet connectivity. Keep proxy origins and credentials out of it.
   Reuse reads already performed by the existing egress configuration endpoint to
   observe cross-process changes; ordinary model/Tool calls add no PG reads.
2. Use pinned Pi's public prompt sections to render current environment policy
   before model preparation. Pi stores changed sections through the existing
   Session writer; unchanged settings create no repeated section history. Do not
   broaden the accepted Run's file/shell grants or overload CloudStepContext with
   another complete Agent tool registry.
3. Add Ultra to the existing effort selector only for validated catalog profiles.
   Resolve Ultra to provider Max plus proactive delegation; retain the selected
   profile in the accepted Run snapshot. Other efforts retain delegation tools
   with explicit-request-only instructions. Children and recovery inherit the
   accepted profile. Pi owns instruction rendering and request preparation.
   Migration 197 expands the existing Session/Run/model-profile constraints;
   the native cloud-run document retains the selected effort for section rendering.
   The native Agent stores the resolved inference effort. A catalog may offer
   Ultra only alongside Max; default model/effort selections remain unchanged.
   New real-model admission uses the current catalog's defaults and supported
   efforts, as required by ADR-0267. Persisted credential-profile capability
   copies must not block a newly offered Ultra profile on an existing account.
   Credential identity/status and explicit Session selections remain PG-owned;
   accepted Runs continue using their frozen snapshot after catalog withdrawal.
4. Show compact child task/phase/navigation in the parent's Tool card. Reuse native
   parent Tool/child Session relationships and disposable HTTP/SSE observations.
   Details start collapsed; updates never force scrolling or expansion. Native
   outcomes outrank late observations. No copied child transcript, polling per
   progress update, new progress table or model-generated summary is introduced.
   Worker derives the parent from its existing native family; Projector checks
   both current scopes before routing `run.child_activity` to the parent's SSE.
   Reuse the existing child summary with parent Tool/child Turn identities. The
   browser coalesces discovery/lifecycle/reconnect reads, not phase-by-phase reads.
   A human Conversation's focused tree includes child relationship summaries,
   while its native entry reads remain limited to the focused human lineage.
   Child progress must not depend on opening the full history tree or on sidebar
   pagination; discovering a child must not load that child's transcript.

The ordinary Tool catalog protocol is recorded separately before its vertical
slice. All work retains PG authority, one physical Session writer, Kafka dispatch
ordering, independently admitted effects, boot-scoped replies and native abort/
recovery settlement. The first protocol update is a matched deployment.

## Reuse evidence

Pinned `@earendil-works/pi-durable` 1.0.0 exposes `section`, Registry snapshots,
install/uninstall and Conversation `configure()`. Its `GenerationTask.prepare`
renders sections/tools and freezes the request; its README's System Prompt and
Per-Conversation Agent contracts cover these operations. Reuse these APIs rather
than adding another prompt/history manager or patching the Harness. Existing
PiCloud management WebSockets already reconnect and preserve authorized Workers;
existing activity HTTP/SSE already carries typed phases. Another broker, MCP
server, workflow engine or event store would duplicate these bounded roles.

## Acceptance

- Configuration changes and reconnect refresh Worker policy; disabled, enabled
  and unknown are distinguishable without exposing private proxy data.
- The same native Conversation sees changed policy on its next model request;
  unchanged sections do not accumulate. No guest activation is needed for chat.
- Max/Ultra request effort, delegation instructions, frozen Run settings, child
  inheritance and recovery are verified; Stop retains existing settlement.
- Parent cards correlate simultaneous children, preserve disclosure state and
  refresh after reconnect; stale phases never become invented task failures.
- Real guest dependency access and the intended final global setting are checked.
  Tests restore their temporary changes to the approved enabled setting.
- Run applicable source and matched-release gates and preserve accounts,
  credentials, unrelated configuration and confirmed physical cleanup.
