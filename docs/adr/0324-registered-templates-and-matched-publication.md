# ADR-0324: Registered templates during matched Guest publication

Date: 2026-11-13. Status: implemented and live-verified on 2026-11-14.

Live acceptance of #38/#39 exposed a publication gap: the operator updated its
native template file, while the registered primary backend retained the previous
template IDs. Resource management correctly used the registered directory, and
Guest revision verification correctly rejected the resulting old Guest.

## Decision

Keep the registered backend as runtime authority. The matched operator advances
the deployment-owned primary Cube `linux` template after native registration and
before resource controllers resume. This is an explicit cold administrative
mutation through the existing registry revision check, not a recurring bootstrap
overwrite. Preserve backend identity, labels, admission state, compute eligibility,
connection credentials, storage and Workspace bindings. Refuse foreign primary
endpoints and additional template definitions that require explicit coordination.
Validate new native template capacities; unchanged storage identity is retained
from the already verified cold maintenance boundary.

The owned BoxLite publication similarly advances its registered template revision
after updating the node and before restoring admission. Disabled backends remain
disabled. Alternate runtimes remain explicit and use the same fixed Guest contract.

A successful native creation receipt can exist before Guest validation succeeds.
Cold maintenance may close that **identified** Cube allocation using its original
encrypted receipt, immutable creation assignment and provider address. Confirm
native creation has settled in running/paused state before closing; a missing
inventory record needs positive retained deletion evidence. Validate every
identity before closing; retain the receipt through positive native deletion
evidence. Do not invent a final activation capsule to satisfy cleanup. Missing or
ambiguous creation evidence still blocks maintenance, and public pending-machine
cancel/release semantics do not change. Early BoxLite receipts without a complete
recorded deletion endpoint remain unsupported by this cold operator.

This changes no conversation, lease, provider API, storage-byte authority or
accounting ownership. No compatibility Guest path, new task table or weakened
revision verification is introduced.

## Acceptance

Cover registry field preservation, native capacity mismatch, revision conflicts,
foreign/custom backends, known early receipts, changed receipt identities, unknown
creates and deletion failures. Run the repaired cold publication, confirm both
original machines recover with the new Guest and retain their files, and verify
the explicit BoxLite publication before its live service-minute acceptance.

Delivery: [shared clients, local execution and service minutes](../reports/client-service-delivery-20261114.md).
