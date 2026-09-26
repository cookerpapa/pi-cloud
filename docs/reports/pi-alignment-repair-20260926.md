# Pi-alignment repairs — 2026-09-26

Baseline: `ad1aad5fba4aba2f61320283f374fc6ccf6688f5`.
The owner authorized the review repairs, required historical-design checks and
removal of wrong paths instead of compatibility branches, and deferred images.
The implementation accompanies this report; local rollout acceptance is recorded
separately below as it completes.

## Decisions and scope

The July–September development conversation was rechecked, especially the
September 22 choice of whole guest Tools, opaque operation IDs and UNKNOWN over
effect replay. Current ADR-0148/0166/0171/0183 constrain the repair. The new
decisions are ADR-0185 through ADR-0189; Pi stays pinned at 0.84.1.

| Review item | Disposition |
| --- | --- |
| PI-01 native Records | Fixed Step attempt reset and original Tool ordinal; validated against pinned Pi's reducer |
| PI-02 invocation scope | Native result Entry IDs identify cloud invocations; provider IDs and remote operation UUIDs retained |
| PI-03 images / native payload size | Explicitly deferred; no resizing, attachment store or log-size contract change |
| PI-04 guest cwd / symlinks | Guest paths use native Node semantics inside KVM; host Volume containment unchanged |
| PI-05 hooks | Code-owned before/after Tool hooks reach the actual CloudAgentRuntime Agent |
| PI-06 AGENTS discovery | Reclassified as a proposed feature, not an existing behavioral promise; not enabled implicitly |
| PI-07 Tool execution policy | Native parallel eligible batches; fixed write/edit/bash keep sequential policy |
| PI-08 sampling preparation | Removed the duplicate zero-file-Tool branch; one SamplingContext implementation |
| PI-09 model retry | Removed Gateway retry loop; deployment root CPA extra rounds set to zero; account selection remains CPA-owned |
| PI-10 presentation | Cold Compaction reason comes from native Step; size estimate from the same native summary/tail; Tool identity consistent |
| PI-11 discovery | Tenant-scoped, microsecond-preserving list cursor and browser load-more |
| PI-12 GitLab lock | Retained deliberate low-frequency job serialization; no new sync lease/version subsystem without a measured need |
| PI-13 template identity | Guest COPY/build-input digest separated from platform Git labels, preserving READY/digest/protocol checks |
| PI-14 note lookup | Reads subsequent GitLab note pages; incomplete lookup cannot be treated as absence |

PI-06 and PI-12 should not have been treated as automatic implementation orders
from a review list. Loading project text needs its own resource/trust/activation
contract. The GitLab row lock intentionally prevents competing metadata writers;
removing it safely would add coordination state to an optional low-volume path.
The concrete first-page lookup error is fixed independently.

## Data and failure behavior

The Runner allocates the result Entry identity once for each response/call and
uses it for preparation, start/completion presentation and Subagent work keys.
Native Pi messages keep the provider Tool ID. `operationId` still correlates the
ordinary Kafka Tool reply; it was not replaced or confused with Run authority.
The native result Entry identity needs no additional PG write or lease.

Before hooks run through Pi before validated execution intent. Only an admitted
intent can enter the Tool implementation. After-hook results are the values
persisted in native context. Argument rejection still has a result but no effect
intent. New Step attempts restart at one, actual retries increment, and a skipped
Tool does not renumber later calls. One Session writer remains ordered while
eligible Tools execute concurrently; child/Tool waits reserve no model permit.

Guest file operations now follow the guest filesystem instead of treating cwd
as a second isolation root. File size bounds, native edit matching, conflict
detection and file/parent synchronization remain. Shared-file concurrency is
ordinary Linux behavior, not transactional compare-and-swap or exactly-once IO.
User/project code never moves into the trusted Worker.

Model Gateway now performs one upstream send for each admitted logical request.
The Runner owns sampling retry and Pi owns summary retry. CLIProxyAPI still
selects credentials; a logical request is not a promise of one account attempt.
No retry branch repeats Tools or workflows.

Conversation cursors preserve PostgreSQL microseconds, including a page boundary
inside one millisecond. They are query positions, not credentials or stream
cursors. A newer refresh invalidates an old browser page response. GitLab note
lookup has one overall 30-second deadline and at most 100 pages; exhausting it
fails instead of creating another note based on an incomplete search.

The new execution-log topic is v11. Cutover requires quiescent v10 publishers
and projected seals; there is no old-ID decoder. Guest template identity is
computed from explicit build inputs, while app image labels retain Git revision.
The actual built image digest and guest compatibility checks still apply.

## Local verification

- Existing and added deterministic tests: **1,098 passed, 107 opt-in skipped,
  zero failed**. This includes the real Pi loop and PGlite-backed control/storage
  paths; skips are not live passes.
- Workspace typechecks passed except an initial NodeExecutionEnv call-signature
  mismatch in the changed guest adapter. That mismatch was corrected and the
  Tool Sandbox typecheck rerun successfully before the full test pass.
- Focused native Record/hooks/invocation suite: 146 passed at its slice boundary;
  guest filesystem suite: 29 passed; subsequent Runner suite: 120 passed.
- Native contract tests cover `[1,1,2,1]` sampling attempts, rejected earlier Tool
  ordinals, hook rejection/result replacement, reused provider IDs, parallel
  eligible batches and sequential mutation batches.
- The pagination test creates 103 owned Sessions with distinct microseconds in
  one millisecond and checks complete disjoint pages, tenant isolation and bad
  cursors. API client coverage verifies the cursor request.
- Guest tests use actual temporary filesystem objects, including sibling paths,
  existing links, edit/write through links and creation through a dangling link.
  Existing host/management containment tests still pass.
- Template identity and private configuration tests cover unrelated UI/docs,
  source/mode/link changes, explicit COPY parsing, repeatable private config
  updates and preserved credentials/settings.
- The maintained [fault gate](pi-alignment-faults-20260926.md) passed **38/38**
  cases using a separate disposable PostgreSQL container for opt-in database
  cases. It ran before the implementation commit (`dirtyWorktree: true` in its
  [machine-readable evidence](pi-alignment-faults-20260926.json)); it is not a
  claim that unmodified baseline code passed the new contracts. The container
  and its temporary database were removed after the gate.
- Documentation, runtime-timeout/retention, installer and image-closure checks
  passed. The image check covers 9 Dockerfiles and 185 COPY sources; it is not a
  claim that every image was rebuilt at that point.

The original review's temporary "assert the bug exists" script was removed after
promoting its cases into maintained regression tests. Its numeric JSON remains
baseline evidence, not a current test result or a user transcript.

## Rollout and live acceptance

Before rollout, the existing development database reported **0 active/queued Runs,
0 admitted unsealed Runs, 0 current Session leases and 0 unpublished terminal
Outbox rows**. No existing resource was deleted to obtain this state.

Local build, Helm/preflight, installer and static gates passed. Final boundary
tests additionally cover ambiguous within-response Tool IDs and split native-reply
versus cloud-progress identities. Real Luna/Cube acceptance is still being
completed. No new claim of physical multi-node capacity, HA or physical effect
fencing follows from this repair.
