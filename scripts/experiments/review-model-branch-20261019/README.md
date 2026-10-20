# Model request / response review evidence

The defect-asserting 12-case probe is retained in Git at `4cb3440b` and removed
from the repaired checkout. [Historical findings and hashes](../../../docs/reports/model-request-response-review-20261019.md)
remain evidence for that baseline, not a claim about the current implementation.

Current regressions use the pinned native Models adapters over owned loopback
HTTP, native Harness/Storage and separately owned PostgreSQL fixtures. They send
no requests to actual model providers and execute no VM/shell Tools.

```sh
npx vitest run packages/sandbox-supervisor/test/model-response-harness.test.ts packages/sandbox-supervisor/test/provider-response.test.ts packages/sandbox-supervisor/test/provider-hosted-transcript.test.ts packages/sandbox-supervisor/test/durable-tool-call-publication.test.ts packages/sandbox-supervisor/test/durable-scoped-models.test.ts packages/sandbox-supervisor/test/durable-turn-runner.test.ts packages/supervisor-host/test/model-gateway.test.ts packages/supervisor-host/test/worker-retirement.test.ts --maxWorkers=1 --testTimeout=30000
node scripts/run-with-test-postgres.mjs -- npx vitest run packages/sandbox-supervisor/test/hosted-native-storage.postgres.test.ts packages/database/test/current-schema.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```

These cover the four model findings and unbounded-work ownership/retirement.
The PG fixture projects synchronously in place of Kafka; actual RF3 and live
handoff/long-work acceptance remain separate release gates. See
[delivery status](../../../docs/reports/model-runtime-repair-20261020.md).
