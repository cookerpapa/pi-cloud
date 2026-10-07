# October 7 recovery and boundary characterizations

Baseline: `1e7e21eb170bff0f0699f156bdd6755c59305eb4`.
See the [review](../../../docs/reports/repository-review-20261007-r3.md).
These scripts characterize existing behavior; completing a reproduction does
not mean the defect is repaired. They do not change product source or deploy.
Current source implements the approved R07R3-01/02/03 and O07R3-01 repairs.
The probes can be rerun against it; the original outputs remain in the versioned
review. Returned intent now compares matching-key retirement with a controlled
omission. The native logging issue is owner-deferred and is not part of this repair.

Run from the repository root after installing pinned dependencies:

```sh
node --import tsx scripts/experiments/review-20261007-r3/recovery-tombstone.mjs /tmp/recovery-tombstone.json
node --import tsx scripts/experiments/review-20261007-r3/returned-intent.mjs /tmp/returned-intent.json
node --import tsx scripts/experiments/review-20261007-r3/read-parity.mjs /tmp/read-parity.json
node --import tsx scripts/experiments/review-20261007-r3/hot-document.mjs /tmp/hot-document.json
node --import tsx scripts/experiments/review-20261007-r3/document-read-cost.mjs /tmp/document-read-cost.json
node --import tsx scripts/experiments/review-20261007-r3/model-error-classification.mjs /tmp/model-errors.json
PI_CLOUD_REVIEW_NATIVE_LOG=1 node scripts/experiments/review-20261007-r3/native-config-log.mjs /tmp/native-config-log.json
```

- Recovery and document probes each create and destroy their own loopback-only
  PostgreSQL container. They do not accept a production database URL.
- Recovery drives actual PG admission, cancellation failure, positive exit,
  seal projection and subsequent input admission. It compares with/without a
  withdrawn queued input in both proof orderings. No VM or model is involved.
- Returned intent composes the actual client request builder, submission identity
  and returned-input helper with a controlled acceptance/reply-loss fixture. It
  records the difference between an acceptance DTO and the current Run state.
- Read parity uses one owned temporary file and the pinned upstream read Tool.
  The directory is removed in `finally`.
- Document reads deliberately hold PG projection while acknowledging fixture
  publication. They count real SQL and inject a read failure. This is not a
  Kafka availability test or a claim that PG lease authority can be removed.
  The cost probe compares complete local reads and cold checkpoint reads for
  20/130/1,024 deltas, counting SQL and timing reconstruction of a synthetic
  16 KiB document. Its process CPU excludes the separate PG process.
- The model probe intercepts `fetch` and uses a synthetic capability. It sends
  no real model request and does not establish the cause of earlier live 500s.
- Native logging requires the configured local Cube deployment and its image
  already in Docker. It reads the Master config privately, replaces credential
  fields with a canary, and starts an owned container with `--network none`.
  Only boolean evidence is written; raw config/stdout and credentials are not
  archived. The container and synthetic config are removed afterward.

The maintained `production:check` was also run with GPT-6 Luna and owned
resources. Its source-equivalent wrapper added failure-only diagnostics and
cleanup IDs; no assertions were relaxed. Live evidence and cleanup scope are
recorded in the review, separately from these deterministic characterizations.
