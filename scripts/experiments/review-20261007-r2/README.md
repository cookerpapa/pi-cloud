# October 7 post-release review probes

The original probes characterized `59541389d26a8f4c4e982f27e645a18b8e89892f`.
See the [review](../../../docs/reports/repository-review-20261007-r2.md).
The four defect probes now verify the [repaired behavior](../../../docs/reports/review-repair-20261007-r2.md).
Original measurements remain in the review JSON. The commit-guard regression
is maintained in the event-log package test suite.

From the repository root, after installing its pinned dependencies:

```sh
node scripts/experiments/review-20261007-r2/cross-send.mjs /tmp/cross-send.json
node --import tsx scripts/experiments/review-20261007-r2/upload-crash.mjs /tmp/upload-crash.json
PI_CLOUD_REVIEW_OUTPUT=/tmp/partition-locks.json npx vitest run packages/event-log/test/partition-commit-isolation.test.ts --maxWorkers=1
node --import tsx scripts/experiments/review-20261007-r2/image-orientation.mjs /tmp/image-orientation.json
node --import tsx scripts/experiments/review-20261007-r2/deep-pagination.mjs /tmp/deep-pagination.json
node --import tsx scripts/experiments/review-20261007-r2/rf3-isolation.mjs /tmp/rf3-isolation.json
node --import tsx scripts/experiments/review-20261007-r2/partition-commit-load.mjs /tmp/partition-commit-load.json
```

- `cross-send` needs Chrome. It drives the real ChatApp and API builder in the
  maintained response-loss fixture: ordinary X loses its ACK, different Steer Z
  succeeds, then a fresh ordinary X receives a new key. The reverse sequence is
  checked too. While a Run
  is active, ordinary queue submission uses Enter; the arrow button is replaced
  by Stop/Steer. No real Session or provider is used.
- `upload-crash` needs Linux flock. It creates an owned POSIX Volume fixture,
  kills only its own three upload children after 64 KiB each, reclaims abandoned
  staging with a cold Gateway without another upload, then completes a 2 MiB
  retry with zero staging orphans. Authorization is a fixture callback. The
  temporary Volume directory is removed in `finally`.
- `partition-commit-isolation.test.ts` runs the actual KafkaPartitionReader with controlled
  native client callbacks. The approximately 120 ms hold is deliberate. It
  requires healthy publication to continue. It does not measure broker performance.
- `image-orientation` uses a synthetic EXIF-orientation-6 JPEG and the actual
  image processor. It checks encoded versus displayed geometry without a model.
- `deep-pagination` needs Docker and creates/removes its own PostgreSQL fixture.
  Current tables/indexes are copied without foreign keys for query measurement.
  It checks the actual reader at three page depths over 5,000 uneven histories.
  EXPLAIN's per-loop row counts are rounded; returned counts are checked exactly.
- `rf3-isolation` needs Docker and creates/removes three pinned Kafka brokers.
  It uses the actual consumer/publisher and a controlled Tool handoff, checks
  partition behavior, then replaces the consumer and rewinds the group. No real
  Tool executes. This is not a PG/Cube recovery or multi-host availability test.
- `partition-commit-load` creates an isolated RF3 cluster, drives 32 actual
  transactional publishers and counts ordinary offset-commit calls for 128
  records. Timing includes deliberate gaps; a single sample is not a fleet SLO.

The commands above use owned fixtures and write no production data. For a
configured native installation, the separate live acceptance creates and removes
one owned VM/Volume, copies freshly bundled input/holder helpers into that VM,
checks UID-1000 file locking, SIGKILL reclamation, final-file preservation, retry
and EXIF normalization, then confirms physical cleanup:

```sh
node --import tsx scripts/experiments/review-20261007-r2/live-staging.mjs /tmp/live-staging.json
```

All JSON output arguments are optional. No probe calls a paid model. Live helper
acceptance is not a matched image rollout or a physical-host restart test.
