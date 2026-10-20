# Upload/attachment review characterizations

Baseline: `cf12b444`, deployed `model-runtime-058925bb`, schema 192.
The original characterizations are retained in Git. They have been replaced by
maintained desired-behavior regressions:

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run packages/control-plane/test/upload-lifetimes.postgres.test.ts packages/control-plane/test/workspace-uploads.postgres.test.ts packages/session-attachments/test/storage.postgres.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```

The wrapper owns an isolated PostgreSQL container/database. The API cancellation
case listens only on loopback and closes its single owned client connection.
Workspace and blob placement are controlled port implementations; no production
credentials, object-store endpoint, model, VM or host filesystem mutation is used.
The late PUT case ages its inventory row to represent a progressing upload beyond
the default grace; it never disables reference checks or uses a zero production
grace. The fixture explicitly releases pending sources and removes its controlled
orphan object before closing.

See [findings and scope](../../../docs/reports/upload-lifecycle-review-20261020.md).
