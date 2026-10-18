# Session seal publication repair and delivery

Decision: [ADR-0260](../adr/0260-session-seal-publication-lifetimes.md).
Review baseline: `f5bb08ed`. Source implementation is complete; broad verification
and matched delivery are pending. Serving release remains `control-expiry-c9d8112d`.
Schema 190, execution v17, reply v3, guest 7, completion 3, preview 2 and Cube
management 7 are unchanged.

## Behavior

- A Control Plane-owned four-connection direct-PG pool bounds publication
  acquisition and checkout to five seconds each. It covers Outbox work, closure/
  control authorization, binding metadata and synchronous binding propagation.
  It uses the existing checkout eviction adapter and is independent of ordinary
  API/projection and expiry maintenance pools. Individual queries finish before
  Kafka/HTTP waits; no new queue or authority is introduced.
- A closing relay reports unavailable and starts no delivery for a late claim.
  Its immutable rows remain pending for the next claimant. After a partition
  ownership change, callers wait for the old request/writer to finish disposing,
  then retry under their own current ownership if necessary. Same-owner calls
  remain coalesced; three PG authorization reads and closed-evidence reuse remain.
- The Kafka reader stops new transaction admission and joins every outstanding
  group transaction before disposing its consumer, including external Session
  seal writers. Concurrent disconnect callers share one promise. Ownership is
  rechecked after the offsets callback; stale transactions do not request commit.
- A failed peer connection/body read invalidates only the address that request
  used. A late old request cannot erase a newer route. The unknown outcome still
  returns to the caller; existing Outbox retries rediscover and reuse the same
  Fact ID. There is no immediate blind resend or changed Tool replay behavior.

The measured local, no-binding seal remains six client SQL statements, including
three authority checks at distinct boundaries. That is not the SQL count for
whole recovery or for Sessions with active binding propagation.

## Verification

The first focused run passes 51 tests in ten files, including nine PG/HTTP
publication cases, two controlled reader-lifetime cases and startup pool cleanup.
Control Plane typecheck passes. The new tests cover bounded claim/authorization/
binding lock waits, late claim preservation, ownership coalescing and writer drain,
route rediscovery and a late old failure after a new route is cached. Existing
partition progress and producer/Projector guards remain covered.

Reader callback schedules use substituted native clients; no native crash
experiment is performed. Real RF3/PG and the remaining source/release gates are
tracked below rather than inferred from these tests.

- [ ] Broad source, fault and RF3 transport gates.
- [ ] Clean committed candidate, eleven artifact scans and drained matched release.
- [ ] Relevant native/recovery, browser/image, child, Control Plane and Cube acceptance.
- [ ] Confirmed physical fixture cleanup and original configuration fingerprints.

Original defect characterizations remain in Git at the review commit; maintained
regressions replace them. This work does not advance the reading checkpoint past
publication: Kafka → Projector closure/checkpoint/release is still the next hop.
