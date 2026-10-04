# October 4 review repairs

Started 2026-10-05 from `c3f5f6bd`. The owner approved the repair proposal.
Implementation and validation are in progress; production has not yet changed.

## Lifecycle slice — ADR-0224

- R04-01: separate short observation deadlines from accepted Cube cleanup.
  Use the configured native destroy budget independently of caller cancellation;
  reserve outer transport time through Master, API and the PiCloud client.
  Recheck terminal state after the allocation lock. Cleanup never reopens creation.
- R04-02: prepare recovered bindings and durable state before publishing local
  availability. Storage/binding failure after successful adoption remains retryable
  without quarantining the verified VM. Contain health-target enumeration errors.

Validation so far: native allocation package with race detection; native
paused-delete/managed-cleanup service tests with CGO disabled (local static
cubecow library unavailable); controller, runtime client, monitor and recovery
tests. Native production build and live acceptance remain required.

Remaining slices: PG ownership/SSH time, shared model policy, structured Tool
failure envelope, Volume reference convergence, browser gate and measured cleanup.
