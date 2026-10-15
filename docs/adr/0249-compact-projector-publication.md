# ADR-0249: Compact Projector publication and derived presentation

Status: accepted for implementation, 2026-10-15. The owner approved the
[focused review](../reports/projector-envelope-review-20261015.md) and its ordered
repair plan. Review baseline: `c3aca045`; preserved evidence: `8e734945`.

## Behavior and boundaries

Retain ADR-0247's physical Session writer, PG admission, native Kafka producer
fencing, ordered closure and single Session Projector group. Retain Pi 1.0's exact
native Storage writes, current-input policy, live checkpoints and post-Harness
canonical Tool results. This decision removes duplicated cloud transport and
presentation work; it adds no authority, consumer, storage service or scheduler.

1. The projection's private prefix tracks presence, display watermarks and the
   identity needed to detect conflicting uncovered events. It retains no event
   bodies or text. Writer retirement clears every root/child prefix, in ordinary
   completion and forced closure. Public live presentation keeps its own tail.
2. Decode a publication and prepare its dispatch references once per process
   boundary. Use a per-record write index preserving native write order. Keep
   source validation, identity checks and commit-before-effect; do not cache
   authority across records or add per-Tool PG reads.
3. Use one compact private Kafka envelope. Shared tenant/physical Session/root
   Run/Writer/epoch is inherited within that record. Each child retains its own
   product Session/Turn address. Derive physical lease aliases from writerId and
   display Tool IDs from native taskId; operationId and provider callId remain
   distinct. The original Worker Boot reply Topic is shared per commit, never
   reconstructed from a replacement Worker.
4. Separate wire facts from expanded internal Tool commands. Boundary codecs
   expand the one supported compact format into self-contained domain/adapter
   objects. This is not an old-format fallback. Persist sufficient normalized
   control-dispatch metadata for cold recovery independently of Kafka retention.
   Remove unused standalone cancellation publication; native abort and physical
   cancellation continue in the same native commit. Message kinds encode the
   former always-true writer-close markers; actual closure proof is unchanged.
5. Prepare Tool-start and canonical Tool-result presentation references at the
   trusted Worker before publication, alongside native writes. Generic Projector
   selectors construct the unchanged public events without copying Tool argument
   or result bodies into another Kafka event. Preserve result formatting and
   bounded display output. Never wait for Pi's post-adoption watcher from inside
   Storage.commit; never infer final results from raw Cube replies. Unrelated
   provider/control observations retain their defined paths.
6. Fixed Cube Tool requests carry their actual binding/operation identity,
   arguments, timeout and output budget. Remove unused Turn/Step context hashes
   from that request type. Workflow requests retain the context validation they
   actually use. Cube boot/position fencing, scope revocation and tenant checks
   remain independent requirements.

Native seq/nextId/writes, historical origins, display coverage, reply identity,
control revisions and immutable cleanup targets are not disposable duplication.
No signature system, second transcript, Tool result cache or compatibility path
is introduced. Projection replay must never replay arbitrary Shell work.

## Adoption and implementation choice

Continue the pinned Kafka transactions and Pi public Storage/Tool ports already
evaluated in ADR-0228/0229/0243/0247 and the
[Kafka fencing study](../reports/kafka-native-fencing-20261013.md). This slice
changes PiCloud-owned descriptors and adapters, not their distributed scheduling
or persistence algorithms. A separate event store/workflow framework would create
a competing authority without removing the required Pi/Cube boundary. Generic
native write selectors and existing codecs are the bounded retained adapter.

## Ordered slices and acceptance

- A1: no full-body private prefix; forced/normal closure clears all child state;
  conflict detection, handoff watermarks and missing-prefix checks still pass.
- A2: one validated decode/preparation per record; indexed lookup, mixed native
  writes, multiple Tools and per-partition replay/dispatch contracts pass.
- A3: compact wire schema, derived aliases, shared reply target, removal of
  standalone cancellation and single-root projection cleanup. Wrong child/owner
  identity is rejected before side effects; control recovery remains self-contained.
- A4: same-commit Tool presentation; large inputs/results occur only in native
  storage content, with unchanged public output, hook processing, cancellation,
  overflow recovery, child views and history/live coverage.
- A5: fixed/workflow request separation and matched guest contract. Fixed Tool,
  workflow, cancellation, source truncation and ordered stale-operation rejection
  remain accepted.
- A6: required repository checks, maintained matched release and relevant real
  Luna/Cube/browser/native-input/recovery checks. Preserve accounts, provider/model
  settings and credentials. Record exact artifacts, failures and physical cleanup.

Work through the slices sequentially. A wire/guest change requires a matched
versioned cutover with drained writers and confirmed physical cleanup. Preserve
existing native history when it needs no old protocol decoder; remove obsolete
transport resources only after their retention/ownership requirements are closed.
If retained old control data cannot be interpreted without compatibility code,
use the already authorized destructive development cleanup after quiescence.
Do not bypass VM absence or writer fencing to make release checks pass.

Rollback is a complete matching application/schema/Cube/guest set while drained,
not a mixed-version reader. The dispatch-commit/Cube-takeover UNKNOWN window and
delayed producer-initialization availability cost remain explicitly unchanged.
