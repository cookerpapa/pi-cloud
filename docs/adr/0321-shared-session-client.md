# ADR-0321: Shared Session clients with cloud-owned execution

Date: 2026-11-13. Status: accepted; implementation in progress. Issue: #38.

The owner keeps the Pi Harness in trusted cloud Workers. A chat client and a
device executor are independent roles, even when one desktop application ships
both. Closing a client connection never implies Stop, writer retirement or
resource deletion. A device's loss affects its operations, not access to history.

## Session client

Extract the existing web transport, submission identity and Session reducer into
`@pi-cloud/session-client`. Reuse the public Session API and snapshot-first SSE;
do not create a protocol, Session consumer, event store or client-side Kafka
cursor. Authentication and fetch transport are supplied by the application.
Presentation, DOM/React, scrolling and platform-local draft storage remain with
the client application. The web application consumes the same implementation;
old source paths are removed rather than retained as compatibility exports.

The existing server subscribes before reading canonical PG history, merges the
uncovered live suffix and sends a snapshot before events. Reconnection replaces
that initial view; earlier history remains paginated. Disposable Tool/phase
observations retain HTTP/SSE semantics. An uncertain input retains its original
idempotency identity until reconciled; local sending feedback is not acceptance.

Existing PiCloud-owned schemas and the already-pinned JSON parser are sufficient
for this extraction. A new client framework would duplicate the current state
and recovery contracts. The package contains no Worker, Pi, Kafka, database,
provider SDK or device-execution code.

## Local execution boundary

The local execution slice extends the existing destination admission/HTTPS
completion boundary for an explicit Linux target. It requires a documented
outbound transport and verified platform/isolation contract before activation;
this client extraction does not itself enable local execution. No Windows/macOS
claim follows from sharing a TypeScript client. User-owned execution devices
remain outside managed VM expiry and compute billing. #39 records the separate
service accounting decision.

## Acceptance

Use the extracted code in the web application and an independent Node client.
Cover simultaneous readers, incomplete stream frames, snapshot reconnection,
canonical/live deduplication, bounded history, lost submission acknowledgements,
native queue edits/Stop and closing a client while work continues. Public APIs,
fencing and the sole Session writer remain unchanged.
