# Architecture reading checkpoint

Updated: 2026-10-10.

The walkthrough explains one component-to-component hop at a time, including
its message, acknowledgement boundary, failure behavior and design tradeoffs.

Current checkpoint: **Worker → PostgreSQL atomic Run claim**.
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
The owner approved their repair under ADR-0242; verification and deployment are
in progress. The walkthrough remains at this hop until those repairs are verified.

Follow-up discussions established:

- Core Session/Turn/Run fields are consolidated under ADR-0238.
- A cloud Run can process multiple native human submissions.
- Native follow-up waits for the final boundary; steer uses the earlier native
  boundary. Pi Durable persists pending submissions and InboxDoc changes.
- Pending edits append document changes; they do not rewrite committed history
  or expose superseded drafts to the model.
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

Resume with: **how the Worker uses its committed execution grant to prepare/open
the native Pi Session and load the conversation state before the Agent runs**.
Keep later model requests and native Kafka publication as separate walkthrough hops.
