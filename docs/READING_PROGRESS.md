# Architecture reading checkpoint

Updated: 2026-10-12.

The walkthrough explains one component-to-component hop at a time, including
its message, acknowledgement boundary, failure behavior and design tradeoffs.

Current checkpoint: **Worker → native Pi Harness/Storage → PG context reads**.
Covered HTTP idempotency keys, accepted versus executed input, atomic intake,
PG queue readiness and the difference between cloud control records and the
native append-only log. PG notifications wake Workers; they are hints, not task
payloads or execution ownership. The persisted Run survives a missed notification,
and periodic queries cover missed wakes. The Worker pulls eligible ready Runs;
`FOR UPDATE SKIP LOCKED` separates competing claims. Physical-Session ownership,
lease issuance/reuse and the Run's transition to running commit together before
Runner execution. Claim locks last only for the transaction, while leases/fencing
govern the subsequent execution. A pre-commit rollback leaves work queued;
post-commit loss requires the existing closure/recovery path, not blind replay.

Normal fresh-lease admission is 9 business SQL statements, plus BEGIN/COMMIT;
reusing the physical family's current lease skips its creation statement.
The [focused table review](reports/worker-claim-schema-review-20261010.md) retains
Run, physical-Session and lease boundaries. It records two query/index issues,
three unused physical-Session metadata columns and Worker naming debt.
The owner-approved repairs under ADR-0242 are verified and deployed as
`worker-claim-5c803cc5`, schema 184. Source/transport/fault tests and real Luna
input/browser/Worker-recovery acceptance pass.

After claim commits, the Worker registers its publication identity at the
Control Plane ingress before opening the native Session. Registration verifies
the PG grant and installs disposable memory; ordinary appends check that memory.
Opening emits no Kafka/native record. A seal closes the old incarnation without
incrementing its epoch; PG issues the higher epoch only during a new lease claim
after ordered closure. Kafka seal durability and PG-projected closure are distinct.
The owner approved rejecting already-known stale/closed registration requests
before their PG query, while all potentially successful registrations retain PG
checks. The [implementation and rollout](reports/publication-admission-20261011.md)
are complete as `publication-admission-c39a78f8`, with real SQL counts, Luna
input/Stop and Control Plane restart acceptance.

Native opening is Worker-local. A live physical Session lease incarnation shares
one Harness/Storage; a new incarnation opens fresh, and the last attached Run
closes the owner. Storage first reads PG's latest native commit sequence/next ID,
then serves indexed records/documents as Pi requests them. Harness.open restores
live tasks before scheduling; cloud binding applies the admitted model/tools/cwd.
The initial native submission uses the logical Run ID for deduplication.
Pi derives model context at the sampling boundary from the visible tail and latest
Compaction/reset head, paging only that active range. With no head marker, the
whole visible history remains eligible. PG indexes locate the canonical native
log bodies; the cloud adapter does not invent its own transcript semantics.
Old-writer seal projection precedes cold replacement, while an active writer's
acknowledged overlay covers its own not-yet-projected commits.

Storage-layout follow-up: the owner approved ADR-0243 after the append-only review.
Inbox/input metadata and Submission current values remain Pi-owned and acknowledged
through the same Kafka commit. PG materializes them without intermediate bodies;
index rebuild uses retained history plus authoritative current state. Other native
records retain their existing policy.
[Implementation and matched schema 185 deployment](reports/native-input-current-state-20261012.md)
are complete, including current-state reconstruction and real Worker-crash recovery.

The owner approved [ADR-0244](adr/0244-kafka-backed-native-live-state.md) after
comparing Pi's latest-only live state with the earlier Kafka-text/PG-message split.
It is deployed as `native-live-1370d871` under schema 186: publications stay intact, PG keeps
small commit headers, and current live reads span Kafka-backed memory and PG
boundary/handoff checkpoints. Protected replay references span Conversation/Run
anchors. The [report](reports/native-live-state-20261012.md) records the matched
rollout and actual Worker/Projector crash recovery. Other documents retain their 64-delta read
accelerators; these are not model Compaction or whole-Session recovery snapshots.
The walkthrough checkpoint above is unchanged.

Follow-up discussions established:

- Core Session/Turn/Run fields are consolidated under ADR-0238.
- A cloud Run can process multiple native human submissions.
- Native follow-up waits for the final boundary; steer uses the earlier native
  boundary. Pi Durable persists pending submissions and InboxDoc changes.
- Pending edits use Pi transactions and Kafka durability. ADR-0243 replaces
  their PG current values without retaining superseded edit bodies in history.
- Current UI model preference remains control state. Actual native Run model
  configuration is persisted when applied, not for every selector click.
- During a running Run, an unavailable Worker leaves the new draft unconfirmed
  in the browser; success requires native Kafka durability acknowledgement.
- ADR-0240 reuses Session/idempotency reads inside the same locked transaction:
  ordinary initial intake is eight business SQL statements and same-key retry
  is two. Normal authentication plus BEGIN/COMMIT bring initial intake to eleven.
- Ordered Kafka views speed downstream routing/display; mutable PG admission
  decisions still use current authority. This change adds no cross-request cache.
- The Workspace admission SELECT checks the PG resource and keeps its shared
  lock until Run registration commits. It does not stat a directory or probe a VM;
  concurrent deletion and Run intake remain serialized by the existing PG locks.
- Projector's binding view serves ordered Tool routing, with synchronous closure
  and recovery guards; it does not replace new-Run Workspace admission.
- The directory-deletion discussion found a separate guest classification bug.
  ADR-0241 returns known pre-execution user-directory failures as native Tool errors;
  it is deployed with same-Run Luna continuation, explicit directory restoration
  and unchanged VM identity. No intake SQL changes were required.

Resume with: **how a native Storage commit submits the initial input/runtime
progress through the registered publication ingress and receives Kafka confirmation**.
Keep the later provider/model request as a separate walkthrough hop.

ADR-0245 is implemented and deployed as `native-text-c9b8b2a3` (schema 187/topic v15). Pi still calls public
`Storage.commit`; PiCloud puts that complete commit and text display descriptions
into one acknowledged Kafka record. The old post-commit assistant-text publisher
is removed. Native interpretation stays in Worker, while Projector resolves
same-commit references and advances history/SSE coverage. The
[release report](reports/native-text-presentation-20261012.md) tracks deployment.
This does not advance the guided architecture reading beyond the Storage/open
context discussion.
