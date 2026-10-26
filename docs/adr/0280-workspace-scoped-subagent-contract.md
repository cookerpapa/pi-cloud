# ADR-0280: Workspace-scoped subagent parameters

Status: implemented in source on 2026-10-26; matched publication pending.

## Decision

Replace the model-facing subagent's flat `sandbox`, `cwd` and `tools` arguments
with one optional `workspace` object. Keep `task` and `context` as independent
collaboration parameters. Update direct delegation and the existing workflow
helpers together; do not retain old input aliases or rewrite historical native
Tool calls/results.

- Omitted workspace inherits the caller's existing workspace access.
- Null workspace disables workspace-dependent tools and compute, including
  ordinary Preview/image tools. Platform and provider-hosted tools retain their
  own availability rules.
- An object accepts `compute: shared | ephemeral` (default shared), an optional
  existing `cwd`, and an optional nonempty subset of the parent's
  read/write/edit/bash capabilities.
- Shared reuses parent Linux compute. Ephemeral uses independent lazy Linux
  compute on the same persistent Volume; it does not copy files or devices.
- Fresh/branch controls context only. Children currently receive no phone grant.

Resolve capabilities once for tool exposure, dispatch checks and child environment
text. Null/absent access must not be contradicted by a generic Linux/browser system
prompt, expanded through nested delegation, or silently replaced by another runtime.
Use Pi's public Tool/Conversation APIs; retain native child lifecycle and the single
physical-Session writer/lease.

The owner explicitly keeps device-use sequencing and sharing with Agents. This
change introduces no occupancy register, reservation Tool, device-use lock service
or device scheduler. Existing Session target binding and executor fencing remain
as specified in ADR-0279.

## Evidence and validation

[Upstream comparison](../research/subagent-resource-contracts-20261026.md) examines
OpenClaw, OpenHands, Deep Agents and Cua's separately licensed access module. Adopt
separation of context, workspace resources and device access; retain the existing
Pi harness and resource adapters.

Verify strict new parameter parsing, inherited grants, null workspace across fixed
and ordinary tools, same-Volume shared/ephemeral behavior, nested/recovered children,
catalog refresh, and real-model understanding in a phone-plus-workspace Session.
The change needs a matched Worker/Control Plane/guest publication after draining
native writers. Existing account/configuration, conversation and Workspace assets
remain intact.
