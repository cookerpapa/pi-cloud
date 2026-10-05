# October 5 review improvements

Started from review commit `13344042`, under ADR-0227. The owner approved R05
repairs and widening the two large-reply permits. Implementation and the matched
release are complete. Final fault acceptance and resource inventory are recorded below.

The [verification index](review-improvements-verification-20261005.json) records
1,717 workspace cases plus 65 helper cases passed, with nine optional external
cases skipped. This combines the full run with the corrected suites and final
Workflow regression suite; it is not a claim of one uninterrupted green CI run.
The [186-case fault report](review-improvements-faults-20261005.json) overlaps
the package tests and is not an additional count of unique cases.

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

The combined CI run passed native/build/type checks and found two outdated test
expectations: the schema snapshot still named migration 174, and a heartbeat test
expected renewal itself to mark the owner lost. The schema test now expects 175
and verifies no copied terminal lease columns; all 41 database assertions pass on
rerun. The heartbeat test now separately proves expiry cannot be renewed and the
maintenance path marks it lost. The remaining CI gates passed separately:
65 acceptance-helper assertions, 186/186 fault cases and the high-severity audit
(two moderate dependency findings remain). The final Workflow cancellation-race
change passed all 278 supervisor assertions and its type check. This records the
actual command sequence rather than claiming the initial CI exited successfully.

An already received Workflow completion now wins a later Stop, including when
observation begins after cancellation. Missing completion still becomes UNKNOWN.
The [reply-memory fixture](review-reply-memory-20261005.json) uses the actual
completion parser/adapter/codec with delayed in-memory blob/reply sinks. Eight
13.7 MB base64 replies complete; the observed process peak is about 503 MiB.
This excludes Cubelet, Guest, Worker and real S3/Kafka costs and is not a fleet
capacity claim. The maintained measurement script records its scope explicitly.

The first expanded native suite hit ETXTBSY while executing a freshly created
binary-plugin test stub on Docker overlay storage. The test runner now places
temporary fixture files on an executable tmpfs, with compiler scratch separate.
There is no runtime retry around plugin effects. The rerun is recorded separately.

Review-only characterizations were retired after conversion into maintained
tests; their original source remains at `13344042`. Historical review evidence
retains its baseline instead of being rewritten as post-repair proof.

## Matched release and owned live acceptance

Cube API/Master/Cubelet use `review-outcomes-v7`, patch identity `e22ef09aace2b280`
and completion source `139771883a383216c2425937f8156ec2ddf0fae4`. Applications use
`review-outcomes-v7-app`, runtime source `a14e4727`; subsequent changes are tests,
acceptance fixtures and documentation. Managed protocol remains 7, Guest wire 3
and Guest source `992bcf3ad59056d2eb43b87f623fd351661ae47f`. PG schema is 175.

Images were imported through the existing authorized K3s containerd socket.
The existing-cluster Helm reconciliation used the shared renderer and retained
values, with an explicit matched native image selection; root-only host
preparation was unnecessary. Workers and the old Control Plane were drained
before migration 175. No business-data reset was performed. The private PG
backup is retained under the runtime backup directory.

- [Volume and allocation](review-volume-acceptance-20261005.json): actual VMs share
  bytes; direct paused release succeeds; a live sibling prevents Volume deletion;
  delayed creation is rejected; final owned Volume cleanup is confirmed.
- [Native Tools](review-native-tools-20261005.json): four Luna Runs pass fixed
  read/write/edit/bash, source truncation, symlink behavior and ordinary error
  continuation. The first fixture attempt failed because Luna omitted a quote in
  a supplied Python command. Read-only Kafka diagnosis scoped to that disposable
  Session confirmed a Bash syntax error and a completed Run. The fixture now
  supplies exact JSON source/commands and validates actual bytes/commands; all
  original output/status assertions remain. Initial failure is not counted as a pass.
- [Cancellation](review-cancellation-20261005.json): foreground cancellation in
  552ms retains partial output and context. Completed background work, independent
  process groups and a shared-VM sibling survive; explicit later cleanup succeeds.
- [Unavailable execution API](review-cancellation-fault-20261005.json): pausing
  Cube API makes cancellation unconfirmed; after 22.52 seconds the Run retains
  UNKNOWN and interruption context. Exactly one execution was observed. Shared
  VM work survives, the API is resumed and explicit later cleanup succeeds.
- [Images and Worker replacement](review-images-20261005.json): 6.3/6.3/25.1 MB
  normalized images become 778/778/779-byte native references. A replacement
  Worker recalls all three immutable images after the source path changed.
- [Development machine](review-development-20261005.json): terminal reconnect,
  one-time SSH, shared/temporary Subagents, preview isolation, Control Plane
  replacement, pause/resume, release and conversation/Workspace separation pass.

Fixture cleanup is scoped to the created resources. Three recorded test-image
objects were deleted only after locked identity/reachability checks; all three
pre-existing image identities were verified unchanged. Historical untracked
UNKNOWN allocations remain subject to their existing physical-proof requirements.

The [final release inventory](review-improvements-rollout-20261005.json) was
captured after fault recovery and cleanup: all 31 running Pods are ready, exact
Cubelet inventory has zero VMs, and no active Runs, terminals, development
machines, live Workspace allocations or test conversations remain. The three
original image identities are unchanged and the two historical UNKNOWN
allocations remain recorded. Schema 175 has no duplicated terminal lease fields.
