# ADR-0151: separate machine, Tool and application failures

## Status

Accepted, 2026-09-06. Clarifies ADR-0120 and ADR-0150.

## Evidence

A read-only Tool failed after host restart. The provider collapsed its original
exception into an unknown-effect error, attempted to destroy a user-owned VM,
and removed its handle. The Broker retained the binding; subsequent Tools and
settlement repeatedly used that invalid handle. Failed settlement discarded
the reconnect capsule and a reaper treated the machine as an orphan. The final
cleanup error masked the original failure. Service readiness had checked only
the Cube control API, not the adopted Guest's execution path.

## Decision

- Keep Cube's native lifecycle/process interfaces. No new scheduler, resident
  guest controller, or competing storage authority is introduced.
- A persistent development machine is never destroyed because an Agent Tool,
  preview connection or Run settlement failed. Explicit authenticated release
  remains its destruction boundary. Elastic runtimes retain fail-closed cleanup.
- Distinguish a rejected/unavailable read or undispatched operation from a
  dispatched mutation with an unknown result. Preserve the original diagnostic
  as a bounded, redacted cause. Do not automatically repeat a mutation.
- Quarantine an unavailable machine/binding. Finish the current Run with its
  first infrastructure error after persisting the Tool result; do not ask the
  model to repair platform transport or keep calling a failed binding.
- Retain the physical identity and encrypted reconnect capsule when returning
  a failed binding. Reconcile the same machine after execution is reachable;
  do not silently create an empty replacement or let orphan cleanup delete it.
- Adoption and owned-machine admission verify actual Guest execution rather
  than interpreting every non-paused control-plane state as running. Paused
  machines stay paused. Runtime continuity is not inferred from a renewed lease.
- Temporary unavailability and an application port closing are not evidence of
  a reset. Model-visible reset facts require observed physical/execution
  continuity changes. Workspace survival claims remain scoped to durable bytes.
- Preview CONNECT succeeds only after the guest connection to the requested
  port succeeds. Propagate a bounded application-port vs execution-channel error
  through the existing CONNECT/Gateway path, without exposing native addresses
  or credentials. Closing a preview never terminates the application or VM.
- Host shutdown is not automatic pause/snapshot. Files on a persistent Volume
  survive independently; process/rootfs recovery requires an available native
  Cube snapshot/runtime. A stopped or missing runtime is recovery-required, not
  a successful restore. Do not reboot the user's host for acceptance.

## Acceptance

Test read failure, rejected mutation, ambiguous mutation, cancellation, malformed
guest results, persistent vs elastic lifetime, capsule retention/reconciliation,
first-error preservation, transient vs real continuity change, and refused app
ports. Exercise a disposable real Cube with a stopped/restarted web service and
Broker replacement, retain files and machine identity, and run real multi-round
coding afterward. Host-loss behavior must be covered by deterministic failure
injection; physical host/power-loss acceptance is a separate operator test.
