# ADR-0228: Isolated Pi Durable 1.0 evaluation

Status: verification complete, 2026-10-05. No runtime adoption or rollout.
[Observed compatibility and adoption gaps](../reports/pi-durable-evaluation-20261005.md).

The owner requested executable verification after comparing pinned Pi 0.84.1
with upstream v1.0.0. Evaluate one slice: the durable commit boundary and fixed
remote Tool boundary. Production remains on ADR-0227 and the pinned dependencies.

## Adopt-before-build evidence

Upstream [Pi 1.0](https://earendil.com/posts/pi-1-0/) separates the stable coding
agent from experimental [Pi Durable](https://earendil.com/posts/pi-durable/).
The MIT-licensed v1.0.0 package provides task checkpoints, atomic document/entry/
task commits, a scheduler, storage conformance tests and explicit Tool replay
policy. Its APIs are experimental. Use the published pinned package and public
`MemoryStorage.prepareCommit`, Harness, hooks and storage interfaces; do not fork
the loop or write a competing scheduler to make an experiment pass.

The current PG/native Session adapter and guest Tool imports depend on interfaces
removed from pi-agent-core 1.0. This evaluation is not an import-path migration.
Pi Durable's built-in storage has one process owner and no distributed fencing.
Its Task/Document model and persisted live output need separate adoption decisions.

## Evaluation boundary

Run pinned 1.0 dependencies in an isolated script package, outside production
workspaces. Reuse the existing disposable PostgreSQL and RF3 Kafka fixtures,
publication/consumer adapters, and owned Cube acceptance mechanics. Any private
probe envelopes and SQL tables are fixture-only. No production migrations,
deployment changes, new service, provider credential copy into guests or second
active Session authority are authorized by this experiment.

Use upstream MemoryStorage as the prototype's live view and validation logic.
Prepare a batch, publish it under one writer, and apply only after Kafka confirms.
PG records exact committed batches for crash-reopen experiments. Replaying these
small fixtures is not a production cold-read implementation: bounded bootstrap,
indexed queries, compaction, retention and full production admission remain
explicit adoption gaps until independently verified.

## Acceptance

- Committed state and external effects cannot appear before the publication ACK.
- Delayed PG projection does not delay the hot commit; reopen waits for a known
  projection boundary. One batch stays atomic, and duplicate projection is inert.
- Rejected/ambiguous publication cannot trigger a Tool or let an old writer keep
  sampling. Distinguish committed-but-unacknowledged data from definite refusal.
- Crash/reopen reuses committed results; unsafe external work is not replayed.
  Verify safe replay separately. No arbitrary Shell exactly-once claim.
- Exercise remote operation identity, success, ordinary error, not-started,
  UNKNOWN, cancellation and a completion/Stop race through the public Harness.
  Preserve failures as compatibility findings instead of weakening assertions.
- Check persistent input withdrawal, Stop policy and task ownership where they
  affect the existing cloud boundary. Measure commit/output amplification.
- Run an owned actual Cube Tool/reply smoke after deterministic probes; close its
  allocation and reply topic. No fault injection against shared production Pods.

Record observed compatibility, failing contracts, replacement candidates and
remaining migration work in a revision-bound report. Evaluation completion does
not authorize a production cutover. Reversal removes only the isolated package
and fixtures; there is no application data migration to roll back.
