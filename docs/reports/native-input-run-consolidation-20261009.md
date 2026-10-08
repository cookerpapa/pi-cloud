# Native human input and Run consolidation

Date: 2026-10-09. Source implementation of
[ADR-0238](../adr/0238-native-input-queue-and-run-record.md).
The serving release remains `pilot-ready-81392f7d`, schema 182.
No production schema, images, accounts, credentials or business data were changed.

## Result

- Schema 183 merges initial text/uploads, frozen model/credential configuration
  and pruning metadata into `runs`. It removes `turns`, its mirrored lifecycle,
  unused fields and duplicate timestamps. Incoming foreign keys retain their
  tenant and deletion constraints. `runs.worker_id` names its actual owner.
- Initial idle-session requests remain PG-admitted executions. Active-session
  messages become native Pi follow-up/steer inside that Run. Stable input IDs
  derive from tenant, Session and the browser's idempotency key. No holding Run,
  cloud input-body queue or Steer redelivery reconciler remains.
- Successful active intake requires native Storage acknowledgement through the
  existing RF3 Kafka path. Worker unavailability or uncertain delivery keeps the
  browser draft and retry identity. Metadata without a native submission does
  not count as acceptance.
- Public Pi InboxDoc/Conversation transactions implement edit, adjacent move,
  individual withdrawal and promotion. Receipts and current human text/uploads
  live in the existing native log. A retry preserves subsequent edits; native
  consumption rejects later mutation. Individual withdrawal does not fail the Run.
- Stop uses native abort and existing ordered closure. Only unconsumed human
  inputs return to the composer. Consumed inputs and individually withdrawn
  inputs do not return. Returned pages survive another browser's acknowledgement;
  premature acknowledgement is rejected.
- Consumed human inputs render between assistant/Tool messages in live and cold
  history. The public root Turn remains a Run presentation/provenance identity,
  without a separate stored state machine. History pagination/navigation retains
  that root boundary; continuations are not fabricated as independent Runs.
- Native queue-document commits carry disposable view wakes in their existing
  publication envelope. Pagination uses an edit revision independent of model
  progress. Native and PG views share pure protocol revision material; the Runner
  does not depend on the PostgreSQL adapter. Ordinary native projection retains
  lease/seal checks while skipping redundant Run first-position updates.

## Verification

- Full workspace suite: 253 files and 1,642 tests passed; 9 existing gated cases
  were skipped. Native input, PG/API, initial claim races, cancellation, Subagents,
  navigation, deletion and storage contracts were exercised.
- The native input slice additionally covers journal reconstruction of edited
  content, lost acknowledgements, cross-instance mutation receipts, reorder ABA,
  tenant isolation, Stop pagination and cold user entries without display events.
- The schema cutover test refuses active work and unacknowledged returned inputs,
  migrates settled initial input, preserves frozen model identity, rejects foreign
  model references and retains terminal-event deletion semantics.
- The isolated conversation/image recovery suite passes with the merged schema.
- The real browser presentation driver passes retry identity, retained drafts,
  pending Steer, Stop restoration, images, navigation and reconnect checks. It uses
  controlled API fixtures; this is not a new live-provider or Cube deployment test.
- [Fault evaluation](fault-eval-latest.md): 215/215 deterministic cases passed.
  Obsolete holding-Run/reconciliation cases were replaced by native intake,
  mutation, Stop and view-wake cases. Missing required target tests still fail
  the evaluator; no compatibility queue was retained to preserve old test names.
- Type checking, build, documentation, formatting, runtime policy and image
  dependency-closure checks pass. Final protocol-helper and cutover-guard changes
  have focused native/PG regression coverage after the full workspace run.

## Deployment and reading checkpoint

Upgrade only as a matched schema 183 + Control Plane/Worker/Web release. Existing
writer drain, seals and physical cleanup requirements still apply. The migration
refuses active or unsealed work and unfinished old input restoration. No old-wire
compatibility path is provided. The development data reset authorization does not
authorize dropping accounts, model/provider configuration or credentials.

After deployment, run:

```bash
PI_CLOUD_LIVE_NATIVE_INPUT_CHECK=1 node --import tsx scripts/run-live-native-input-check.mjs
```

This maintained Luna/Cube check covers one-Run continuation, edits, promotion,
stable retry identity and Stop. It has not been run against the still-old release.

The [reading checkpoint](../READING_PROGRESS.md) remains at Browser → Control
Plane → PG initial-message acceptance. Next: Worker claim and Session lease.
