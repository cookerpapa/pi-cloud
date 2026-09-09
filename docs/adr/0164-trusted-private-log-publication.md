# ADR-0164 — Trusted private log publication without record signatures

Status: implemented and [verified](../reports/unsigned-publication-acceptance.md).
Refines ADR-0163's publication authentication only.

## Decision

Workers, Projectors, PostgreSQL and Kafka belong to the same trusted private
deployment. Cube guests and browsers have no Kafka or authority credentials.
Remove per-Attempt Ed25519 keys, per-record signatures and Projector cryptographic
verification. Do not add a signature switch, replacement token or remote gate.

Keep the existing one-time PG Lease/fence check at publication opening, frozen
Session/Attempt/Lane scope, ordered opening and positioned seals. Projector caches
that scope and checks record attribution, not cryptographic origin. A seal still
must match the authority's recorded Outbox request. Native projection and recovery
positions commit together; Tool admission retains operation deduplication and
Lease/fence checks. Late old records cannot become effective after their seal.

This contract handles stale or failed trusted processes, not a malicious producer
impersonating another permitted execution. Operators must restrict Kafka and PG
access to trusted services. Network isolation is a deployment prerequisite, not
a substitute for tenant authorization on public APIs or Cube isolation.

## Deployment and verification

Drain active Runs and project their seals, then replace Workers and Projectors
together. The Kafka topic, offsets, PG schema and semantic history are unchanged.
No user data reset or runtime compatibility branch is required; historical JSON
may retain unused signing metadata, just as historical reports describe old code.

Test unsigned publication, exact scope and opening order, cache reconstruction,
post-seal rejection, interrupted-prefix recovery, and no-replay Tool admission.
Measure the existing isolated Kafka workload without signature CPU or bytes;
report transport throughput separately from full Agent latency.
