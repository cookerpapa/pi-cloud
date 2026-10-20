# ADR-0264: Recoverable delegation and scoped child discovery

Status: accepted by the owner on 2026-10-20; deployed in
`resource-repair-1cdccb80`, 2026-10-21. Public-API, PG/RF3 and actual shared/
ephemeral Worker-replacement acceptance pass; see the
[delivery record](../reports/resource-interaction-repair-20261020.md).
Context: [resource repair plan](../reports/resource-interaction-repair-plan-20261020.md),
[SAR-D1 review](../reports/subagent-lifecycle-review-20261020.md).
This decision refines ADR-0229/0247 for explicitly replay-safe direct delegation.
Other unsafe Tool policies and boot-scoped reply transport are preserved.

## Problem

PiCloud persists child creation identity and native progress, but the combined
remote `subagent` Tool is registered unsafe. If its caller's canonical result
has not committed when the Worker dies, native recovery ends that invocation
as interrupted. The model lacks a target-free child list and may issue a new
delegation. Existing same-operation idempotency does not deduplicate different
model calls and must not infer identity from similar prompt text.

Cross-boot reply replay alone misses a response never published. The old
boot mailbox also spans multiple Sessions, and its delivery position is not
a native result-application checkpoint. Making it a recovery source would
require additional retention, routing and terminal-deduplication contracts.

## Native evidence and adopt-before-build choice

Use the already pinned Pi Durable 1.0.0 public APIs:

- The [official foreground example](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/test/examples/22-subagent-foreground.ts)
  uses a replay-safe Tool, source Task identity, transactional child lookup/
  creation and stable Submission identity.
- The [official background example](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/test/examples/23-subagent-background.ts)
  demonstrates a durable child directory and model-visible status without a
  target. Its combined management Tool stays unsafe; its background lifetime
  is a different product contract.

Adopt the first pattern's identity/continuation and the second's discoverability.
Retain PiCloud's generation-owned foreground children, which permit returning
supervisor blocking and later parent replies. Do not introduce independent
background Agents, another scheduler or a second authoritative child registry.
These are SDK example extensions, not claims about default CLI-installed tools.

## Decision

1. A direct delegation has one durable logical identity tied to the original
   physical Session/native Tool task and its existing creation receipt.
   A fresh Worker delivery must not mint a new logical child.
2. Pi resumes eligible nonterminal direct delegations using native safe replay.
   The adapter reconstructs its wait through public Tool/Storage APIs, since
   the recovery execution phase does not repeat normal `beforeTool` preparation.
3. Resume only after ordered old-writer closure, a new PG grant and restored
   family bindings. Preserve original intent/configuration and Submission.
   Newly published delivery references use current authority and mailbox.
4. Control effects stay at the Projector-side handler. A current recovery
   reference resolves the original source record and operation; repeated
   creation/admission uses the same identity. Logical operation identity and
   delivery identity are distinct even if the initial delivery used one UUID
   for both. Use existing native commit metadata/reference mechanisms; do not
   rewrite an old scope or add a PG operation/result ledger.
5. Resolve running/completed/blocked/failed/cancelled children from existing
   native state. Completed replies refer to the original Submission/outcome,
   not an arbitrary later assistant entry. Replies use the current boot Topic.
   Pi remains the sole canonical Tool Result settlement authority.
6. Native cancellation/terminal state wins. Do not resurrect an ended caller,
   use a late reply to overwrite it, or reauthorize effects through an old
   Projector reference. A safe delegation does not make its child's unsafe
   shell or script replay-safe.
7. Add a bounded read-only list under the existing family scope, with IDs and
   source relationships available without a prior reply. Query completed children
   as well as active children for recovery. This is an ordinary trusted business
   Tool, not access to arbitrary control-plane APIs or credentials.

## Public Tool and ownership boundaries

The pinned SDK sets replay policy per Tool registration, not per action.
Proposed matched catalog:

| Tool | Purpose | Policy |
| --- | --- | --- |
| `subagent` | Foreground task delegation; existing context/compute/cwd/tool options | Safe after prototype proof |
| `subagent_control` | List/status/wait/send/cancel | Unsafe |
| `workflow` | Existing arbitrary Cube script and `runs.*` host calls | Unsafe |

