# Replacement Worker / native Harness recovery evidence

The [focused review](../../../docs/reports/worker-harness-recovery-review-20261019.md)
records the original findings and baseline. Its defect-asserting I/O/status/2N
query probes and old controlled bootstrap fixture are retained in Git at
`19a0a2da`; they are removed from the repaired checkout rather than kept as
tests that require obsolete behavior. Their original evidence hashes remain
historical evidence, not a claim about the current scripts.

Run maintained regression tests from the repository root with pinned dependencies
and Docker available:

```sh
env -u PI_CLOUD_POSTGRES_INTEGRATION_URL -u PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL node scripts/run-with-test-postgres.mjs -- npx vitest run packages/database/test/read-pool-budget.postgres.test.ts packages/pi-session-postgres/test/durable-read-lifetime.postgres.test.ts packages/pi-session-postgres/test/durable-submission-status.postgres.test.ts packages/pi-session-postgres/test/durable-storage-conformance.test.ts packages/control-plane/test/native-child-reattachment.test.ts packages/control-plane/test/durable-execution-recovery.test.ts packages/control-plane/test/subagent-conversations.test.ts packages/sandbox-supervisor/test/durable-child-reattachment.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/family.mjs /tmp/pi-cloud-native-family.json
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/family-restore-timing.mjs /tmp/pi-cloud-family-timing.json 1,8,32,128
node --import tsx scripts/experiments/review-worker-harness-recovery-20261019/family-restore-timing.mjs /tmp/pi-cloud-family-stop.json 8 stop-during-restore
```

`family.mjs` reopens a real committed in-memory prefix to check native parent/child
ownership, unsafe Tool non-replay, queued input and Stop. It uses faux models and
does not exercise distributed admission or kill a process.

`family-restore-timing.mjs` captures a completing root and active short-text
children, materializes native commits in owned PG, checkpoints live progress and
reopens through the actual Session host and remote Runner. Native configuration,
source/cursor validation, shared Harness and child reattachment are real. The
same faux model descriptor is retained across reopening; model requests are held
at the permit port. The stop variant interrupts after the first child binding,
asserts zero model/VM entry and checks withdrawal of all owned queued inputs.

The resource fixture supplies already-granted authority. Publication projects
synchronously to PG instead of Kafka. Timings exclude failure detection, writer
closure, Pod startup, Kafka acknowledgement, local model-permit waiting, remaining
cloud request transformation and provider response. PG caches may be warm from
seeding. The optional count list is bounded to 128 for this experiment, not the
product. There are no attachments, long contexts or large completed-history
background, and no full-failover SLA or fleet-capacity claim.

The scripts use disposable official PG containers, faux/in-memory providers and
temporary directories. No production database, Kafka writer, actual provider or
VM is used. Outputs record the source revision and script hash. Temporary owned
resources are removed. These checks do not replace the release's large-image
cold visual-recall acceptance.
