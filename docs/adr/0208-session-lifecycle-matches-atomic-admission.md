# ADR-0208: Session lifecycle matches atomic Run admission

Status: accepted, 2026-10-01 (September 30 review cleanup).

## Decision

The maintained Session states are `cold`, `idle`, `running`, `cancelling` and
`failed`. Run admission atomically moves a cold/idle logical Session to running
in the same PG transaction that records its Run and execution authority.
The domain transition graph must describe that actual behavior.

Remove unused Session `starting`, `evicting` and `recovering` states from the
public schema, PG constraint and consumers. There are no current production
writers for these persisted states. Recovery currently computes two pure
in-memory transitions but persists only `idle`; it now uses one `failed → idle`
transition after the same SQL guards prove Agent exit, native seal and no live
work. A state graph is not an authorization check: the recovery guards remain
mandatory. Model/Worker/VM lifecycle states remain independently owned.

No compatibility mapping or silent reset of legacy Session rows is added.
Migration 157 refuses the cutover if unsupported states exist. Investigate and
quiesce those rows before retrying; an old binary cannot share the new schema.
Public API, Web, Worker and Control Plane deploy together.

## Acceptance

Contract tests accept atomic cold/idle admission and reject retired public
states. Existing Run admission, cancellation, lease-loss, Agent-exit/seal and
quarantined recovery tests keep their behavioral guards. A real PostgreSQL
migration test proves rejection is atomic and ordinary states survive cutover.

This corrects the existing PG state model; no workflow engine, scheduler or
additional durable authority is introduced.