Remove the old combined action schema at cutover. Do not retain aliases solely
for old development records. Existing supervisor tools and native generation
ownership remain; do not copy the example's ownership index literally where
PiCloud's blocking/reply semantics require the current relationship.

One physical Session still has one renewable lease, one writer and one root
cloud Run for its native family. No child lease/RunAttempt is added. The
boot-scoped mailbox continues serving current callbacks; its existing same-boot
reconnect cursor is not repurposed as a cross-Worker durability claim.
No overall Agent/child deadline is introduced. Preserve any operation-specific
deadline and never infer it from a new consumer start time.

## Alternatives

- **Only add list/status:** useful for explicit inspection and interrupted
  unsafe management, but leaves normal direct delegation recovery to another
  model decision. Include discovery, while also proving safe direct continuation.
- **Replay every old mailbox result:** possible under a separately designed
  result-consumption contract, but does not close effect-before-publication
  failures and is unnecessary for outcomes already represented by native state.
- **Mark the current whole Tool safe:** rejected. Its Stop/send/workflow actions
  have different retry semantics; arbitrary script re-execution is not implied.
- **Name or prompt deduplication for every new launch:** not adopted. Stable
  invocation identity handles recovery; distinct intended work stays distinct.
  A later named-Agent product would need its own explicit identity/lifetime policy.
- **Put subagent orchestration back in Worker or patch Pi core:** not required
  by this design. Prototype the public adapter/handler boundary first.

## Required proof before adoption

The native prototype in `packages/sandbox-supervisor/test/native-session-work.test.ts`
passes five cases: interruption after creation, configuration, input admission
and child completion, plus Stop on restoration. The actual pinned Harness and
existing generation-owned creation adapter preserve one child, one original
Submission and one source Tool identity. Unsafe child execution occurs once;
a later child answer does not replace the original answer. Normal Tool
preparation runs once while safe execution resumes. Four existing native-family
contracts also pass, as does the package typecheck.

This is an in-process native API proof with journal restoration and Faux models.
It does not establish the distributed recovery-reference, PG authority or Kafka
delivery contract; those gates below remain required.

Native contract tests must cover same-task rerun, child creation/input ACK loss,
exact-result selection, generation ownership and supervisor blocking/reply.
PG/RF3 tests must cover both Projector-only and Worker replacement, the fresh
ordered recovery reference, old-owner rejection, duplicate delivery and
cancellation before/after reply publication and canonical settlement.
Assert one original child/Submission and one canonical result; distinct new
calls remain distinct. A child with interrupted unsafe work must not repeat it.
List queries must obey family scope and bounded pagination without truncating
structured results into invalid output.

Only after that proof should the matched Tool/dispatch contract be implemented
and released. This accepted ADR does not relabel the current runtime safe,
change old committed native checkpoints, or authorize a blanket replay mode.

## Recovery-reference representation

Keep the original control operation ID as the logical child identity. Each
resumed delivery receives a fresh operation ID and callback; its ordered native
commit carries a task-scoped `pi-cloud.tool-recovery` document containing only
the original intent position and operation identity. Dispatch metadata binds
that document to the original Tool task and current owner/mailbox.

The original arguments remain in the original execute checkpoint. Recovery
does not copy them into another document or rewrite an old scope. The Worker
checks the restored invocation against that committed intent. After projection,
the control dispatcher reads that intent under current authority and uses the
original operation ID for child admission. Its reply correlates with the fresh
delivery ID. The recovery document is retired with its native Tool.

Validate control references at the Kafka envelope boundary; expand their input
only at the PG-backed control handler boundary. Cube handoff keeps its existing
same-commit argument expansion and dispatch-offset contract. Superseded recovery
references cannot authorize effects through the current lease, and a native
terminal/aborted task cannot acquire a new wait.

Supervisor requests must identify the native calling Task and its original
Session writer. Checking only that the child is still running is insufficient:
an unsafe contact can end during recovery while the child continues. Pending
queries and new replies therefore require that exact Task and writer to remain
active. These immutable references add no renewable lease or execution state.
Keep identical committed reply receipts readable. The matched development
migration discards old supervisor request rows only after writer quiescence;
it does not retain a nullable legacy interpretation.
