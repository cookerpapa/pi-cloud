# ADR-0298: Independent usage receipt receiver

Status: accepted; implementation in progress.
Date: 2026-11-07. Tracking: [Issue #5](https://github.com/cookerpapa/pi-cloud/issues/5).

## Decision

Run the existing receipt validation, deduplication and valuation in an independent
`metering` process. CLIProxyAPI delivers its durable outbox directly to this
service; the management Control Plane no longer receives or forwards receipts.
PostgreSQL remains the single accounting authority. Move the accounting library
out of the Control Plane package, retaining its PiCloud-owned receipt protocol.
Use the same pinned host image with a separate entry point and Deployment; an
additional build artifact, broker or database is unnecessary.

The statement API reads the same PG records through the shared accounting library.
Its authenticated public routes move with the Session API in Issue #9. Stopping
management must not stop receipt ingestion or, after that split, statement reads.
Sharing a database/library is not a dependency on the management process.

## Evaluation

| Choice | Benefit | Cost / reason |
| --- | --- | --- |
| Source adapters write PG directly | Removes one HTTP hop | Exposes financial schema, pricing implementation and DB credentials to each source; Go provider and Cube must duplicate transactional rules and schema upgrades |
| Independent receipt receiver | Preserves the existing source outbox and versioned protocol; one pricing implementation | One small stateless Deployment and HTTP hop, already present in the current delivery path |
| Full billing platform | Existing catalogs, subscriptions and invoice/payment machinery | Larger deployment and a new financial authority; not needed for the approved informational statements |

Choose the independent receiver. Source adapters own measurement and reliable
delivery, not prices or account balances. This also permits computing/storage
receipts to use the same account without pretending they are model token events.

The adopt-before-build assessment in ADR-0297 still applies. Rechecked official
[OpenMeter ingestion](https://openmeter.io/docs/metering/events/how-it-works)
and [Lago ingestion](https://getlago.com/platform/usage-metering/ingestion) on
2026-11-07: both offer downstream metering pipelines, but adopting their complete
stack would add storage/processing dependencies for this bounded extraction.
We retain the existing pinned bbolt source outbox and PG transactions rather than
implement a second queue or billing scheduler. Revisit adoption when subscriptions,
invoices, wallet admission or sustained measured ingestion load require it.

## Failure behavior

Receipt success means PG commit, not placement in receiver memory. Same-content
retries are idempotent; conflicting identities are rejected. Receiver restarts
lose no acknowledged receipts. PG/receiver outage leaves the source outbox pending
and eventually applies its existing admission backpressure; neither replays model
requests nor cancels already performed external work. Readiness reflects PG access;
liveness is independent so a PG outage does not cause a restart loop.

No real tariffs, payment collection or model request fencing are introduced.
Model retries, Session ownership and native history remain unchanged. Outbox
loss and absent upstream usage retain the declared unknown/unconfirmed limits.

## Acceptance

- Model ingest is absent from the management API and reachable at the independent
  service, using the same private credential and bounded receipt schema.
- Normal, child, compaction and image attribution and exact pricing remain valid.
- Duplicate/conflict, lost acknowledgement, receiver restart and unavailable PG
  preserve the receipt contract.
- In a live owned fixture, stop management while leaving metering running and
  demonstrate the provider receipt in PG before management restarts.
- Preserve public statements/export; validate their independent route in Issue #9.
- Match deployment, health, network policy and release evidence to the new topology.
