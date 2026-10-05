# October 5 review improvements

Started from review commit `13344042`, under ADR-0227. The owner approved R05
repairs and widening the two large-reply permits. Implementation is complete;
combined verification and matched release acceptance are in progress.

## Implemented behavior

- R05-01: the fixed POSIX Detach has no success-metadata dependency. Failed
  Attach persists pending cleanup; state-write failure stays visible and held.
  Cube's existing ResourceLocks now provide cancellable waiting and idle lock
  removal. Actual plugin/Bolt tests pass after restart with zero/other holders.
- R05-02: lifecycle work has PG server lock, statement and total-transaction
  budgets, preserving owner SHARE/CAS/final expiry checks. Renewal updates only
  its own identity. Existing maintenance marks retired owners' resources in
  bounded SKIP LOCKED batches. Migration 175 removes unused terminal lease copies.
  Real PG tests prove resource/terminal waits beyond a lease do not prevent owner
  renewal or unrelated Workspace work; a killed transaction connection is retired.
- R05-03/04: fixed Tools and Workflow share typed outcome policy. Confirmed
  non-execution survives cancellation and disposal; unknown Workflow transport
  blocks the next Pi model request. Native/business error text is not authority.
  Pre-driver `tool_cancelled_before_start` is distinct from in-flight native
  `tool_cancelled`, which may have effects. The completion message reflects that
  difference instead of describing a confirmed not-started reply as unconfirmed.
- Read capacity is eight instead of two. The permit still covers final delivery;
  queued cancellation and ordinary work remain independent of blocked replies.
  Native final buffers are transferred immutably rather than copied twice.
- Cold native writer cleanup batches PG queries and cannot overlap itself.
  Deployment waits for a ready Cubelet of the desired image before source/protocol
  checks. R05-05's current Volume/rollback documentation has been corrected.

No new queue, service, RunAttempt, result ledger or execution authority was added.
This release widens the existing Read gate; it does not implement the separately
discussed streaming image transport or claim constant-memory image decoding.

## Targeted verification

- Native POSIX/Bolt/MySQL and race checks: failed Attach/restart/shared holders,
  cleanup receipt failure, cancellable lock waiting and lock collection passed.
- Lifecycle/renewal tests: 25 assertions passed against the complete PG schema.
- Tool outcomes: 56 assertions passed; the subsequent producer distinction and
  next-model-request checks passed 20 focused assertions.
- Native admission tests passed, including eight concurrent large replies,
  blocked delivery, ordinary-operation progress, pre-start cancellation and reuse.
- Native Session Host and desired-image readiness tests: five assertions passed.

The first expanded native suite hit ETXTBSY while executing a freshly created
binary-plugin test stub on Docker overlay storage. The test runner now places
temporary fixture files on an executable tmpfs, with compiler scratch separate.
There is no runtime retry around plugin effects. The rerun is recorded separately.

Review-only characterizations were retired after conversion into maintained
tests; their original source remains at `13344042`. Historical review evidence
retains its baseline instead of being rewritten as post-repair proof.
