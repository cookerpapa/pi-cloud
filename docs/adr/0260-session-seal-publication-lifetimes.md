# ADR-0260: Bounded Session seal publication and transport retirement

Status: implemented in source, verification/delivery pending, 2026-10-19. The owner approved fixing
SP-01–03 in the [publication review](../reports/seal-publication-review-20261019.md).
Baseline: `f5bb08ed`. No schema, Kafka envelope, guest or public API change.

## Decision

Retain PG closure authority, immutable Outbox retry IDs, the stable per-Session
Kafka producer identity and all three closure authorization reads. Kafka ACK is
not PG closure or successor authorization. This is a bounded repair of existing
adapters, not a replacement scheduler, event store or recovery protocol.

1. Use ADR-0258/0259's existing node-postgres checkout adapter for short control
   publication operations. The Control Plane owns a dedicated direct-PG pool
   with four connections and five-second acquisition/checkout budgets. Outbox
   claim/receipt/cleanup, seal/control authorization, binding metadata and its
   synchronous propagation reads/writes share it. Native projection, general
   APIs and expiry maintenance retain their own pools/budgets. No PG connection
   spans Kafka/HTTP delivery. Eviction ends an expired SQL connection; a timeout
   must not leave its query running. Failure retains the Outbox/lease evidence.
2. Stop relay admission immediately on close, report closing as unavailable and
   join its bounded in-flight work. A claim that finishes after stop is left in
   Outbox for the next claimant, not dispatched by the retiring relay. Same-Fact
   pending work is still coalesced. A new local ownership generation waits for
   old work to settle, then rechecks its own current ownership on failure before
   trying again. Do not overlap producer initialization merely to bypass a wait.
3. `KafkaPartitionReader` owns the lifetime of every group transaction borrowing
   its native consumer, including transactions from external Session seal writers.
   Disconnect stops new admission, invalidates generation and joins those
   transactions before native disposal. Recheck generation after the awaited
   offsets callback before requesting commit. Concurrent disconnect callers join
   the same completion. Existing producer initialization does not borrow the
   reader; its later transaction admission still rejects a retired owner.
4. A transport failure evicts only the cached owner address used by that request,
   preserving any newer address installed concurrently. Return the original
   unknown outcome; the existing Outbox retry rediscovers the owner and resends
   the same Fact ID. Do not turn an unknown ACK into proof of non-delivery or add
   another immediate resend loop. Keep the existing HTTP request deadline.

## Adoption and scope

Reuse the pinned PG/Kafka adapters and the bounded checkout implementation already
adopted in [ADR-0258](0258-bounded-session-lease-renewal.md) and
[ADR-0259](0259-control-plane-expiry-progress.md), and the group transaction guard
from [ADR-0247](0247-session-work-and-tool-dispatch.md). Another queue, connection
registry or workflow engine would add competing state without addressing these
specific ownership/lifetime gaps. No new dependency or native library patch is
needed. Four pool slots bound concurrent metadata work independently of the
existing sixteen network publications; this is not a product/session quota.

Tests use isolated local infrastructure and controlled callbacks. Native crash
experiments or attack simulation are unnecessary. Normal native writer fencing,
closure replay and recovery remain required correctness checks for private
deployment. No change weakens Tool routing revocation or Session fencing.

## Acceptance

- Real PG lock/pool waits end within the configured test budget, release their
  connections, allow shutdown, and leave a retriable immutable Outbox request.
  Binding closure must also use bounded metadata access before a seal is sent.
- An old ownership generation cannot cause overlapping replacement initialization;
  after old work ends, the valid new owner retries successfully. Same-generation
  duplicates remain coalesced and closed evidence does not fence a successor.
- Reader retirement waits for pending offsets callbacks, rejects stale commit
  requests and remains idempotent. Other partition progress stays independent.
- A surviving forwarder recovers from a normally closed old peer on the next
  retry. Lost ACKs retain their original classification and Fact ID; a late old
  failure cannot delete a newer cached route.
- Maintain the six-statement no-binding seal baseline and the existing real
  RF3/PG direct-write/closure/recovery contracts.
- Pass required source/transport/fault checks and the maintained matched release
  with relevant native, browser/image, child, Control Plane replacement and Cube
  acceptance. Preserve accounts/configuration/credentials and confirm owned
  physical cleanup. Record source completion separately from delivery.
