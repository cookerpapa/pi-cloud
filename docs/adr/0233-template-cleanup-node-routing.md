# ADR-0233: Resolve template cleanup by current node identity

Status: implemented, verified and deployed, 2026-10-07.
[Verification and cleanup evidence](../reports/template-cleanup-20261007.md).
The owner requested diagnosis and repair of repeated old-template cleanup timeouts.

## Evidence

The deployed CubeMaster gives a template replica/job's recorded `NodeIP` priority
and consults the current node registry only when that field is empty. The rootfs
artifact placement cleanup repeats that rule. After a Cubelet Pod is replaced,
its stable Cube node ID remains while its Pod address changes.

The failing historical template records `10.42.0.52`; the current template catalog
records `10.42.0.218`. The live registry identifies the same node at `10.42.0.6`.
TCP probes from CubeMaster cannot reach either recorded address and can reach the
registered address. The request's deadline therefore expires before it reaches
the physical cleanup endpoint. Deletion also deduplicates by `(NodeID, NodeIP)`,
allowing two historical addresses to create duplicate targets for the same node.

The pinned upstream implementation is CubeSandbox
`8721dd151971ce3c2966482bbd32904ad98f378e`, specifically
`CubeMaster/pkg/templatecenter/delete.go` and `artifact_lifecycle.go`.
Use Cube's existing node registry; no new discovery service, queue or lifecycle
owner is needed.

## Decision

- Template/snapshot replica cleanup and artifact placement deletion address the
  recorded stable Node ID through the current Cube node registry for each request.
  Recorded IPs remain historical metadata, never destructive routing authority.
- No registered matching node/address means unconfirmed cleanup. Preserve the
  target and metadata; do not infer physical absence or route to an old IP.
  An IP-only target lacks a usable physical identity and cannot authorize deletion.
- Deduplicate known cleanup targets by Node ID, including locators assembled from
  different replica and build-job observations. Target filtering also uses node
  identity, not address equality.
- Keep active-build/VM/snapshot pinning, shared-rootfs reference accounting,
  last-owner cleanup and physical-before-metadata ordering. Workspace Volumes,
  Session leases and historical UNKNOWN VM records are outside this cleanup.
- Keep the release helper's bounded auxiliary cleanup budget. It remains useful
  for a genuinely unavailable node; it is not the fix for obsolete addresses.

The public RPC and database schemas remain unchanged. This is a pinned upstream
repair of endpoint selection within the existing ownership contract.

## Acceptance

Reproduce old-address selection against the original source. Test current-address
routing, duplicate observations, reused IPs belonging to distinct nodes, missing
node identity/registration, RPC errors and cancellation. Confirm that failures
cannot advance metadata cleanup and rootfs placement remains pending when its node
cannot be resolved. Run upstream cleanup/reference tests and native allocation
contracts, then delete unused historical templates through Cube's normal API.
Current templates must remain READY and usable for real Luna/Tool execution.
