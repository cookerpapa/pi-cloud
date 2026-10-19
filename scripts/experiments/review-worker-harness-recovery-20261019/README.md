# Replacement Worker / native Harness recovery review

These checks accompany the [focused review](../../../docs/reports/worker-harness-recovery-review-20261019.md).
They characterize current behavior; they are not runtime fixes or deployment
acceptance. No production connection, Kafka writer, actual provider, VM operation
or OS process-crash experiment is used.

Run from the repository root with pinned dependencies and Docker available:

```sh
env -u PI_CLOUD_POSTGRES_INTEGRATION_URL -u PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL node scripts/run-with-test-postgres.mjs -- npx vitest run packages/control-plane/test/native-session-host.test.ts packages/control-plane/test/worker-native-conversations.test.ts packages/control-plane/test/durable-execution-recovery.test.ts packages/pi-session-postgres/test/durable-storage-conformance.test.ts packages/sandbox-supervisor/test/durable-agent-session.test.ts packages/sandbox-supervisor/test/durable-compaction-recovery.test.ts packages/sandbox-supervisor/test/durable-human-inputs.test.ts packages/sandbox-supervisor/test/durable-turn-runner.test.ts packages/sandbox-supervisor/test/durable-tool-call-publication.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/probe.mjs /tmp/pi-cloud-worker-recovery-io.json
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/cost.mjs /tmp/pi-cloud-worker-recovery-cost.json
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/family.mjs /tmp/pi-cloud-worker-recovery-family.json
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/bootstrap-stop.mjs /tmp/pi-cloud-worker-recovery-stop.json
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/submission-status-cost.mjs /tmp/pi-cloud-submission-status-cost.json
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/family-restore-timing.mjs /tmp/pi-cloud-family-restore-timing.json 1,8,32,128
```

- `probe.mjs` always starts its own disposable official-PG container. It briefly
  occupies an owned pool connection or table lock, observes pending reads/close,
  then releases the fixture. An in-memory image source records cancellation and
  object-read counts. The current defect assertions intentionally need replacement
  when their repairs land. It never leaves blocked SQL behind a detached timer.
- `cost.mjs` uses a separate owned server. Native cold open plus a two-entry active
  context is measured after 0/1,000/10,000 old Entries and a synthetic native head
  marker. It asserts exact context and zero old bodies returned, not an end-to-end
  model Compaction result. The child case runs the actual Session host metadata
  loader against real source/cursor rows while controlling its native active-view
  port. Its 2N count excludes native document scans, lease checks and child setup.
- `family.mjs` captures only committed native writes from an in-memory parent/
  child fixture. Reopening that prefix checks a completing parent, unsafe child
  Tool, queued follow-up, ownership gates and both continuation and Stop. This
  exercises public Pi recovery without killing a process or replaying shell work.
- `bootstrap-stop.mjs` reuses that prefix in the actual remote Runner composition
  and delivers Stop while a restored child is binding. Native Storage/Harness and
  root/child runner code are real; authority, active-view and publication ports
  are controlled. Model and VM entry are forbidden and counted. It tests wrapper
  cancellation, not distributed ownership or physical execution shutdown.
- `submission-status-cost.mjs` checks the dimension missing from the Entry-only
  sample: current completed Submission receipts. Three scopes coexist in owned
  PG with 0/1,000/10,000 completed receipts and one queued receipt each. Real
  projection writes maintain native indexes/current bodies; shared Entry references
  isolate receipt metadata from transcript size. It captures actual status-query
  plans before/after a disposable comparison index. That index is never deployed;
  the experiment does not validate generic prepared plans or whole-family latency.
- `family-restore-timing.mjs` captures a real native committed prefix containing
  a completing root and active short-text children, materializes it in owned PG,
  checkpoints live progress and reopens through the actual Session host and
  remote Runner. Child source/cursor reads, shared native Harness and sequential
  rebinding are real. It counts arrival at the model-permit port for every child,
  then cancels without contacting a model or VM. The resource fixture supplies
  already-granted authority; publication projects synchronously to PG instead of
  Kafka. Timings exclude failure detection, writer closure, Pod startup, Kafka
  acknowledgement and provider response. PG caches may be warm from seeding;
  there are no attachments, long contexts or large completed-history background.
  The optional count list is bounded to 128 for this experiment only. It is not
  a product quota, production recovery SLA or full distributed failover test.

Each output records the reviewed revision and probe hash. Temporary PG containers
and the wrapper's directory are removed. The 1×1 image probe does not replace the
previous release's incomplete large-image cold visual-recall acceptance.
